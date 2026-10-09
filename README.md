# Football online backend and dedicated server

This is the implemented local multiplayer MVP backend: NestJS/TypeScript, PostgreSQL persistent accounts/social/results, Redis sessions/presence/queues/reservations. Unity Netcode for GameObjects + Unity Transport runs authoritative gameplay in a separate headless Unity process. Node does not simulate football physics. Offline Training and local saves remain separate.

See [CONTRACT.md](CONTRACT.md) for exact Unity-compatible JSON/routes and [TESTING.md](TESTING.md) for tested scope. No paid service, SaaS SDK account or production credential is required locally.

## Deployed instance

- API: [Railway HTTPS health](https://api-production-faa76.up.railway.app/health), deployed automatically from this repository main branch, with private PostgreSQL and Redis.
- Authoritative Unity Linux server: `167.172.156.89:7777/UDP`, DTLS, region `us-east` (nyc1).
- **Public match PASS, 2026-10-09:** two real Mac clients + four bots, score 3-2, same-slot reconnect, AI takeover and persisted results for both accounts. [Redacted report](test-results/public-railway-vps-smoke.json).
- One simultaneous match on the supplied 458 MiB / 1 vCPU VPS. Mean tested application RTT 256 ms; production load, mobile devices and six public clients remain unverified.

See [Railway deployment](RAILWAY.md) and [VPS service/DTLS operation](deploy/README.md). The API and Unity simulation are separate services. Existing nginx port 80 remains independent.

## Local API with installed PostgreSQL and Redis

Prerequisites: Node 22.9+, PostgreSQL 14+, Redis 7+. These services must listen only on trusted local/private interfaces. On this workstation PostgreSQL 18 and Redis 8 were already available; the scripts do not alter those service configurations.

```bash
cd backend
npm ci
npm run local:init
npm run build
npm start
```

`local:init` creates only `football_online_dev` and a private mode0600 `.env.local`, preserving an existing file. Secrets are random and are not printed. `LOCAL_ADMIN_DATABASE_URL` can select another local PostgreSQL administrative connection for initialization. Default API is `http://127.0.0.1:3000`; `/health` verifies both databases. Startup runs numbered SQL migrations with a PostgreSQL advisory lock. `npm run migrate` is available for an explicit deployment migration step.

API restart preserves accounts/results in PostgreSQL and active sessions in Redis. For durable Redis process restart use AOF (`appendonly yes`); Compose enables it. Refresh tokens rotate with a 60-second retry grace for a lost response. Dedicated join approval uses an idempotent attempt UUID, and disconnect cleanup is bound to that connection generation. Keep the guest refresh token in platform secure storage for public production clients; the current Unity MVP persistence must be reviewed before shipping on mobile.

## Docker Compose alternative

```bash
cd backend
# Create a private env file without requiring a running local PostgreSQL:
(umask 077; printf 'GAME_SERVER_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env.compose)
docker compose --env-file .env.compose up --build -d
curl http://127.0.0.1:3000/health
```

PostgreSQL and Redis are not published outside Compose. API binds localhost by default. Never commit `.env.local`, `.env.compose`, server keys, join tickets or refresh tokens. Docker is not installed on the validation workstation, so container execution has **not** been tested there; the equivalent Node/PostgreSQL/Redis application has been tested directly.

## Dedicated Unity process

Build the existing project with its online build entry point; the same gameplay scene/scripts support offline, dedicated and remote-client execution. The local macOS executable is `Builds/Online/Football.app/Contents/MacOS/Arcade Football`. A Linux dedicated build needs the matching Unity Linux Dedicated Server build-support module.

```bash
cd backend
set -a
source .env.local
set +a
export BACKEND_URL=http://127.0.0.1:3000
export GAME_SERVER_ID=local-server-1
export GAME_REGION=local
export GAME_PUBLIC_ADDRESS=127.0.0.1
export GAME_LISTEN_ADDRESS=127.0.0.1
export GAME_PORT=7777
/path/to/Football -batchmode -nographics -football-server -game-port 7777 -logFile /tmp/football-server.log
```

The process registers and heartbeats. Backend allocates only an IDLE, live, same-region process. A process owns one match. After posting trusted final results, it exits; the supervisor below starts a fresh IDLE process. If a process crashes or stops heartbeating, the backend marks the match FAILED, removes active reservations and awards no fabricated win. Queues time out if capacity is unavailable. API restart gives live servers one heartbeat-timeout interval to re-establish contact; replayed final results reconcile committed SQL state before cleaning Redis. An already FAILED match remains failed. A shutdown call handles graceful exits; timeout handles crashes.

```bash
export UNITY_SERVER_BINARY=/absolute/path/to/Football
export FLEET_SIZE=2
bash scripts/run-fleet.sh
```

The supervisor assigns ports 7777..7778 and unique server IDs. Logs are under ignored `.local/fleet`. `GAME_PORT` changes the base port. It retries the health check when API is down and restarts exited processes with a short backoff. Stop with Ctrl+C/SIGTERM; children receive SIGTERM.

Environment used by Unity: `BACKEND_URL`, `GAME_SERVER_SECRET`, `GAME_SERVER_ID`, `GAME_REGION`, `GAME_PUBLIC_ADDRESS`, `GAME_LISTEN_ADDRESS`, `GAME_PORT`. Public binds require Unity's DTLS certificate/key configuration (`GAME_TLS_CERT`, `GAME_TLS_KEY`). For public clients set backend `TRANSPORT_CA_CERTIFICATE` (multiline public PEM, preferred) or `TRANSPORT_CA_CERTIFICATE_FILE`, together with `TRANSPORT_SERVER_NAME`; allocation advertises only public trust material, never a private key. Both may remain blank for local loopback development or API provisioning before fleet registration.

## Real local multiplayer smoke

Stop other idle local game servers before running, so the test owns the allocation. API must already be running.

```bash
cd backend
node --env-file=.env.local scripts/multiplayer-smoke.mjs \
  "../Builds/Online/Football.app/Contents/MacOS/Arcade Football"
# A second run with the local UDP impairment proxy:
node --env-file=.env.local scripts/multiplayer-smoke.mjs \
  "../Builds/Online/Football.app/Contents/MacOS/Arcade Football" --chaos
```

The script launches a real dedicated process and two independent clients, allocates a private match with four server bots, kills one client, reconnects the original account/slot, waits for committed results and compares account scores. Client test drive submits normal movement/action input; it does not submit trusted goals. Join files use mode0600 and are deleted in `finally`. Redacted reports and Unity logs are kept in `.local/multiplayer-smoke-*`. Logs/reports are evidence only after a run completes; script availability alone is not a pass claim.

## Automated backend tests

```bash
npm test
```

Tests create a uniquely named PostgreSQL database and Redis prefix, exercise real HTTP transactions, and remove only those test resources. Override `TEST_ADMIN_DATABASE_URL` or `TEST_REDIS_URL` if needed. Tests deliberately configure a 2-second reconnect window to exercise expiry quickly; shipped default is 90 seconds. They cover six humans, party team preservation, 2+4/1+5 human/bot rosters, ticket reuse/ownership, reconnect expiry/voluntary leave, forged writes, result idempotence, bounded queues, dead server and persistence across API restart.

## Linux deployment and operational limits

1. Build Linux dedicated player with the same Unity version and assets; validate on the destination CPU/runtime before rollout.
2. Run PostgreSQL and Redis on a private network with backups, restricted identities, TLS/auth where applicable, Redis AOF and memory/eviction policy appropriate for live sessions. Never expose either service directly to the Internet.
3. Put API behind HTTPS reverse proxy and configure `PUBLIC_API_URL`; set `NODE_ENV=production`. Restrict `/internal/*` at the private network/reverse proxy as well as the bearer credential. Use a secret manager or protected environment file; rotate secrets during a drained deployment.
4. Provision DTLS certificate/key for public Unity UDP listeners. Open only assigned UDP game ports, HTTPS, and tightly restricted administration. Set public address/region correctly. Configure each region's real probe URL in `REGIONS_JSON`; the default single-local-region measurement is not global matchmaking.
5. Run one Unity process per allocated match under systemd/container supervisor. API is independently restartable. Drain dedicated capacity before deploys; do not replace an in-progress authoritative process expecting client state to restore it.
6. Observe JSON lifecycle logs and authenticated `/internal/metrics`. Alert on FAILED matches, no available capacity, high RTT/loss/reconciliation, database failures and rejected result writes. Unity process logs are separate.
7. Add real player account binding/recovery, platform secure credential storage, abuse controls, retention/deletion policies, backups/restore drills and credential rotation before public launch. Guests are secure random sessions but do not supply email/account recovery.

Resource/cost planning is based on measured concurrent matches, **not** concurrent connected clients alone. Each dedicated Unity process consumes scene memory and CPU for six actors at 30 Hz. Profile peak RSS and tick time on the Linux target; reserve headroom rather than packing to average usage. Monthly cost is API/database/Redis base capacity + dedicated-process hours + network egress + backups/monitoring. There is no mandatory paid middleware fee in this stack. A local smoke does not establish production concurrency, regional coverage, DDoS resistance, mobile battery usage or a hosting price; load-test and obtain current provider quotes before setting a budget.
