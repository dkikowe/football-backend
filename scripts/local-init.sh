#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env.local ]]; then
  echo '.env.local already exists; preserving its credentials.'
  exit 0
fi
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import pg from 'pg';
const username=userInfo().username;
const adminUrl=process.env.LOCAL_ADMIN_DATABASE_URL||`postgresql://${encodeURIComponent(username)}@127.0.0.1:5432/postgres`;
const pool=new pg.Pool({connectionString:adminUrl});
const name='football_online_dev';
if(!(await pool.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await pool.query(`CREATE DATABASE "${name}"`);
await pool.end();
const url=new URL(adminUrl);url.pathname='/'+name;
const env={NODE_ENV:'development',PORT:'3000',PUBLIC_API_URL:'http://127.0.0.1:3000',DATABASE_URL:url.toString(),REDIS_URL:'redis://127.0.0.1:6379',REDIS_PREFIX:'football:local:',GAME_SERVER_SECRET:randomBytes(32).toString('hex'),POSTGRES_PASSWORD:randomBytes(24).toString('hex'),BOT_FILL_SECONDS:'12',QUEUE_TIMEOUT_SECONDS:'60',SERVER_TIMEOUT_SECONDS:'18',MATCH_TIMEOUT_SECONDS:'900',RECONNECT_SECONDS:'90',JOIN_TICKET_SECONDS:'60',FOOTBALL_API_URL:'http://127.0.0.1:3000',BACKEND_URL:'http://127.0.0.1:3000',GAME_REGION:'local',GAME_PUBLIC_ADDRESS:'127.0.0.1',GAME_LISTEN_ADDRESS:'127.0.0.1',GAME_PORT:'7777'};
writeFileSync('.env.local',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
console.log('Created isolated football_online_dev database and private .env.local. Credentials were not printed.');
NODE
