# Local acceptance plan

Backend tests use a dedicated PostgreSQL database and a unique Redis key prefix. They never flush Redis, alter existing application databases, or use production credentials. API tests exercise real HTTP, SQL transactions and Redis TTL/atomic ticket operations; Unity transport/gameplay acceptance is a separate root-project smoke test.

Implemented automated checks (real services):

1. Guest account, persistent refresh, profile validation, presence and measured ping endpoints.
2. Friend request/accept/decline, party invitation and max-three membership, leader authorization.
3. Quick queue bounded wait, six-slot authoritative allocation, party team preservation and cancellation.
4. Private room code join/leader-only start, registered-server capacity and assignment heartbeat.
5. Join tickets single use, duplicate live slot rejection, reconnect identity+slot reservation, voluntary leave forbids reconnect.
6. Multiple disconnected players keep independent reservations; deadlines do not extend on repeated disconnect.
7. Client cannot submit trusted goals/results; invalid server secret and mismatched allocation are rejected.
8. Trusted results update stats/rating/balances transactionally once; conflicting duplicate rejected.
9. Queue capacity timeout and dead-server expiry produce finite failure states.
10. Backend restart retains PostgreSQL profile/history, Redis queue/session state and refresh identity.

2026-10-09: `npm test` passed 18/18 (14 named integration scenarios, their parent suite and three trusted-proxy unit tests), against PostgreSQL 18.6 and Redis 8.4. Test databases and prefixed Redis data were removed afterward. TypeScript strict compilation passed. Docker runtime and Unity transport acceptance are separate; do not infer their status from the API suite.

Railway preparation: trusted-proxy tests cover untrusted forged headers, explicit CIDR matching including IPv4-mapped sockets, IPv6 normalization, malformed/list headers and invalid wildcard configuration. The read-only deployed API probe passed six checks against the existing loopback API; this establishes script behavior, not a public Railway deployment or UDP match pass. Docker healthcheck now follows `PORT`.

Additional fault regressions passed: injected PostgreSQL error during approval leaves ticket usable; repeated approval attempt returns the same receipt after a simulated lost response; abort by generation needs no returned playerId; delayed old disconnect cannot take over a new connection; SQL committed result repairs stale Redis before server-failure cleanup; API outage/restart grace allows authoritative immutable result replay.

Real Unity smoke evidence: `test-results/clean-smoke.json` and `test-results/chaos-smoke.json`. Both completed separate dedicated+two-client matches, sudden process disconnect, same-slot reconnect, six actor slots, authoritative snapshot agreement and durable results. The final 30 Hz chaos run configured 75ms one-way delay with ±20ms jitter and 3% loss, observed mean application RTT 214ms and committed score 2-0; exact quality remains device/network dependent. The earlier 60 Hz run observed 186ms. The initial failed NetworkManager-nesting run is preserved under `.local` and was followed by the fixed successful runs.

`test-results/resilience-smoke.json` records the final six-client run: median 30 ticks/s and 15 snapshots/s for every client, two simultaneous process deaths and two live-client UDP route losses, all four reconnecting to their original slots, one shared MVP, 335 matching timed snapshot pairs (109 exact ticks), and rejection of real forged GOAL/state/result messages. The earlier run interrupted by macOS clamshell sleep is retained separately and is not counted as a pass.

Final security regression: rotating bogus Authorization headers cannot bypass guest rate limits; the API applies a separate IP ceiling while valid client sessions retain separate budgets behind a shared network. Backend service was restarted with the verified build and `/health` returned PostgreSQL/Redis healthy. Full six-client resilience evidence is tracked separately in the root online multiplayer report; do not infer that pass from the two-client reports here.
