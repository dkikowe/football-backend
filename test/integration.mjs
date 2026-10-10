import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createClient } from "redis";
import { userInfo } from "node:os";

// Real PostgreSQL and Redis only. Every run owns its DB + prefixed keys.
test(
  "real PostgreSQL + Redis multiplayer API contract",
  { timeout: 60000 },
  async (t) => {
    const dbName = "football_online_test_" + Date.now(),
      prefix = "football:test:" + randomUUID() + ":";
    const admin = new pg.Pool({
      connectionString:
        process.env.TEST_ADMIN_DATABASE_URL ||
        `postgresql://${userInfo().username}@127.0.0.1:5432/postgres`,
    });
    const redis = createClient({
      url: process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379",
    });
    await redis.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const dbUrl = new URL(
      process.env.TEST_ADMIN_DATABASE_URL ||
        `postgresql://${userInfo().username}@127.0.0.1:5432/postgres`,
    );
    dbUrl.pathname = "/" + dbName;
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const base = `http://127.0.0.1:${port}`,
      serverSecret = randomBytes(32).toString("hex");
    let child,
      output = "",
      heartbeat;
    const servers = new Set();
    const env = {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      PUBLIC_API_URL: base,
      DATABASE_URL: dbUrl.toString(),
      REDIS_URL: process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379",
      REDIS_PREFIX: prefix,
      GAME_SERVER_SECRET: serverSecret,
      BOT_FILL_SECONDS: "1",
      QUEUE_TIMEOUT_SECONDS: "3",
      SERVER_TIMEOUT_SECONDS: "4",
      MATCH_TIMEOUT_SECONDS: "40",
      RECONNECT_SECONDS: "2",
      JOIN_TICKET_SECONDS: "5",
      API_RATE_LIMIT: "10000",
    };
    async function start() {
      child = spawn(process.execPath, ["dist/main.js"], {
        cwd: new URL("..", import.meta.url),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (x) => (output += x));
      child.stderr.on("data", (x) => (output += x));
      for (let n = 0; n < 100; n++) {
        try {
          const r = await fetch(base + "/health");
          if (r.ok) return;
        } catch {}
        await delay(60);
      }
      throw new Error("API failed to start: " + output);
    }
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const c = child;
      c.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => c.once("exit", r)),
        delay(5000).then(() => c.kill("SIGKILL")),
      ]);
    }
    async function req(
      path,
      { method = "GET", body, auth, internal = false, status = 200 } = {},
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer " + auth.accessToken } : {}),
          ...(internal ? { Authorization: "Bearer " + serverSecret } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(
        response.status,
        status,
        `${method} ${path}: ${JSON.stringify(value)}`,
      );
      return value;
    }
    const post = (path, body, auth, status = 201) =>
      req(path, { method: "POST", body, auth, status });
    const internal = (path, body, status = 201) =>
      req(path, { method: "POST", body, internal: true, status });
    async function register(serverId = "test-1") {
      await internal("/internal/servers/register", {
        serverId,
        region: "local",
        address: "127.0.0.1",
        port: 7777,
        buildId: "test",
      });
      servers.add(serverId);
    }
    async function waitAllocated(user, q) {
      for (let n = 0; n < 60; n++) {
        const a = await req("/v1/matchmaking/" + q.queueId, { auth: user });
        if (a.matchId) return a;
        await delay(100);
      }
      throw new Error("allocation timeout");
    }
    async function ready(serverId = "test-1") {
      return internal("/internal/servers/" + serverId + "/heartbeat", {
        state: "IDLE",
      });
    }
    try {
      await start();
      heartbeat = setInterval(() => {
        for (const sid of servers)
          void internal("/internal/servers/" + sid + "/heartbeat", {
            state: "IDLE",
          }).catch(() => {});
      }, 700);
      heartbeat.unref();
      const users = [];
      let allocation, secret, results, party;
      await t.test(
        "guest auth, validation, measured region probe and refresh retry",
        async () => {
          await req("/v1/me", { status: 401 });
          await post(
            "/v1/auth/guest",
            { nickname: "A", characterId: "kai" },
            null,
            400,
          );
          await post(
            "/v1/auth/guest",
            { nickname: "CHEAT", characterId: "kai", coins: 10000 },
            null,
            400,
          );
          for (let n = 0; n < 8; n++)
            users.push(
              await post("/v1/auth/guest", {
                nickname: "TEST " + n,
                characterId: ["kai", "leo", "max", "bruno", "ryan", "diego"][
                  n % 6
                ],
              }),
            );
          const me = await req("/v1/me", { auth: users[0] });
          assert.equal(me.coins, 0);
          assert.equal(me.rating, 1000);
          assert.equal(me.status, "ONLINE");
          assert.equal((await req("/v1/regions")).regions[0].id, "local");
          assert.equal((await req("/v1/ping?region=local")).region, "local");
          const before = users[0].refreshToken,
            newSession = await post("/v1/auth/refresh", {
              refreshToken: before,
            });
          assert.equal(newSession.playerId, users[0].playerId);
          assert.notEqual(newSession.refreshToken, before);
          const retry = await post("/v1/auth/refresh", {
            refreshToken: before,
          });
          assert.equal(retry.refreshToken, newSession.refreshToken);
          users[0] = newSession;
        },
      );
      await t.test(
        "friends accept/decline; party invitations capped at three",
        async () => {
          for (const user of users.slice(1, 4)) {
            await post(
              "/v1/friends/requests",
              { playerId: user.playerId },
              users[0],
            );
            await post(
              "/v1/friends/requests/" + users[0].playerId + "/respond",
              { accept: true },
              user,
            );
          }
          assert.equal(
            (await req("/v1/friends", { auth: users[0] })).friends.length,
            3,
          );
          await post(
            "/v1/friends/requests",
            { playerId: users[7].playerId },
            users[6],
          );
          await post(
            "/v1/friends/requests/" + users[6].playerId + "/respond",
            { accept: false },
            users[7],
          );
          assert.equal(
            (await req("/v1/friends", { auth: users[7] })).requests.length,
            0,
          );
          party = await post("/v1/party", {}, users[0]);
          for (const user of users.slice(1, 3)) {
            await post(
              "/v1/party/invites",
              { playerId: user.playerId },
              users[0],
            );
            await post(
              "/v1/party/invites/" + party.partyId + "/respond",
              { accept: true },
              user,
            );
          }
          assert.equal(
            (await req("/v1/party", { auth: users[0] })).members.length,
            3,
          );
          await post(
            "/v1/party/invites",
            { playerId: users[3].playerId },
            users[0],
            409,
          );
          await post(
            "/v1/party/invites",
            { playerId: users[3].playerId },
            users[1],
            403,
          );
        },
      );
      await t.test(
        "party follower can cancel before allocation for the whole party",
        async () => {
          const queued = await post(
            "/v1/matchmaking",
            {
              region: "local",
              rttMs: 45,
              characterId: "kai",
              partyId: party.partyId,
            },
            users[0],
          );
          await req("/v1/matchmaking/" + queued.queueId, {
            method: "DELETE",
            auth: users[1],
          });
          assert.equal(
            (await req("/v1/matchmaking/" + queued.queueId, { auth: users[0] }))
              .state,
            "CANCELLED",
          );
          for (const user of users.slice(0, 3))
            assert.equal(
              (await req("/v1/me", { auth: user })).activeQueueId,
              "",
            );
        },
      );
      await t.test(
        "six humans allocate exactly six slots; party stays on one team",
        async () => {
          await register();
          const q = await post(
            "/v1/matchmaking",
            {
              region: "local",
              rttMs: 45,
              characterId: "kai",
              partyId: party.partyId,
            },
            users[0],
          );
          for (const user of users.slice(3, 6))
            await post(
              "/v1/matchmaking",
              { region: "local", rttMs: 55, characterId: "leo", partyId: "" },
              user,
            );
          allocation = await waitAllocated(users[0], q);
          assert.equal(allocation.slots.length, 6);
          assert.equal(allocation.slots.filter((x) => !x.isBot).length, 6);
          assert.equal(
            new Set(
              allocation.slots
                .filter((x) =>
                  users.slice(0, 3).some((u) => u.playerId === x.playerId),
                )
                .map((x) => x.team),
            ).size,
            1,
          );
          const data = await req("/internal/matches/" + allocation.matchId, {
            internal: true,
          });
          secret = data.matchSecret;
          assert.equal((await ready()).matchId, allocation.matchId);
          assert.equal(data.slots.length, 6);
          await req("/v1/matchmaking/" + q.queueId, {
            auth: users[7],
            status: 403,
          });
          await req("/v1/matchmaking/" + q.queueId, {
            method: "DELETE",
            auth: users[0],
            status: 409,
          });
        },
      );
      await t.test(
        "single-use tickets, idempotent approval receipts, SQL failure safety and connection generations",
        async () => {
          const attempts = new Map();
          const faultDb = new pg.Pool({ connectionString: dbUrl.toString() });
          try {
            for (const user of users.slice(0, 6)) {
              const c = await req(
                "/v1/matches/" + allocation.matchId + "/join",
                { auth: user },
              );
              const attemptId = randomUUID();
              attempts.set(user.playerId, attemptId);
              const request = {
                serverId: "test-1",
                matchSecret: secret,
                joinTicket: c.joinTicket,
                attemptId,
              };
              if (user === users[0]) {
                await faultDb.query(
                  "CREATE FUNCTION reject_join_for_test() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_join BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION reject_join_for_test()",
                );
                await internal(
                  "/internal/matches/" + allocation.matchId + "/join",
                  request,
                  500,
                );
                await faultDb.query(
                  "DROP TRIGGER reject_join ON matches; DROP FUNCTION reject_join_for_test()",
                );
              }
              const joined = await internal(
                "/internal/matches/" + allocation.matchId + "/join",
                request,
              );
              assert.equal(joined.playerId, user.playerId);
              assert.equal(joined.connectionId, attemptId);
              assert.equal(joined.reconnecting, false);
              // Simulate a committed approval whose HTTP response was lost.
              assert.deepEqual(
                await internal(
                  "/internal/matches/" + allocation.matchId + "/join",
                  request,
                ),
                joined,
              );
              await internal(
                "/internal/matches/" + allocation.matchId + "/join",
                { ...request, attemptId: randomUUID() },
                401,
              );
            }
          } finally {
            await faultDb.end();
          }
          await post(
            "/v1/matches/" + allocation.matchId + "/reconnect",
            { reconnectToken: allocation.reconnectToken },
            users[7],
            403,
          );
          await post(
            "/v1/matches/" + allocation.matchId + "/reconnect",
            { reconnectToken: allocation.reconnectToken },
            users[0],
            409,
          );
          // Cleanup works even when Unity never received the approved playerId.
          await internal(
            "/internal/matches/" + allocation.matchId + "/disconnect",
            {
              serverId: "test-1",
              matchSecret: secret,
              playerId: "",
              connectionId: attempts.get(users[0].playerId),
              voluntary: false,
            },
          );
          const c = await post(
            "/v1/matches/" + allocation.matchId + "/reconnect",
            { reconnectToken: allocation.reconnectToken },
            users[0],
          );
          const current = randomUUID();
          const joined = await internal(
            "/internal/matches/" + allocation.matchId + "/join",
            {
              serverId: "test-1",
              matchSecret: secret,
              joinTicket: c.joinTicket,
              attemptId: current,
            },
          );
          assert.equal(joined.reconnecting, true);
          assert.equal(
            joined.slot,
            allocation.slots.find((s) => s.playerId === users[0].playerId).slot,
          );
          // A delayed old-generation disconnect must not release the replacement.
          await internal(
            "/internal/matches/" + allocation.matchId + "/disconnect",
            {
              serverId: "test-1",
              matchSecret: secret,
              playerId: users[0].playerId,
              connectionId: attempts.get(users[0].playerId),
              voluntary: false,
            },
          );
          await post(
            "/v1/matches/" + allocation.matchId + "/reconnect",
            { reconnectToken: allocation.reconnectToken },
            users[0],
            409,
          );
        },
      );
      await t.test(
        "independent disconnects, bounded reconnect window, voluntary leave forfeits",
        async () => {
          const c1 = await req("/v1/matches/" + allocation.matchId + "/join", {
              auth: users[1],
            }),
            c2 = await req("/v1/matches/" + allocation.matchId + "/join", {
              auth: users[2],
            });
          for (const user of users.slice(1, 3))
            await internal(
              "/internal/matches/" + allocation.matchId + "/disconnect",
              {
                serverId: "test-1",
                matchSecret: secret,
                playerId: user.playerId,
                voluntary: false,
              },
            );
          await post(
            "/v1/matches/" + allocation.matchId + "/leave",
            {},
            users[1],
          );
          await post(
            "/v1/matches/" + allocation.matchId + "/reconnect",
            { reconnectToken: c1.reconnectToken },
            users[1],
            409,
          );
          await delay(2100);
          const repeated = await internal(
            "/internal/matches/" + allocation.matchId + "/disconnect",
            {
              serverId: "test-1",
              matchSecret: secret,
              playerId: users[2].playerId,
              voluntary: false,
            },
          );
          assert.equal(repeated.reconnectSeconds, 0);
          await post(
            "/v1/matches/" + allocation.matchId + "/reconnect",
            { reconnectToken: c2.reconnectToken },
            users[2],
            403,
          );
        },
      );
      await t.test(
        "no client GOAL/results write; trusted result updates stats and rewards once",
        async () => {
          results = {
            serverId: "test-1",
            matchSecret: secret,
            blueScore: 3,
            redScore: 1,
            durationSeconds: 90,
            participants: allocation.slots.map((s) => ({
              playerId: s.playerId,
              slot: s.slot,
              goals: s.slot === 0 ? 2 : 0,
              assists: s.slot === 1 ? 1 : 0,
              shots: 3,
              passes: 5,
              tackles: 1,
              possessionSeconds: 10,
              isMvp: s.slot === 0,
            })),
          };
          await post(
            "/v1/matches/" + allocation.matchId + "/goal",
            { blueScore: 999 },
            users[0],
            404,
          );
          await post(
            "/v1/matches/" + allocation.matchId + "/results",
            results,
            users[0],
            404,
          );
          await post(
            "/internal/matches/" + allocation.matchId + "/results",
            results,
            users[0],
            401,
          );
          await internal(
            "/internal/matches/" + allocation.matchId + "/results",
            { ...results, matchSecret: "x".repeat(40) },
            403,
          );
          await internal(
            "/internal/matches/" + allocation.matchId + "/results",
            results,
          );
          await internal(
            "/internal/matches/" + allocation.matchId + "/results",
            results,
          );
          await internal(
            "/internal/matches/" + allocation.matchId + "/results",
            { ...results, blueScore: 4 },
            409,
          );
          const me = await req("/v1/me", { auth: users[0] });
          assert.equal(me.matches, 1);
          assert.equal(me.wins, 1);
          assert.equal(me.coins, 60);
          assert.equal(me.rating, 1024);
          assert.equal(me.activeMatchId, "");
          const saved = await req(
            "/v1/matches/" + allocation.matchId + "/results",
            { auth: users[0] },
          );
          assert.equal(saved.blueScore, 3);
          assert.equal(saved.participants[0].coins, 60);
          assert.equal(
            (await req("/v1/history", { auth: users[0] })).matches.length,
            1,
          );
          assert.equal(
            (await req("/v1/friends", { auth: users[0] })).recent.length,
            5,
          );
        },
      );
      await t.test(
        "durable SQL results repair stale Redis before failure and duplicate replay",
        async () => {
          const allocationKey = prefix + "match:" + allocation.matchId;
          const cached = JSON.parse(await redis.get(allocationKey));
          cached.state = "RUNNING";
          await redis.set(allocationKey, JSON.stringify(cached));
          await redis.sAdd(prefix + "live-matches", allocation.matchId);
          const staleServer = JSON.parse(
            await redis.get(prefix + "server:test-1"),
          );
          staleServer.matchId = allocation.matchId;
          staleServer.state = "RUNNING";
          await redis.set(
            prefix + "server:test-1",
            JSON.stringify(staleServer),
          );
          await redis.set(
            prefix + "active-match:" + users[0].playerId,
            allocation.matchId,
          );
          // Re-register triggers failMatch, which must consult the committed SQL result.
          await register();
          await internal(
            "/internal/matches/" + allocation.matchId + "/results",
            results,
          );
          assert.equal(
            JSON.parse(await redis.get(allocationKey)).state,
            "FINISHED",
          );
          assert.equal(
            await redis.get(prefix + "active-match:" + users[0].playerId),
            null,
          );
          const me = await req("/v1/me", { auth: users[0] });
          assert.equal(me.matches, 1);
          assert.equal(me.coins, 60);
        },
      );
      await t.test(
        "private room starts 2 humans +4 bots and enforces leader",
        async () => {
          await ready();
          const r = await post(
            "/v1/rooms",
            { region: "local", characterId: "kai" },
            users[6],
          );
          await post(
            "/v1/rooms/join",
            { code: r.code, characterId: "max" },
            users[7],
          );
          await post("/v1/rooms/" + r.code + "/start", {}, users[7], 403);
          const started = await post(
            "/v1/rooms/" + r.code + "/start",
            {},
            users[6],
          );
          const c = await req("/v1/matches/" + started.matchId + "/join", {
            auth: users[7],
          });
          assert.equal(c.slots.length, 6);
          assert.equal(c.slots.filter((x) => x.isBot).length, 4);
          await internal("/internal/servers/test-1/shutdown", {});
          servers.delete("test-1");
          assert.equal(
            (
              await req("/v1/matches/" + started.matchId + "/results", {
                auth: users[6],
              })
            ).state,
            "FAILED",
          );
        },
      );
      await t.test(
        "queue cancel and capacity timeout are finite; offline local state never consulted",
        async () => {
          const q = await post(
            "/v1/matchmaking",
            { region: "local", rttMs: 30, characterId: "kai", partyId: "" },
            users[6],
          );
          await req("/v1/matchmaking/" + q.queueId, {
            method: "DELETE",
            auth: users[6],
          });
          assert.equal(
            (await req("/v1/matchmaking/" + q.queueId, { auth: users[6] }))
              .state,
            "CANCELLED",
          );
          const q2 = await post(
            "/v1/matchmaking",
            { region: "local", rttMs: 50, characterId: "kai", partyId: "" },
            users[6],
          );
          await delay(3600);
          assert.equal(
            (await req("/v1/matchmaking/" + q2.queueId, { auth: users[6] }))
              .state,
            "FAILED",
          );
          assert.equal(
            (await req("/v1/me", { auth: users[6] })).activeQueueId,
            "",
          );
        },
      );
      await t.test(
        "API outage grace preserves live allocation and accepts immutable result replay",
        async () => {
          await register("restart-server");
          const q = await post(
            "/v1/matchmaking",
            { region: "local", rttMs: 35, characterId: "kai", partyId: "" },
            users[6],
          );
          const c = await waitAllocated(users[6], q);
          const allocated = await req("/internal/matches/" + c.matchId, {
            internal: true,
          });
          await internal("/internal/matches/" + c.matchId + "/join", {
            serverId: "restart-server",
            matchSecret: allocated.matchSecret,
            joinTicket: c.joinTicket,
          });
          servers.delete("restart-server");
          await stop();
          await delay(4300);
          await start();
          await delay(900); // Let the new API's first lifecycle tick run before the server recovers.
          const resumed = await internal(
            "/internal/servers/restart-server/heartbeat",
            { state: "RUNNING" },
          );
          assert.equal(resumed.matchId, c.matchId);
          servers.add("restart-server");
          const human = c.slots.find((s) => s.playerId === users[6].playerId);
          const result = {
            serverId: "restart-server",
            matchSecret: allocated.matchSecret,
            blueScore: 0,
            redScore: 0,
            durationSeconds: 15,
            participants: [
              {
                playerId: human.playerId,
                slot: human.slot,
                goals: 0,
                assists: 0,
                shots: 0,
                passes: 0,
                tackles: 0,
                possessionSeconds: 0,
                isMvp: false,
              },
            ],
          };
          await internal("/internal/matches/" + c.matchId + "/results", result);
          await internal("/internal/matches/" + c.matchId + "/results", result);
          assert.equal((await req("/v1/me", { auth: users[6] })).matches, 1);
          await internal("/internal/servers/restart-server/shutdown", {});
          servers.delete("restart-server");
        },
      );
      await t.test(
        "unexpected dedicated server expiry marks match failed without rewards",
        async () => {
          await register("crash-server");
          const q = await post(
            "/v1/matchmaking",
            { region: "local", rttMs: 70, characterId: "kai", partyId: "" },
            users[7],
          );
          const c = await waitAllocated(users[7], q);
          assert.equal(c.slots.filter((x) => x.isBot).length, 5);
          servers.delete("crash-server");
          await delay(4700);
          assert.equal(
            (
              await req("/v1/matches/" + c.matchId + "/results", {
                auth: users[7],
              })
            ).state,
            "FAILED",
          );
          assert.equal((await req("/v1/me", { auth: users[7] })).matches, 0);
        },
      );
      await t.test(
        "API restart preserves guest identity, online history and authoritative balances",
        async () => {
          await stop();
          await start();
          const refreshed = await post("/v1/auth/refresh", {
            refreshToken: users[0].refreshToken,
          });
          assert.equal(refreshed.playerId, users[0].playerId);
          const me = await req("/v1/me", { auth: refreshed });
          assert.equal(me.matches, 1);
          assert.equal(me.coins, 60);
          assert.equal(
            (await req("/v1/history", { auth: refreshed })).matches.length,
            1,
          );
        },
      );
      await t.test("account deletion revokes sessions, clears friends and transfers party leadership", async () => {
        const a=await post("/v1/auth/guest",{nickname:"Delete Me",characterId:"kai"});
        const b=await post("/v1/auth/guest",{nickname:"Keep Me",characterId:"leo"});
        await post("/v1/friends/requests",{playerId:b.playerId},a);
        await post("/v1/friends/requests/"+a.playerId+"/respond",{accept:true},b);
        const party=await post("/v1/party",{},a);
        await post("/v1/party/invites",{playerId:b.playerId},a);
        await post("/v1/party/invites/"+party.partyId+"/respond",{accept:true},b);
        const refreshed=await post("/v1/auth/refresh",{refreshToken:a.refreshToken});
        await req("/v1/me",{method:"DELETE",auth:refreshed});
        await req("/v1/me",{method:"DELETE",auth:refreshed}); // lost-response retry
        await req("/v1/me",{auth:a,status:401});
        await req("/v1/me",{auth:refreshed,status:401});
        await post("/v1/auth/refresh",{refreshToken:a.refreshToken},null,401);
        await post("/v1/auth/refresh",{refreshToken:refreshed.refreshToken},null,401);
        assert.equal((await req("/v1/friends",{auth:b})).friends.length,0);
        assert.equal((await req("/v1/party",{auth:b})).leaderId,b.playerId);
        const inspect=new pg.Pool({connectionString:dbUrl.toString()});
        try { for(const table of ["players","guest_refresh","player_stats","ratings","balances"]){
          const column=table==="players"?"id":"player_id";
          assert.equal((await inspect.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[a.playerId])).rowCount,0);
        }} finally {await inspect.end();}
        for(const route of ["privacy","support"]){const r=await fetch(base+"/"+route);assert.equal(r.status,200);assert.match(r.headers.get("content-type"),/text\/html/);assert.match(await r.text(),/krutyev5@gmail.com/);}
      });
      await t.test(
        "random authorization headers cannot bypass guest rate limits",
        async () => {
          if (Date.now() % 60000 > 58500) await delay(1600);
          let limited = false;
          for (let n = 0; n < 35; n++) {
            const response = await fetch(base + "/v1/auth/guest", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + randomUUID(),
              },
              body: JSON.stringify({ nickname: "x", characterId: "kai" }),
            });
            if (response.status === 429) {
              assert.equal((await response.json()).code, "RATE_LIMITED");
              limited = true;
              break;
            }
            assert.equal(response.status, 400);
          }
          assert.equal(limited, true);
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await stop();
      const keys = [];
      for await (const batch of redis.scanIterator({
        MATCH: prefix + "*",
        COUNT: 100,
      })) {
        keys.push(...batch);
      }
      if (keys.length) await redis.del(keys);
      await redis.quit();
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  },
);
