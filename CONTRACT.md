# Football online API contract (v1)

Base URL: `http://127.0.0.1:3000` for local development. HTTPS is required outside localhost. All JSON uses the exact lowerCamelCase field names below. No top-level arrays or dictionaries are required. Optional strings are empty (`""`), optional arrays are empty. Times named `...Utc` use ISO8601 UTC. Team `0` is blue, `1` red; slots `0,1,2` blue and `3,4,5` red. Character IDs: `kai`, `leo`, `ryan`, `max`, `bruno`, `diego`.

Client authenticated routes use `Authorization: Bearer <accessToken>`. Tokens are opaque secrets, not player IDs. Do not send local coins, XP, rating, scores, or positions to these APIs. Server routes require `Authorization: Bearer <GAME_SERVER_SECRET>` from the dedicated process environment, never a client build. The additional per-allocation `matchSecret` prevents a stale server allocation being reused.

Every error: `{ "statusCode": 409, "code": "PARTY_FULL", "message": "Party already has three members." }`. General codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `SERVICE_UNAVAILABLE` (503). Domain conflicts may have more specific codes. Clients must present `message` and support retry/back. Network failure must not discard the guest account or create another guest. Refresh tokens should only be discarded on explicit 401/403.

## Shared DTOs

```text
PlayerSummary { playerId:string, nickname:string, characterId:string,
                rank:string, rating:int, status:string }
// status ONLINE | IN_MATCH | OFFLINE

RosterSlot { slot:int, team:int, playerId:string, nickname:string,
             characterId:string, isBot:bool }
// Empty playerId denotes a permanent filler bot.

Allocation { queueId:string, state:string, waitSeconds:int,
             matchId:string, address:string, port:int, region:string,
             joinTicket:string, reconnectToken:string, slots:RosterSlot[] }
// States SEARCHING | STARTING | CONNECTING | IN_MATCH | FAILED | CANCELLED.
// Address/port and credentials only populated after actual dedicated allocation.
// joinTicket is a short-lived single-use credential scoped to player+match+slot.
// Polling repeats an unconsumed ticket, rather than replacing it every poll.
// A consumed ticket is not silently replaced; use authenticated reconnect flow.

Party { partyId:string, leaderId:string, members:PlayerSummary[],
        invites:PartyInvite[] }
PartyInvite { partyId:string, leaderId:string, nickname:string }
// No current party: empty partyId/leaderId/members; invites can still exist.

Room { code:string, leaderId:string, region:string, state:string,
       members:PlayerSummary[], matchId:string }
// READY before launch; STARTING while allocating; CONNECTING on assignment.

ParticipantResult { playerId:string, slot:int, goals:int, assists:int,
                    shots:int, passes:int, tackles:int, possessionSeconds:float,
                    isMvp:bool, coins:int, xp:int, ratingDelta:int }
// Rewards fields are GET-only, calculated by backend; omit from trusted POST input.
MatchResult { matchId:string, state:string, blueScore:int, redScore:int,
              durationSeconds:float, finishedUtc:string,
              participants:ParticipantResult[] }
```

## Accounts, profile, presence

- `POST /v1/auth/guest` `{nickname,characterId}` → `{playerId,accessToken,refreshToken,expiresIn:int}`. Creates a server-owned profile with zero earned stats; never imports local balances.
- `POST /v1/auth/refresh` `{refreshToken}` → same response; rotating refresh credential.
- `GET /v1/me` → `{playerId,nickname,characterId,rank,rating,status,activeMatchId,activeQueueId,level:int,coins:int,xp:int,matches:int,wins:int,losses:int,draws:int,goals:int,assists:int,mvpCount:int}`.
- `PATCH /v1/me` `{nickname,characterId}` → same profile. Selection must use a known character ID.
- `GET /v1/players?search=<nickname>` → `{players:PlayerSummary[]}`; bounded results, case-insensitive prefix/name search.
- `POST /v1/presence` `{}` → `{status:string}`. Refresh every ~15 seconds in online menu. Authenticated API calls also refresh presence; expiry makes status offline.
- `GET /v1/regions` (public) → `{regions:[{id:string,probeUrl:string}]}`.
- `GET /v1/ping?region=<id>` (public) → `{region:string,serverTimeUtc:string}`. Time the full request locally, use median of three probes. Region choice must use samples; no IP geolocation. Local deployment advertises only `local`.
- `GET /health` → `{status:string,postgres:bool,redis:bool}`; 503 if either unavailable.
- `GET /v1/leaderboard` → `{players:PlayerSummary[]}` (top 50, server rating).
- `GET /v1/history` → `{matches:MatchResult[]}` (last 20 involving authenticated player).

## Friends and parties

- `GET /v1/friends` → `{friends:PlayerSummary[],requests:PlayerSummary[],recent:PlayerSummary[]}`. Requests are incoming pending requests; recent are real humans from recent matches.
- `POST /v1/friends/requests` `{playerId}` → `{ok:bool}`.
- `POST /v1/friends/requests/:playerId/respond` `{accept:bool}` → `{ok:bool}`. Path ID is requesting player.
- `DELETE /v1/friends/:playerId` → `{ok:bool}`.
- `POST /v1/party` `{}` → `Party`; idempotently create/get a party led by self.
- `GET /v1/party` → `Party`, including incoming invites.
- `POST /v1/party/invites` `{playerId}` → `{ok:bool}`; leader only, accepted friends only.
- `POST /v1/party/invites/:partyId/respond` `{accept:bool}` → `Party`; acceptance atomically enforces max 3 and one party per account.
- `DELETE /v1/party/members/:playerId` → `Party`; self leaves or leader removes. No membership changes during queue/match. If leader leaves, oldest remaining member becomes leader.

## Quick matchmaking

- `POST /v1/matchmaking` `{region:string,rttMs:int,characterId:string,partyId:string}` → `Allocation`. Empty partyId means solo. Only a party leader queues a party; its members stay together on one team. Queues consider selected measured region, latency, rating and party size. Party followers discover queue via `GET /v1/me.activeQueueId`.
- `GET /v1/matchmaking/:queueId` → `Allocation`; only queue members. Before assignment the join credentials are empty. A bounded wait fills remaining slots with server bots. Lack of capacity produces `FAILED`; never an infinite search.
- `DELETE /v1/matchmaking/:queueId` → `{ok:bool}`; any queued party member may cancel the whole queue before committed allocation. A committed match requires the leave route below.
- `GET /v1/matches/:matchId/join` → `Allocation`; assigned participant only. Used by room members/party followers and initial connection.

## Private rooms

- `POST /v1/rooms` `{region:string}` → `Room`.
- `POST /v1/rooms/join` `{code:string,characterId:string}` → `Room`.
- `GET /v1/rooms/:code` → `Room`; room member only.
- `POST /v1/rooms/:code/start` `{}` → `Room`; leader only. Allocate a registered available server; room members become participants, remaining slots bots. Room polling obtains matchId and then `/v1/matches/:matchId/join` supplies credentials.
- `DELETE /v1/rooms/:code` → `{ok:bool}`; leave only before launch. Empty room expires; leader is reassigned if needed.

## Reconnect and results

- `POST /v1/matches/:matchId/reconnect` `{reconnectToken:string}` → `Allocation`. Authenticated original account and secret must match. A fresh single-use ticket is issued only after server reports a disconnect, within 90 seconds. Existing player/team/slot/character never changes. Duplicate live connections are rejected.
- `POST /v1/matches/:matchId/leave` `{}` → `{ok:bool}`. Explicit leave forfeits reconnect rights; server retains same actor as bot through match end. Unexpected disconnect retains90second reservation. Closing UI on transport failure must not send leave.
- `GET /v1/matches/:matchId/results` → `MatchResult`; participant only. State `FINISHED` indicates trusted committed results; `FAILED` is interrupted server match and grants no win/rewards. Until committed returns409 `MATCH_NOT_FINISHED`.

## Trusted dedicated-server API

One process owns at most one live match. A registered process heartbeats every 3 seconds. Backend expires unavailable servers and their active matches after configurable timeout; no hung session survives indefinitely. `serverId` is a stable random deployment identity, `address` is reachable UDP host, `port` is transport port. No Unity client hosts a match.

- `POST /internal/servers/register` `{serverId:string,region:string,address:string,port:int,buildId:string}` → `{serverId:string}`.
- `POST /internal/servers/:serverId/heartbeat` `{state:string}` → `{matchId:string,matchSecret:string,slots:RosterSlot[],departedPlayerIds:string[]}`. States `IDLE`, `ASSIGNED`, `RUNNING`, `FINISHED`. Empty matchId means no allocation. Start existing Gameplay scene with supplied exactly 6 slots. Only allocation/result lifecycle releases server; a stale IDLE heartbeat must not erase assignment.
- `GET /internal/matches/:matchId` → `{matchId:string,matchSecret:string,slots:RosterSlot[]}`. Internal bearer required.
- `POST /internal/matches/:matchId/join` `{serverId:string,matchSecret:string,joinTicket:string,attemptId:string}` → `{accepted:bool,playerId:string,slot:int,team:int,characterId:string,nickname:string,reconnecting:bool,connectionId:string}`. Atomically consumes a valid ticket, acquires one live slot and stores an approval receipt. `attemptId` is a fresh UUID per transport approval; retry the same attempt and ticket after HTTP failure to receive the identical receipt (120-second retention). A new attempt cannot reuse the ticket. Legacy missing attemptId is accepted only for local compatibility and has no retry receipt. Rejected credentials return 401/403/409, not accepted:false with HTTP 200. NGO connection approval must await successful response before spawning/enabling remote input.
- `POST /internal/matches/:matchId/disconnect` `{serverId:string,matchSecret:string,playerId:string,voluntary:bool,connectionId:string}` → `{ok:bool,reconnectSeconds:int}`. Keep same existing actor and immediately switch to server AI; HTTP response need not block takeover. Voluntary means no reconnect; otherwise window 90 seconds. Repeated disconnect calls must not extend original deadline. `connectionId` is the successful approval attemptId; a stale generation cannot release a replacement connection. When every approval response was lost, send playerId `""` plus the original connectionId to abort that generation. No matching generation returns an idempotent success with zero reconnectSeconds.
- `POST /internal/matches/:matchId/results` `{serverId:string,matchSecret:string,blueScore:int,redScore:int,durationSeconds:float,participants:ParticipantResult[]}` → `{stored:bool}`. Include all human participants (even disconnected); filler bot entries with empty playerId may be omitted. PostgreSQL transaction commits score/history/stats/rewards exactly once. Repeating identical payload succeeds; conflicting duplicate is409. Client routes never accept result writes.
- `POST /internal/servers/:serverId/shutdown` `{}` → `{ok:bool}`. Marks running allocation failed unless result already committed; revokes temporary sessions. Call on graceful process shutdown. Timeout handles crash.

## Limits and semantics

Access sessions expire; refresh tokens are server-hashed and rotate. A 60-second replay grace returns the same rotated refresh credential after a lost HTTP response; clients should still coalesce refresh calls. Rate limits apply before auth. Join ticket TTL 60 seconds; reconnect window 90 seconds starts on first unexpected disconnect. Bot-fill wait and queue timeout are environment-configured; no-server timeout default 60 seconds. Match hard deadline default 15 minutes. Secrets/tokens are never written to application logs. Public errors omit stack traces, SQL, Redis keys and credentials.

The API does not run a physics loop. All game actions, action sequences, authoritative positions, goals, clock and takeover are handled by the Unity dedicated server over Unity Transport. Server results are the only online source of coins, XP and rating. Offline saves remain independent.

## Recovery boundaries

PostgreSQL final match state takes precedence over a stale Redis cache. Result replay and server-failure cleanup repair committed FINISHED state and never double-award rewards. Backend startup grants registered servers one SERVER_TIMEOUT interval to heartbeat or replay a pending result before stale-heartbeat expiry resumes. A match already durably FAILED cannot be resurrected or rewarded. A total loss of Redis allocation credentials is not a live-game recovery mechanism; drain/restart affected matches and treat them as failed rather than inventing results.
