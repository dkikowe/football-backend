import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
process.env.DATABASE_URL='postgresql://unused@127.0.0.1:5432/unused';process.env.GAME_SERVER_SECRET='x'.repeat(64);
const {verifyAppleIdentity}=await import('../dist/apple.js');
test('Apple identity requires valid signature, app audience, expiry and exact challenge nonce',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='fixture';
 const keys=createLocalJWKSet({keys:[jwk]});
 const sign=(aud='com.krutyev.arcadefootball',nonce='challenge',expiry='5m')=>new SignJWT({nonce}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://appleid.apple.com').setAudience(aud).setSubject('apple-test-user').setIssuedAt().setExpirationTime(expiry).sign(privateKey);
 assert.equal(await verifyAppleIdentity(await sign(),'challenge',keys),'apple-test-user');
 await assert.rejects(verifyAppleIdentity(await sign('other-app'),'challenge',keys));
 await assert.rejects(verifyAppleIdentity(await sign(),'other-nonce',keys));
 await assert.rejects(verifyAppleIdentity(await sign(undefined,undefined,'-1s'),'challenge',keys));
 const token=await sign(),parts=token.split('.');parts[1]=Buffer.from(JSON.stringify({sub:'attacker',nonce:'challenge',aud:'com.krutyev.arcadefootball',iss:'https://appleid.apple.com',exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
 await assert.rejects(verifyAppleIdentity(parts.join('.'),'challenge',keys));
});
