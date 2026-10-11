import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { redis,key,db } from './db';
import { token,fail,hash } from './common';
const jwks=createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const audience=process.env.APPLE_CLIENT_ID||'com.krutyev.arcadefootball';
export const appleConfigured=()=>!!(process.env.APPLE_PRIVATE_KEY&&process.env.APPLE_KEY_ID&&process.env.APPLE_TEAM_ID&&process.env.ACCOUNT_ENCRYPTION_KEY);
export async function appleChallenge(guestId?:string){
 if(!appleConfigured())fail(503,'APPLE_UNAVAILABLE','Apple sign-in is not configured yet. Use email or guest.');
 const challenge=token(),nonce=token();
 await redis.set(key('apple-challenge:'+hash(challenge)),JSON.stringify({nonce,guestId}),{EX:300});
 return {challenge,nonce};
}
async function clientSecret(){
 const privateKey=await importPKCS8(process.env.APPLE_PRIVATE_KEY!.replace(/\\n/g,'\n'),'ES256');
 return new SignJWT({}).setProtectedHeader({alg:'ES256',kid:process.env.APPLE_KEY_ID!})
  .setIssuer(process.env.APPLE_TEAM_ID!).setSubject(audience).setAudience('https://appleid.apple.com')
  .setIssuedAt().setExpirationTime('5m').sign(privateKey);
}
function encrypt(value:string){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(process.env.ACCOUNT_ENCRYPTION_KEY!,'hex'),iv);
 const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}
function decrypt(value:string){
 const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',Buffer.from(process.env.ACCOUNT_ENCRYPTION_KEY!,'hex'),data.subarray(0,12));
 cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
}
export async function verifyAppleIdentity(identityToken:string,nonce:string,keys:Parameters<typeof jwtVerify>[1]=jwks){
 const {payload}=await jwtVerify(identityToken,keys as any,{issuer:'https://appleid.apple.com',audience,algorithms:['RS256']});
 if(payload.nonce!==nonce||!payload.sub||!payload.exp)throw new Error('Invalid Apple claims');
 return payload.sub;
}
export async function verifyApple(challenge:string,identityToken:string,authorizationCode:string,requestPlayerId?:string){
 if(!appleConfigured())fail(503,'APPLE_UNAVAILABLE','Apple sign-in unavailable.');
 const raw=await redis.getDel(key('apple-challenge:'+hash(challenge)));
 if(!raw)fail(401,'APPLE_EXPIRED','Apple sign-in expired. Retry.');
 const state=JSON.parse(raw);
 if(state.guestId!==requestPlayerId)fail(401,'APPLE_INVALID','Sign-in session changed. Retry.');
 let subject:string;
 try{
  subject=await verifyAppleIdentity(identityToken,state.nonce);
 }catch{fail(401,'APPLE_INVALID','Apple identity could not be verified. Retry.');}
 const response=await fetch('https://appleid.apple.com/auth/token',{method:'POST',signal:AbortSignal.timeout(10000),
  headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:audience,client_secret:await clientSecret(),code:authorizationCode,grant_type:'authorization_code'})});
 const result=await response.json() as any;
 if(!response.ok||!result.refresh_token||!result.id_token)fail(401,'APPLE_INVALID','Apple authorization expired. Retry.');
 try{
  if(await verifyAppleIdentity(result.id_token,state.nonce)!==subject!)throw new Error();
 }catch{fail(401,'APPLE_INVALID','Apple authorization mismatch. Retry.');}
 return {subject:subject!,guestId:state.guestId as string|undefined,cipher:encrypt(result.refresh_token)};
}
export async function revokeApple(playerId:string){
 const row=(await db.query("SELECT apple_refresh_cipher FROM account_identities WHERE player_id=$1 AND provider='apple'",[playerId])).rows[0];
 if(!row?.apple_refresh_cipher)return;
 if(!appleConfigured())fail(503,'APPLE_UNAVAILABLE','Apple revocation unavailable. Retry later.');
 const response=await fetch('https://appleid.apple.com/auth/revoke',{method:'POST',signal:AbortSignal.timeout(10000),
  headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:audience,client_secret:await clientSecret(),token:decrypt(row.apple_refresh_cipher),token_type_hint:'refresh_token'})});
 if(!response.ok)fail(503,'APPLE_UNAVAILABLE','Apple revocation unavailable. Retry later.');
}
