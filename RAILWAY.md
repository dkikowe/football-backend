# Railway API deployment

Deploy **this backend directory as the repository root**, with its Dockerfile. The
Unity dedicated match server is a separate UDP service. Railway public networking
supports HTTPS and TCP, so deploying the HTTP API alone does not make NGO/Unity
Transport matches reachable from the Internet. Run the existing Unity dedicated
binary on a host with a public UDP port and DTLS certificate/key.

## API service

Create one API service plus PostgreSQL and Redis in the same Railway environment.
Keep database services private, with persistent volumes/backups. Redis live-session
state needs AOF and a no-eviction policy. Start with one API replica and one region;
match server capacity is registered independently.

Configure the Dockerfile builder, `/health` readiness (120-second startup allowance)
and bounded failure restart. The API reads Railway's `PORT` and binds `0.0.0.0`.
Docker health checks use that same port. The container runs as `node`.
Do not override its command. Startup connects Redis and runs locked SQL migrations
before opening HTTP; no separate migration service or duplicate migration hook is
needed. `/health` verifies PostgreSQL and Redis on every request.

Current Railway documentation marks Config as Code deprecated for new services,
so no legacy `railway.json` is added. Set these exact options in the dashboard/CLI
and inspect the resolved deployment settings: Dockerfile build,
health check `/health`, timeout 120 seconds, restart `ON_FAILURE`, max 10 retries.

Set API variables via Railway's protected variable UI/CLI, never Git:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PUBLIC_API_URL` | Generated API domain with `https://` and no trailing slash |
| `DATABASE_URL` | Reference to PostgreSQL's private `DATABASE_URL` |
| `REDIS_URL` | Reference to Redis's private `REDIS_URL` |
| `REDIS_PREFIX` | Unique environment namespace, e.g. `football:production:` |
| `GAME_SERVER_SECRET` | Random 32+ byte secret shared only with dedicated servers |
| `REGIONS_JSON` | Array of `{ "id": "eu", "probeUrl": "https://API_DOMAIN/v1/ping?region=eu" }`; region ID must match `GAME_REGION` on the actual dedicated fleet |
| `TRUSTED_PROXY_CIDRS` | Only explicitly verified direct Railway proxy IPs/CIDRs; see below |

Railway assigns `PORT`; no fixed override is necessary. Do not expose database TCP
proxies for routine service communication or disable TLS certificate validation.
Generate a fresh production server secret; never upload local `.env` credentials.
Public transport trust may require `TRANSPORT_CA_CERTIFICATE_FILE` and
`TRANSPORT_SERVER_NAME`. The backend reads the **public** CA certificate from that
file; keep the dedicated server's private key exclusively on its host.

## Forwarded client IP and rate limits

Railway documents `X-Real-IP` as the original client address. This API accepts that
single, validated IP only if the direct socket peer matches `TRUSTED_PROXY_CIDRS`.
It ignores `X-Forwarded-For`, malformed/list-valued addresses and headers arriving
from other peers. An empty list preserves the conservative socket-IP limit.

On Railway the first request with an untrusted proxy produces one
`untrusted_proxy_peer` log with the socket address only. Verify it against the
deployment network, then configure its narrow IP/CIDR. Do not trust `0.0.0.0/0`,
`::/0`, arbitrary private networks or a caller-supplied proxy header. No direct
public TCP bypass should expose the API container. Keep other services in this
environment trusted. Recheck the peer after moving regions or changing ingress.

Internal routes require a server bearer credential; client session tokens are
never sufficient. Where available, additionally restrict `/internal/*` at the
edge to the dedicated fleet's egress addresses. HTTPS API requests do not contain
authoritative player transforms or client-reported scores.

## Read-only deployed probe

```bash
npm run smoke:deployed -- https://your-api.up.railway.app
```

This performs GETs only: dependency health, every configured region ping, and
unauthenticated rejection at profile/history/internal metrics routes. It does not
create accounts, queue matches, write results or change currency. The API's normal
short-lived request-rate counters are the only expected writes. It fails on HTTP
redirects, non-HTTPS public URLs, missing no-store/nosniff or broken dependencies.
It does **not** claim multiplayer success. The real match acceptance requires a
public UDP server plus two clients, allocation, simultaneous authoritative
snapshots, disconnect/reconnect and committed match results.

For Unity clients set `FOOTBALL_API_URL` to this HTTPS origin. On the dedicated host
set `BACKEND_URL` to the same origin and configure `GAME_SERVER_SECRET`,
`GAME_REGION`, unique `GAME_SERVER_ID`, public `GAME_PUBLIC_ADDRESS`, `GAME_PORT`,
`GAME_LISTEN_ADDRESS=0.0.0.0`, `GAME_TLS_CERT`, `GAME_TLS_KEY` and the existing
supervisor. A single-local-API probe measures API reachability, not global UDP
regional latency; do not advertise regions without real server capacity/probes.

Official references: [health checks](https://docs.railway.com/deployments/healthchecks),
[public networking](https://docs.railway.com/networking/public-networking/specs-and-limits),
[private networking](https://docs.railway.com/networking/private-networking),
[Config as Code](https://docs.railway.com/config-as-code/reference).
