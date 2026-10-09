#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateUrl } from "./deployed-api-smoke.mjs";

// Authenticated API acceptance only. No server credential, fabricated result or UDP simulation.
const [origin, phase = "before", ...args] = process.argv.slice(2);
const localDirectory = fileURLToPath(new URL("../.local/", import.meta.url));
const statePath = resolve(
  localDirectory,
  args[0] || "deployed-session-smoke.json",
);
const checks = [];
let state,
  base,
  keepFriendship = false;
class SmokeError extends Error {}
function requireCheck(condition, label) {
  if (!condition) throw new SmokeError(label);
}
async function save() {
  const temporary = statePath + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(state), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, statePath);
    await chmod(statePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function request(
  path,
  { method = "GET", body, user, status = 200 } = {},
) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      ...(user ? { Authorization: `Bearer ${user.accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Never include the server response/body or request credentials in output.
  requireCheck(
    response.status === status,
    `${method} ${path}: HTTP ${response.status}, expected ${status}`,
  );
  return response.json();
}
const post = (path, body, user, status = 201) =>
  request(path, { method: "POST", body, user, status });
const remove = (path, user) => request(path, { method: "DELETE", user });
async function check(label, fn) {
  await fn();
  checks.push({ check: label, passed: true });
}
async function refresh(index) {
  const previous = state.users[index];
  const session = await post("/v1/auth/refresh", {
    refreshToken: previous.refreshToken,
  });
  requireCheck(
    session.playerId === previous.playerId &&
      session.accessToken &&
      session.refreshToken,
    "Refresh changed account identity.",
  );
  state.users[index] = { ...previous, ...session };
  await save();
}
async function profiles() {
  for (const user of state.users) {
    const me = await request("/v1/me", { user });
    requireCheck(
      me.playerId === user.playerId &&
        me.nickname === user.nickname &&
        me.characterId === user.characterId,
      "Owned guest profile identity or selection changed.",
    );
    requireCheck(
      me.coins === 0 &&
        me.xp === 0 &&
        me.matches === 0 &&
        me.goals === 0 &&
        me.rating === 1000,
      "Smoke account unexpectedly received match stats or rewards.",
    );
    const history = await request("/v1/history", { user });
    requireCheck(
      Array.isArray(history.matches) && history.matches.length === 0,
      "Smoke account unexpectedly has match history.",
    );
  }
}
async function friendsExist() {
  const [a, b] = state.users;
  for (const [user, other] of [
    [a, b],
    [b, a],
  ]) {
    const social = await request("/v1/friends", { user });
    requireCheck(
      social.friends.some((x) => x.playerId === other.playerId),
      "Accepted friend missing.",
    );
  }
}
async function cleanup(removeFriendship) {
  let ok = true;
  const attempt = async (action) => {
    try {
      await action();
    } catch {
      ok = false;
    }
  };
  // Cleanup owns only these guests and only uses normal authenticated API operations.
  for (const user of [...state.users].reverse()) {
    await attempt(async () => {
      const me = await request("/v1/me", { user });
      if (me.activeQueueId)
        await remove(`/v1/matchmaking/${me.activeQueueId}`, user);
      if (me.activeMatchId)
        await post(`/v1/matches/${me.activeMatchId}/leave`, {}, user);
    });
    if (state.roomCode) {
      await attempt(async () => {
        const response = await fetch(
          new URL(`/v1/rooms/${state.roomCode}`, base),
          {
            method: "DELETE",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: { Authorization: `Bearer ${user.accessToken}` },
          },
        );
        requireCheck(
          response.ok || response.status === 404,
          "Owned room cleanup failed.",
        );
      });
    }
    await attempt(async () => {
      const party = await request("/v1/party", { user });
      if (party.partyId)
        await remove(`/v1/party/members/${user.playerId}`, user);
    });
  }
  if (removeFriendship && state.users.length === 2)
    await attempt(() =>
      remove(`/v1/friends/${state.users[1].playerId}`, state.users[0]),
    );
  return ok;
}
async function before() {
  const { regions } = await request("/v1/regions");
  requireCheck(
    Array.isArray(regions) && regions.length > 0,
    "No configured region.",
  );
  const region = regions[0].id;
  state = {
    version: 1,
    origin: base.origin,
    users: [],
    roomCode: "",
    prepared: false,
  };
  await save();
  await check("two_disposable_guests_created", async () => {
    const suffix = randomBytes(4).toString("hex");
    for (const label of ["A", "B"]) {
      const nickname = `DeployTest${suffix}${label}`,
        characterId = label === "A" ? "kai" : "leo";
      const session = await post("/v1/auth/guest", { nickname, characterId });
      requireCheck(
        session.playerId && session.accessToken && session.refreshToken,
        "Guest session incomplete.",
      );
      state.users.push({ ...session, nickname, characterId });
      await save();
    }
  });
  await check("profile_update_and_refresh_same_account", async () => {
    const user = state.users[0];
    await request("/v1/me", {
      method: "PATCH",
      user,
      body: { nickname: user.nickname, characterId: "max" },
    });
    user.characterId = "max";
    await save();
    await refresh(0);
    await refresh(1);
    await profiles();
  });
  const [a, b] = state.users;
  await check("client_token_cannot_access_internal_api", async () => {
    await request("/v1/me", { status: 401 });
    await request("/internal/metrics", { user: a, status: 401 });
    await post(
      "/v1/auth/refresh",
      { refreshToken: randomBytes(32).toString("hex") },
      null,
      401,
    );
  });
  await check("friend_request_and_accept", async () => {
    await post("/v1/friends/requests", { playerId: b.playerId }, a);
    const received = await request("/v1/friends", { user: b });
    requireCheck(
      received.requests.some((x) => x.playerId === a.playerId),
      "Friend request missing.",
    );
    await post(
      `/v1/friends/requests/${a.playerId}/respond`,
      { accept: true },
      b,
    );
    await friendsExist();
  });
  await check("party_invite_accept_and_remove", async () => {
    const party = await post("/v1/party", {}, a);
    await post("/v1/party/invites", { playerId: b.playerId }, a);
    const invites = await request("/v1/party", { user: b });
    requireCheck(
      invites.invites.some((x) => x.partyId === party.partyId),
      "Party invitation missing.",
    );
    const joined = await post(
      `/v1/party/invites/${party.partyId}/respond`,
      { accept: true },
      b,
    );
    requireCheck(joined.members.length === 2, "Party membership mismatch.");
    await remove(`/v1/party/members/${b.playerId}`, a);
    requireCheck(
      !(await request("/v1/party", { user: b })).partyId,
      "Party removal failed.",
    );
    await remove(`/v1/party/members/${a.playerId}`, a);
  });
  await check("private_room_join_and_leave", async () => {
    const room = await post(
      "/v1/rooms",
      { region, characterId: a.characterId },
      a,
    );
    state.roomCode = room.code;
    await save();
    const joined = await post(
      "/v1/rooms/join",
      { code: room.code, characterId: b.characterId },
      b,
    );
    requireCheck(
      joined.members.length === 2 &&
        !joined.matchId &&
        joined.state === "READY",
      "Private room state incorrect.",
    );
    await remove(`/v1/rooms/${room.code}`, b);
    requireCheck(
      (await request(`/v1/rooms/${room.code}`, { user: a })).members.length ===
        1,
      "Room leave failed.",
    );
    await remove(`/v1/rooms/${room.code}`, a);
    state.roomCode = "";
    await save();
  });
  await check(
    "queue_has_no_fabricated_allocation_and_cancel_works",
    async () => {
      const queue = await post(
        "/v1/matchmaking",
        { region, rttMs: 100, characterId: a.characterId, partyId: "" },
        a,
      );
      const waiting = await request(`/v1/matchmaking/${queue.queueId}`, {
        user: a,
      });
      requireCheck(
        waiting.state === "SEARCHING" &&
          !waiting.matchId &&
          !waiting.joinTicket &&
          !waiting.address &&
          waiting.port === 0 &&
          waiting.slots.length === 0,
        "Queue allocated unexpectedly; use this deployment smoke before fleet registration.",
      );
      await remove(`/v1/matchmaking/${queue.queueId}`, a);
      requireCheck(
        (await request(`/v1/matchmaking/${queue.queueId}`, { user: a }))
          .state === "CANCELLED",
        "Queue cancellation failed.",
      );
      requireCheck(
        !(await request("/v1/me", { user: a })).activeQueueId,
        "Queue reservation was not removed.",
      );
    },
  );
  await check("no_match_stats_or_rewards_written", profiles);
  state.prepared = true;
  await save();
  keepFriendship = true;
}
async function main() {
  let success = false,
    cleanupPassed = true;
  try {
    requireCheck(
      origin && ["before", "after", "cleanup"].includes(phase),
      "Usage: node scripts/deployed-session-smoke.mjs https://API before|after|cleanup [state-file-name.json]",
    );
    requireCheck(
      dirname(statePath) === resolve(localDirectory),
      "State file must be directly inside backend/.local.",
    );
    base = validateUrl(origin);
    requireCheck(
      base.pathname === "/" && !base.search && !base.hash,
      "Supply only the API origin.",
    );
    await mkdir(localDirectory, { recursive: true, mode: 0o700 });
    requireCheck(
      !(await lstat(localDirectory)).isSymbolicLink(),
      "State directory must not be a symlink.",
    );
    let existing;
    try {
      existing = await lstat(statePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (phase === "before") {
      requireCheck(
        !existing,
        "State already exists; run after/cleanup or use another state filename.",
      );
      await before();
    } else {
      requireCheck(
        existing?.isFile() &&
          !existing.isSymbolicLink() &&
          (existing.mode & 0o077) === 0,
        "Missing or non-private state file.",
      );
      state = JSON.parse(await readFile(statePath, "utf8"));
      requireCheck(
        state.version === 1 &&
          state.origin === base.origin &&
          Array.isArray(state.users),
        "State belongs to another origin or format.",
      );
      keepFriendship = phase === "after";
      for (let i = 0; i < state.users.length; i++) await refresh(i);
      if (phase === "after") {
        requireCheck(
          state.prepared && state.users.length === 2,
          "Before phase did not complete.",
        );
        await check("same_guest_accounts_refresh_after_restart", profiles);
        await check("accepted_friendship_survives_restart", friendsExist);
        keepFriendship = false;
      }
    }
    success = true;
  } catch (error) {
    // Custom errors never contain tokens or response bodies.
    process.stderr.write(
      JSON.stringify({
        result: "FAIL",
        phase,
        error:
          error instanceof SmokeError
            ? error.message
            : "Request or private state I/O failed.",
      }) + "\n",
    );
  } finally {
    if (state && base && state.origin === base.origin) {
      cleanupPassed = await cleanup(!keepFriendship);
      if (cleanupPassed && !keepFriendship)
        await unlink(statePath).catch(() => {});
    }
    process.stdout.write(
      JSON.stringify(
        {
          result: success && cleanupPassed ? "PASS" : "FAIL",
          phase,
          scope: "authenticated deployed API; not a UDP match",
          checks,
          cleanupPassed,
          persistenceStateSaved: keepFriendship,
          disposableGuestProfilesRemain: !!state?.users.length,
        },
        null,
        2,
      ) + "\n",
    );
    if (!success || !cleanupPassed) process.exitCode = 1;
  }
}
await main();
