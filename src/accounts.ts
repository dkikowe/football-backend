import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { AuthService } from './auth';
import { db, transaction, redis, key } from './db';
import { fail, hash, token } from './common';
import { initializeInventory } from './economy';
import { randomUUID } from 'node:crypto';
import { config } from './config';

let hashing=0;
export function passwordHash(password:string, salt=randomBytes(16).toString('hex')):Promise<string>{
 if(hashing>=4)fail(429,'TRY_LATER','Sign-in service is busy. Retry shortly.');
 hashing++;
 return new Promise((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024},(err,key)=>{hashing--;err?reject(err):resolve(`scrypt1:${salt}:${key.toString('hex')}`);}));
}
async function matches(password:string, encoded:string){
 const parts=encoded.split(':');
 const actual=await passwordHash(password,parts[1]);
 return actual.length===encoded.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(encoded));
}
export async function limitIdentity(subject:string){
 const k=key('identity-attempt:'+hash(subject)+':'+Math.floor(Date.now()/600000));
 const n=await redis.incr(k);if(n===1)await redis.expire(k,605);
 if(n>12)fail(429,'TRY_LATER','Too many attempts. Try again in 10 minutes.');
}
export async function attachIdentity(auth:AuthService, provider:string,subject:string,password:string|null,guestId?:string,appleCipher?:string){
 const pid=await transaction(async c=>{
  // Identity and guest linking races serialize in PostgreSQL, across API replicas.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[provider+':'+subject]);
  const existing=(await c.query('SELECT player_id FROM account_identities WHERE provider=$1 AND subject=$2',[provider,subject])).rows[0];
  if(existing){if(provider==='email')fail(409,'ACCOUNT_EXISTS','An account already uses this email. Sign in.');
   if(appleCipher)await c.query('UPDATE account_identities SET apple_refresh_cipher=$3 WHERE provider=$1 AND subject=$2',[provider,subject,appleCipher]);
   return existing.player_id as string;
  }
  let playerId=guestId;
  if(playerId){
   await c.query('SELECT id FROM players WHERE id=$1 FOR UPDATE',[playerId]);
   if((await c.query('SELECT 1 FROM account_identities WHERE player_id=$1',[playerId])).rowCount)
     fail(409,'ALREADY_LINKED','Sign out before creating another account.');
  }else{
   playerId=randomUUID();
   await c.query("INSERT INTO players(id,nickname,character_id) VALUES($1,'PLAYER','kai')",[playerId]);
   for(const table of ['player_stats','ratings','balances'])await c.query(`INSERT INTO ${table}(player_id) VALUES($1)`,[playerId]);
   await initializeInventory(c,playerId);
  }
  await c.query('INSERT INTO account_identities(provider,subject,player_id,password_hash,apple_refresh_cipher) VALUES($1,$2,$3,$4,$5)',[provider,subject,playerId,password,appleCipher??null]);
  return playerId;
 });
 return issueSession(auth,pid);
}
export async function issueSession(auth:AuthService,pid:string){
 const refreshToken=token();
 await db.query("INSERT INTO guest_refresh(token_hash,player_id,expires_at) VALUES($1,$2,now()+$3::int*interval '1 day')",[hash(refreshToken),pid,config.REFRESH_TOKEN_DAYS]);
 return auth.session(pid,refreshToken);
}
export async function emailLogin(auth:AuthService,email:string,password:string){
 await limitIdentity(email);
 const r=(await db.query("SELECT player_id,password_hash FROM account_identities WHERE provider='email' AND subject=$1",[email])).rows[0];
 // A missing email still pays the same scrypt cost. Never reveal which half was wrong.
 const dummy='scrypt1:00000000000000000000000000000000:'+ '0'.repeat(128);
 const valid=await matches(password,r?.password_hash??dummy);
 if(!r||!valid)fail(401,'INVALID_CREDENTIALS','Email or password is incorrect.');
 return issueSession(auth,r.player_id);
}
