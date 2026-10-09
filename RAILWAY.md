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
| `TRANSPORT_CA_CERTIFICATE` | Complete multiline public trust certificate PEM, stored as a protected variable before registering a public fleet |
| `TRANSPORT_SERVER_NAME` | DNS identity expected by clients in the dedicated server's DTLS certificate |

Railway assigns `PORT`; no fixed override is necessary. Do not expose database TCP
proxies for routine service communication or disable TLS certificate validation.
Generate a fresh production server secret; never upload local `.env` credentials.
Public Unity transport requires DTLS: configure the dedicated server certificate
and private key, plus backend `TRANSPORT_CA_CERTIFICATE` and
`TRANSPORT_SERVER_NAME` so clients receive the expected trust certificate and
identity. Paste the actual multiline **public** PEM into the protected variable,
without literal backslash-n escapes. A nonempty environment PEM takes precedence
over the alternative `TRANSPORT_CA_CERTIFICATE_FILE` mounted-file setting. Startup
parses X.509 and rejects malformed PEM, extra certificates or any private key.
In production certificate and server name must be set together. Both may remain
blank while provisioning the HTTP API before fleet registration. Keep the
dedicated server's private key exclusively on its host.

## Forwarded client IP and rate limits

Railway documents `X-Real-IP` as the original client address. This API accepts that
single, validated IP only if the direct socket peer matches `TRUSTED_PROXY_CIDRS`.
It ignores `X-Forwarded-For`, malformed/list-valued addresses and headers arriving
from other peers. An empty list preserves the conservative socket-IP limit.

On Railway the first request other than `/health` produces one
`proxy_peer_observed` log with the socket address and booleans indicating whether
`X-Real-IP`/`X-Forwarded-For` are present; no header values are logged. Verify it against the
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
For a public API all advertised probes must use HTTPS and a non-loopback address;
a locally running API cannot mask a loopback region configuration. The probe does
**not** claim multiplayer success. The real match acceptance requires a
public UDP server plus two clients, allocation, simultaneous authoritative
snapshots, disconnect/reconnect and committed match results.

For Unity clients set `FOOTBALL_API_URL` to this HTTPS origin. On the dedicated host
set `BACKEND_URL` to the same origin and configure `GAME_SERVER_SECRET`,
`GAME_REGION`, unique `GAME_SERVER_ID`, public `GAME_PUBLIC_ADDRESS`, `GAME_PORT`,
`GAME_LISTEN_ADDRESS=0.0.0.0`, `GAME_TLS_CERT`, `GAME_TLS_KEY` and the existing
supervisor. A single-local-API probe measures API reachability, not global UDP
regional latency; do not advertise regions without real server capacity/probes.

## Authenticated deployment and restart smoke

Run this explicitly against a fresh deployment before registering dedicated fleet
capacity. It creates exactly two disposable `DeployTest...` guest accounts and
uses only their normal client API credentials. It never submits results, grants
currency or uses the dedicated server secret.

```bash
node scripts/deployed-session-smoke.mjs https://your-api.up.railway.app before
# Restart/redeploy the API service; wait for /health to become healthy.
node scripts/deployed-session-smoke.mjs https://your-api.up.railway.app after
```

The first phase checks profile selection, guest refresh, client-token denial at
the internal API, friend request/acceptance, party invitation/acceptance/removal,
private room join/leave, and a search that remains unallocated then cancels. It
leaves only the accepted friendship and private `.local/deployed-session-smoke.json`
(mode `0600`) for the restart check. The second phase refreshes the same accounts,
verifies saved profiles/friendship, removes the friendship and deletes the private
state file. It also verifies these guests still have zero match stats/rewards.

Public output contains assertion names/booleans, never credentials. A third
`cleanup` phase can remove owned transient resources and the saved state after an
interrupted test. An optional final argument selects another state filename
directly inside `.local`. There is no account-deletion endpoint, so the two named
disposable guest profiles remain without history or rewards. This is substantive
HTTP/session acceptance, **not** evidence of a real UDP multiplayer match.

Official references: [health checks](https://docs.railway.com/deployments/healthchecks),
[public networking](https://docs.railway.com/networking/public-networking/specs-and-limits),
[private networking](https://docs.railway.com/networking/private-networking),
[Config as Code](https://docs.railway.com/config-as-code/reference).
