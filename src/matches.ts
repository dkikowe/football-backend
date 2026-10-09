import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AuthService } from "./auth";
import { SocialService } from "./social";
import { config } from "./config";
import { db, redis, get, set, key, transaction } from "./db";
import { fail, hash, id, token, secretEqual, lock } from "./common";
import { Allocation, Lease, Queue, Room, Server, Slot } from "./types";
@Injectable()
export class MatchesService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly bootedAt = Date.now();
  constructor(
    private readonly auth: AuthService,
    private readonly social: SocialService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private region(value: string) {
    if (!config.regions.some((x) => x.id === value))
      fail(400, "VALIDATION_ERROR", "Unknown measured region.");
  }
  async queue(
    playerId: string,
    input: {
      region: string;
      rttMs: number;
      characterId: string;
      partyId?: string;
    },
  ) {
    this.region(input.region);
    let members = [playerId];
    if (input.partyId) {
      const party = await this.social.party(playerId);
      if (party.partyId !== input.partyId || party.leaderId !== playerId)
        fail(403, "FORBIDDEN", "Only party leader may search.");
      members = party.members.map((x) => x.playerId);
    }
    await this.auth.available(members);
    await db.query("UPDATE players SET character_id=$2 WHERE id=$1", [
      playerId,
      input.characterId,
    ]);
    const profiles = await this.auth.summaries(members);
    const q: Queue = {
      queueId: id(),
      leaderId: playerId,
      members,
      region: input.region,
      rttMs: Math.round(input.rttMs),
      rating: Math.round(
        profiles.reduce((s, x) => s + x.rating, 0) / members.length,
      ),
      created: Date.now(),
      state: "SEARCHING",
      matchId: "",
    };
    await set("queue:" + q.queueId, q, 3600);
    await redis.zAdd(key("queues"), { score: q.created, value: q.queueId });
    for (const pid of members)
      await redis.set(key("active-queue:" + pid), q.queueId, { EX: 3600 });
    return this.queueStatus(playerId, q.queueId);
  }
  async queueStatus(playerId: string, queueId: string) {
    const q = await get<Queue>("queue:" + queueId);
    if (!q) fail(404, "NOT_FOUND", "Search expired.");
    if (!q.members.includes(playerId))
      fail(403, "FORBIDDEN", "Search belongs to another player.");
    if (q.matchId)
      return { ...(await this.connection(playerId, q.matchId)), queueId };
    return {
      queueId,
      state: q.state,
      waitSeconds: Math.floor((Date.now() - q.created) / 1000),
      matchId: "",
      address: "",
      port: 0,
      region: q.region,
      joinTicket: "",
      reconnectToken: "",
      slots: [],
    };
  }
  async cancel(playerId: string, queueId: string) {
    const q = await get<Queue>("queue:" + queueId);
    if (!q || !q.members.includes(playerId))
      fail(403, "FORBIDDEN", "Only search members can cancel.");
    if (q.matchId)
      fail(
        409,
        "ALREADY_ALLOCATED",
        "Match already allocated; use leave match.",
      );
    await this.closeQueue(q, "CANCELLED");
    return { ok: true };
  }
  private async closeQueue(q: Queue, state: string) {
    q.state = state;
    await set("queue:" + q.queueId, q, 300);
    await redis.zRem(key("queues"), q.queueId);
    for (const pid of q.members)
      if ((await redis.get(key("active-queue:" + pid))) === q.queueId)
        await redis.del(key("active-queue:" + pid));
  }
  async register(input: {
    serverId: string;
    region: string;
    address: string;
    port: number;
    buildId: string;
  }) {
    this.region(input.region);
    const previous = await get<Server>("server:" + input.serverId);
    if (previous?.matchId)
      await this.failMatch(previous.matchId, "SERVER_RESTARTED");
    const server: Server = {
      ...input,
      state: "IDLE",
      lastSeen: Date.now(),
      matchId: "",
    };
    await set("server:" + server.serverId, server, 86400);
    await redis.sAdd(key("servers"), server.serverId);
    return { serverId: server.serverId };
  }
  async heartbeat(serverId: string, state: string) {
    const server = await get<Server>("server:" + serverId);
    if (!server) fail(404, "NOT_FOUND", "Register game server first.");
    server.lastSeen = Date.now();
    let allocation = server.matchId
      ? await get<Allocation>("match:" + server.matchId)
      : null;
    if (allocation && ["FINISHED", "FAILED"].includes(allocation.state)) {
      server.matchId = "";
      allocation = null;
    }
    server.state = server.matchId
      ? state === "RUNNING"
        ? "RUNNING"
        : "ASSIGNED"
      : state === "IDLE"
        ? "IDLE"
        : "FINISHED";
    await set("server:" + serverId, server, 86400);
    return {
      matchId: allocation?.matchId || "",
      matchSecret: allocation?.matchSecret || "",
      slots: allocation?.slots || [],
      departedPlayerIds:
        allocation?.leases.filter((x) => x.voluntary).map((x) => x.playerId) ||
        [],
    };
  }
  async shutdown(serverId: string) {
    const server = await get<Server>("server:" + serverId);
    if (server?.matchId)
      await this.failMatch(server.matchId, "SERVER_SHUTDOWN");
    await redis.del(key("server:" + serverId));
    await redis.sRem(key("servers"), serverId);
    return { ok: true };
  }
  private async availableServer(region: string) {
    for (const serverId of await redis.sMembers(key("servers"))) {
      const server = await get<Server>("server:" + serverId);
      if (
        server &&
        server.state === "IDLE" &&
        server.region === region &&
        !server.matchId &&
        Date.now() - server.lastSeen < config.SERVER_TIMEOUT_SECONDS * 1000
      )
        return server;
    }
    return null;
  }
  private async allocate(
    server: Server,
    teams: string[][],
    mode: string,
    queues: Queue[] = [],
  ) {
    const matchId = id(),
      slots: Slot[] = [],
      leases: Lease[] = [];
    const characters = ["kai", "leo", "ryan", "max", "bruno", "diego"];
    for (let team = 0; team < 2; team++) {
      const profiles = await this.auth.summaries(teams[team]);
      for (let index = 0; index < 3; index++) {
        const slot = team * 3 + index,
          p = profiles[index];
        slots.push({
          slot,
          team,
          playerId: p?.playerId || "",
          nickname: p?.nickname || `BOT ${slot + 1}`,
          characterId: p?.characterId || characters[slot],
          isBot: !p,
        });
        if (p) {
          const reconnectToken = token(),
            ticket = token();
          leases.push({
            playerId: p.playerId,
            slot,
            reconnectHash: hash(reconnectToken),
            active: false,
            joined: false,
            disconnectedAt: 0,
            voluntary: false,
            ticket,
          });
          await set(
            "reconnect-token:" + matchId + ":" + p.playerId,
            reconnectToken,
            config.MATCH_TIMEOUT_SECONDS + 300,
          );
          await set(
            "ticket:" + hash(ticket),
            { matchId, playerId: p.playerId },
            config.JOIN_TICKET_SECONDS,
          );
        }
      }
    }
    const allocation: Allocation = {
      matchId,
      matchSecret: token(),
      serverId: server.serverId,
      region: server.region,
      address: server.address,
      port: server.port,
      slots,
      leases,
      created: Date.now(),
      state: "STARTING",
      queueIds: queues.map((q) => q.queueId),
    };
    await transaction(async (c) => {
      await c.query(
        "INSERT INTO matches(id,server_id,region,mode,state) VALUES($1,$2,$3,$4,'STARTING')",
        [matchId, server.serverId, server.region, mode],
      );
      for (const slot of slots)
        await c.query(
          "INSERT INTO match_participants(match_id,slot,team,player_id,character_id,nickname) VALUES($1,$2,$3,$4,$5,$6)",
          [
            matchId,
            slot.slot,
            slot.team,
            slot.playerId || null,
            slot.characterId,
            slot.nickname,
          ],
        );
    });
    await set(
      "match:" + matchId,
      allocation,
      config.MATCH_TIMEOUT_SECONDS + 3600,
    );
    server.matchId = matchId;
    server.state = "ASSIGNED";
    await set("server:" + server.serverId, server, 86400);
    await redis.sAdd(key("live-matches"), matchId);
    for (const q of queues) {
      q.matchId = matchId;
      await this.closeQueue(q, "CONNECTING");
    }
    for (const lease of leases)
      await redis.set(key("active-match:" + lease.playerId), matchId, {
        EX: config.MATCH_TIMEOUT_SECONDS + 300,
      });
    this.log("match_allocated", {
      matchId,
      serverId: server.serverId,
      humans: leases.length,
    });
    return allocation;
  }
  private async allocation(matchId: string) {
    const a = await get<Allocation>("match:" + matchId);
    if (!a) fail(404, "NOT_FOUND", "Match session expired.");
    await this.reconcileFinal(a);
    return a;
  }
  async internalMatch(matchId: string) {
    const a = await this.allocation(matchId);
    return { matchId, matchSecret: a.matchSecret, slots: a.slots };
  }
  private async trusted(
    matchId: string,
    serverId: string,
    matchSecret: string,
  ) {
    const a = await this.allocation(matchId);
    if (a.serverId !== serverId || !secretEqual(a.matchSecret, matchSecret))
      fail(403, "FORBIDDEN", "Allocation does not belong to this server.");
    return a;
  }
  async connection(playerId: string, matchId: string) {
    const a = await this.allocation(matchId),
      lease = a.leases.find((x) => x.playerId === playerId);
    if (!lease) fail(403, "FORBIDDEN", "Not a participant in this match.");
    let ticket = "";
    if (
      !lease.joined &&
      !lease.voluntary &&
      !["FAILED", "FINISHED"].includes(a.state)
    ) {
      if (!(await redis.exists(key("ticket:" + hash(lease.ticket))))) {
        lease.ticket = token();
        await set(
          "ticket:" + hash(lease.ticket),
          { matchId, playerId },
          config.JOIN_TICKET_SECONDS,
        );
        await set("match:" + matchId, a, config.MATCH_TIMEOUT_SECONDS + 3600);
      }
      ticket = lease.ticket;
    }
    return {
      queueId: "",
      state: ["FAILED", "FINISHED"].includes(a.state)
        ? a.state
        : lease.active
          ? "IN_MATCH"
          : "CONNECTING",
      waitSeconds: 0,
      matchId,
      address: a.address,
      port: a.port,
      region: a.region,
      joinTicket: ticket,
      reconnectToken:
        (await get<string>("reconnect-token:" + matchId + ":" + playerId)) ||
        "",
      slots: a.slots,
      caCertificate: config.caCertificate,
      serverName: config.TRANSPORT_SERVER_NAME,
    };
  }
  async join(
    matchId: string,
    input: {
      serverId: string;
      matchSecret: string;
      joinTicket: string;
      attemptId?: string;
    },
  ) {
    const a = await this.trusted(matchId, input.serverId, input.matchSecret);
    if (["FINISHED", "FAILED"].includes(a.state))
      fail(409, "MATCH_FINISHED", "Match is no longer running.");
    const receiptKey =
      "join-receipt:" + matchId + ":" + (input.attemptId || "");
    if (input.attemptId) {
      const receipt = await get<{ ticketHash: string; reply: any }>(receiptKey);
      if (receipt) {
        const owner = a.leases.find(
          (x) => x.playerId === receipt.reply.playerId,
        );
        if (
          receipt.ticketHash !== hash(input.joinTicket) ||
          !owner?.active ||
          owner.voluntary ||
          owner.connectionId !== input.attemptId
        )
          fail(
            409,
            "STALE_JOIN",
            "This connection attempt is no longer active.",
          );
        return receipt.reply;
      }
    }
    const proof = await get<{ matchId: string; playerId: string }>(
      "ticket:" + hash(input.joinTicket),
    );
    if (!proof || proof.matchId !== matchId)
      fail(401, "INVALID_TICKET", "Join ticket expired or used.");
    const lease = a.leases.find((x) => x.playerId === proof.playerId);
    if (!lease || lease.voluntary || lease.ticket !== input.joinTicket)
      fail(403, "INVALID_TICKET", "Ticket does not own a slot.");
    if (lease.active)
      fail(409, "DUPLICATE_JOIN", "Player is already connected.");
    if (
      lease.joined &&
      (!lease.disconnectedAt ||
        Date.now() - lease.disconnectedAt > config.RECONNECT_SECONDS * 1000)
    )
      fail(403, "RECONNECT_EXPIRED", "Reconnect window expired.");
    const reconnecting = lease.joined;
    // A database failure must leave the ticket and lease untouched, so this attempt can retry.
    await db.query(
      "UPDATE matches SET state='RUNNING' WHERE id=$1 AND state='STARTING'",
      [matchId],
    );
    lease.active = true;
    lease.joined = true;
    lease.disconnectedAt = 0;
    lease.ticket = "";
    lease.connectionId = input.attemptId || "";
    a.state = "RUNNING";
    const slot = a.slots[lease.slot];
    const reply = {
      accepted: true,
      playerId: lease.playerId,
      slot: lease.slot,
      team: slot.team,
      characterId: slot.characterId,
      nickname: slot.nickname,
      reconnecting,
      connectionId: lease.connectionId,
    };
    // Atomic receipt + ticket consume + lease assignment survives a lost HTTP response.
    const commit = redis
      .multi()
      .del(key("ticket:" + hash(input.joinTicket)))
      .set(key("match:" + matchId), JSON.stringify(a), {
        EX: config.MATCH_TIMEOUT_SECONDS + 3600,
      });
    if (input.attemptId)
      commit.set(
        key(receiptKey),
        JSON.stringify({ ticketHash: hash(input.joinTicket), reply }),
        { EX: 120 },
      );
    await commit.exec();
    return reply;
  }
  async disconnect(
    matchId: string,
    input: {
      serverId: string;
      matchSecret: string;
      playerId: string;
      voluntary: boolean;
      connectionId?: string;
    },
  ) {
    const a = await this.trusted(matchId, input.serverId, input.matchSecret);
    if (!input.playerId && !input.connectionId)
      fail(
        400,
        "VALIDATION_ERROR",
        "Player or connection generation is required.",
      );
    const lease = input.playerId
      ? a.leases.find((x) => x.playerId === input.playerId)
      : a.leases.find((x) => x.connectionId === input.connectionId);
    // Retried cleanup for an old attempt must never disconnect a newer replacement client.
    if (
      !lease ||
      (input.connectionId && lease.connectionId !== input.connectionId)
    )
      return { ok: true, reconnectSeconds: 0 };
    lease.active = false;
    if (!lease.disconnectedAt) lease.disconnectedAt = Date.now();
    lease.voluntary = lease.voluntary || input.voluntary;
    await set("match:" + matchId, a, config.MATCH_TIMEOUT_SECONDS + 3600);
    return {
      ok: true,
      reconnectSeconds: lease.voluntary
        ? 0
        : Math.max(
            0,
            config.RECONNECT_SECONDS -
              Math.floor((Date.now() - lease.disconnectedAt) / 1000),
          ),
    };
  }
  async reconnect(playerId: string, matchId: string, reconnectToken: string) {
    const a = await this.allocation(matchId),
      lease = a.leases.find((x) => x.playerId === playerId);
    if (!lease || !secretEqual(lease.reconnectHash, hash(reconnectToken)))
      fail(
        403,
        "FORBIDDEN",
        "Reconnect credential does not own this account and slot.",
      );
    if (["FAILED", "FINISHED"].includes(a.state) || lease.voluntary)
      fail(409, "MATCH_FINISHED", "Reconnect is no longer available.");
    if (lease.active)
      fail(409, "STILL_CONNECTED", "Waiting for previous connection to close.");
    if (
      !lease.joined ||
      !lease.disconnectedAt ||
      Date.now() - lease.disconnectedAt > config.RECONNECT_SECONDS * 1000
    )
      fail(403, "RECONNECT_EXPIRED", "Reconnect window expired.");
    if (lease.ticket) await redis.del(key("ticket:" + hash(lease.ticket)));
    lease.ticket = token();
    await set(
      "ticket:" + hash(lease.ticket),
      { matchId, playerId },
      config.JOIN_TICKET_SECONDS,
    );
    await set("match:" + matchId, a, config.MATCH_TIMEOUT_SECONDS + 3600);
    return {
      ...(await this.connection(playerId, matchId)),
      joinTicket: lease.ticket,
    };
  }
  async leave(playerId: string, matchId: string) {
    const a = await this.allocation(matchId),
      lease = a.leases.find((x) => x.playerId === playerId);
    if (!lease) fail(403, "FORBIDDEN", "Not a participant.");
    lease.voluntary = true;
    lease.active = false;
    if (lease.ticket) await redis.del(key("ticket:" + hash(lease.ticket)));
    await set("match:" + matchId, a, config.MATCH_TIMEOUT_SECONDS + 3600);
    if ((await redis.get(key("active-match:" + playerId))) === matchId)
      await redis.del(key("active-match:" + playerId));
    return { ok: true };
  }
  async createRoom(playerId: string, region: string, characterId?: string) {
    this.region(region);
    await this.auth.available([playerId]);
    const old = await redis.get(key("active-room:" + playerId));
    if (old) {
      const room = await get<Room>("room:" + old);
      if (room && room.members.includes(playerId))
        return this.roomStatus(playerId, old);
    }
    if (characterId)
      await db.query("UPDATE players SET character_id=$2 WHERE id=$1", [
        playerId,
        characterId,
      ]);
    let code = "";
    do {
      code = token()
        .replace(/[^A-Z0-9]/gi, "")
        .slice(0, 6)
        .toUpperCase();
    } while (await redis.exists(key("room:" + code)));
    const room: Room = {
      code,
      leaderId: playerId,
      region,
      members: [playerId],
      state: "READY",
      matchId: "",
      created: Date.now(),
    };
    await set("room:" + code, room, 1800);
    await redis.set(key("active-room:" + playerId), code, { EX: 1800 });
    return this.roomStatus(playerId, code);
  }
  async joinRoom(playerId: string, code: string, characterId: string) {
    const room = await get<Room>("room:" + code);
    if (!room) fail(404, "NOT_FOUND", "Room not found.");
    if (room.state !== "READY")
      fail(409, "ROOM_STARTED", "Room has already started.");
    if (room.members.includes(playerId)) return this.roomStatus(playerId, code);
    await this.auth.available([playerId]);
    if (await redis.exists(key("active-room:" + playerId)))
      fail(409, "ALREADY_IN_ROOM", "Leave your current room first.");
    if (room.members.length >= 6)
      fail(409, "ROOM_FULL", "Room already has six players.");
    room.members.push(playerId);
    await db.query("UPDATE players SET character_id=$2 WHERE id=$1", [
      playerId,
      characterId,
    ]);
    await set("room:" + code, room, 1800);
    await redis.set(key("active-room:" + playerId), code, { EX: 1800 });
    return this.roomStatus(playerId, code);
  }
  async roomStatus(playerId: string, code: string) {
    const r = await get<Room>("room:" + code);
    if (!r) fail(404, "NOT_FOUND", "Room expired.");
    if (!r.members.includes(playerId))
      fail(403, "FORBIDDEN", "Join room first.");
    return {
      code: r.code,
      leaderId: r.leaderId,
      region: r.region,
      state: r.state,
      members: await this.auth.summaries(r.members),
      matchId: r.matchId,
    };
  }
  async startRoom(playerId: string, code: string) {
    const room = await get<Room>("room:" + code);
    if (!room || room.leaderId !== playerId)
      fail(403, "FORBIDDEN", "Only room leader can start.");
    if (room.matchId) return this.roomStatus(playerId, code);
    await this.auth.available(room.members);
    const server = await this.availableServer(room.region);
    if (!server)
      fail(503, "NO_SERVER", "No server available; try again shortly.");
    const teams: string[][] = [[], []];
    for (let i = 0; i < room.members.length; i++)
      teams[i % 2].push(room.members[i]);
    const a = await this.allocate(server, teams, "PRIVATE");
    room.matchId = a.matchId;
    room.state = "CONNECTING";
    await set("room:" + code, room, config.MATCH_TIMEOUT_SECONDS + 300);
    for (const pid of room.members) await redis.del(key("active-room:" + pid));
    return this.roomStatus(playerId, code);
  }
  async leaveRoom(playerId: string, code: string) {
    const room = await get<Room>("room:" + code);
    if (!room || !room.members.includes(playerId))
      fail(404, "NOT_FOUND", "Room not found.");
    if (room.state !== "READY") fail(409, "ROOM_STARTED", "Use leave match.");
    room.members = room.members.filter((x) => x !== playerId);
    await redis.del(key("active-room:" + playerId));
    if (!room.members.length) await redis.del(key("room:" + code));
    else {
      if (room.leaderId === playerId) room.leaderId = room.members[0];
      await set("room:" + code, room, 1800);
    }
    return { ok: true };
  }
  async results(playerId: string, matchId: string) {
    if (
      !(
        await db.query(
          "SELECT 1 FROM match_participants WHERE match_id=$1 AND player_id=$2",
          [matchId, playerId],
        )
      ).rowCount
    )
      fail(403, "FORBIDDEN", "Not a participant.");
    return this.result(matchId);
  }
  private async result(matchId: string) {
    const row = (await db.query("SELECT * FROM matches WHERE id=$1", [matchId]))
      .rows[0];
    if (!row) fail(404, "NOT_FOUND", "Match not found.");
    if (!["FINISHED", "FAILED"].includes(row.state))
      fail(409, "MATCH_NOT_FINISHED", "Match result is not committed yet.");
    return {
      matchId,
      state: row.state,
      blueScore: row.blue_score,
      redScore: row.red_score,
      durationSeconds: row.duration_seconds,
      finishedUtc: row.finished_at?.toISOString() || "",
      participants: (
        await db.query(
          "SELECT p.*,COALESCE(r.coins,0) reward_coins,COALESCE(r.xp,0) reward_xp,COALESCE(r.rating_delta,0) rating_delta FROM match_participants p LEFT JOIN rewards r ON r.match_id=p.match_id AND r.player_id=p.player_id WHERE p.match_id=$1 ORDER BY p.slot",
          [matchId],
        )
      ).rows.map((r) => ({
        playerId: r.player_id || "",
        slot: r.slot,
        goals: r.goals,
        assists: r.assists,
        shots: r.shots,
        passes: r.passes,
        tackles: r.tackles,
        possessionSeconds: r.possession_seconds,
        isMvp: r.is_mvp,
        coins: r.reward_coins,
        xp: r.reward_xp,
        ratingDelta: r.rating_delta,
      })),
    };
  }
  async history(playerId: string) {
    const ids = (
      await db.query(
        "SELECT m.id FROM matches m JOIN match_participants p ON p.match_id=m.id WHERE p.player_id=$1 AND m.state IN('FINISHED','FAILED') ORDER BY m.created_at DESC LIMIT 20",
        [playerId],
      )
    ).rows;
    return { matches: await Promise.all(ids.map((x) => this.result(x.id))) };
  }
  async storeResults(matchId: string, input: any) {
    const a = await this.trusted(matchId, input.serverId, input.matchSecret);
    if (a.state === "FAILED")
      fail(409, "MATCH_FAILED", "Interrupted match cannot award a result.");
    const humans = a.slots.filter((x) => !x.isBot);
    const participants = input.participants
      .filter((x: any) => x.playerId)
      .sort((x: any, y: any) => x.slot - y.slot);
    if (
      participants.length !== humans.length ||
      humans.some(
        (s) =>
          participants.filter(
            (p: any) => p.playerId === s.playerId && p.slot === s.slot,
          ).length !== 1,
      )
    )
      fail(
        400,
        "INVALID_RESULT",
        "Results must contain every allocated human exactly once.",
      );
    if (
      input.participants.some(
        (p: any) =>
          p.goals > input.blueScore + input.redScore ||
          p.possessionSeconds > input.durationSeconds + 1,
      )
    )
      fail(
        400,
        "INVALID_RESULT",
        "Participant statistics exceed match limits.",
      );
    const resultHash = hash(
      JSON.stringify({
        blueScore: input.blueScore,
        redScore: input.redScore,
        durationSeconds: input.durationSeconds,
        participants,
      }),
    );
    await transaction(async (c) => {
      const match = (
        await c.query("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId])
      ).rows[0];
      if (match.result_hash) {
        if (match.result_hash !== resultHash)
          fail(
            409,
            "CONFLICTING_RESULT",
            "A different result has already been committed.",
          );
        return;
      }
      if (match.state === "FAILED")
        fail(409, "MATCH_FAILED", "Interrupted match cannot award a result.");
      await c.query(
        "UPDATE matches SET state='FINISHED',blue_score=$2,red_score=$3,duration_seconds=$4,finished_at=now(),result_hash=$5 WHERE id=$1",
        [
          matchId,
          input.blueScore,
          input.redScore,
          input.durationSeconds,
          resultHash,
        ],
      );
      for (const p of participants) {
        const slot = a.slots[p.slot],
          own = slot.team === 0 ? input.blueScore : input.redScore,
          other = slot.team === 0 ? input.redScore : input.blueScore,
          win = own > other,
          loss = own < other,
          coins = win ? 60 : loss ? 30 : 40,
          xp = win ? 100 : 60,
          delta = win ? 24 : loss ? -16 : 0;
        await c.query(
          "UPDATE match_participants SET goals=$3,assists=$4,shots=$5,passes=$6,tackles=$7,possession_seconds=$8,is_mvp=$9 WHERE match_id=$1 AND player_id=$2",
          [
            matchId,
            p.playerId,
            p.goals,
            p.assists,
            p.shots,
            p.passes,
            p.tackles,
            p.possessionSeconds,
            p.isMvp,
          ],
        );
        await c.query(
          "UPDATE player_stats SET matches=matches+1,wins=wins+$2,losses=losses+$3,draws=draws+$4,goals=goals+$5,assists=assists+$6,mvp_count=mvp_count+$7 WHERE player_id=$1",
          [
            p.playerId,
            win ? 1 : 0,
            loss ? 1 : 0,
            own === other ? 1 : 0,
            p.goals,
            p.assists,
            p.isMvp ? 1 : 0,
          ],
        );
        await c.query(
          "UPDATE ratings SET rating=GREATEST(0,rating+$2) WHERE player_id=$1",
          [p.playerId, delta],
        );
        await c.query(
          "UPDATE balances SET coins=coins+$2,xp=xp+$3 WHERE player_id=$1",
          [p.playerId, coins, xp],
        );
        await c.query(
          "INSERT INTO rewards(match_id,player_id,coins,xp,rating_delta) VALUES($1,$2,$3,$4,$5)",
          [matchId, p.playerId, coins, xp, delta],
        );
      }
    });
    a.state = "FINISHED";
    await this.closeMatch(a);
    this.log("match_finished", {
      matchId,
      blueScore: input.blueScore,
      redScore: input.redScore,
    });
    return { stored: true };
  }
  private async closeMatch(a: Allocation) {
    await set("match:" + a.matchId, a, 3600);
    await redis.sRem(key("live-matches"), a.matchId);
    for (const l of a.leases) {
      if ((await redis.get(key("active-match:" + l.playerId))) === a.matchId)
        await redis.del(key("active-match:" + l.playerId));
      if (l.ticket) await redis.del(key("ticket:" + hash(l.ticket)));
      await redis.del(key("reconnect-token:" + a.matchId + ":" + l.playerId));
    }
    const server = await get<Server>("server:" + a.serverId);
    if (server?.matchId === a.matchId) {
      server.matchId = "";
      server.state = "FINISHED";
      await set("server:" + server.serverId, server, 86400);
    }
  }
  private async reconcileFinal(a: Allocation) {
    const row = (
      await db.query("SELECT state FROM matches WHERE id=$1", [a.matchId])
    ).rows[0];
    if (row && ["FINISHED", "FAILED"].includes(row.state)) {
      a.state = row.state;
      await this.closeMatch(a);
    }
  }
  private async failMatch(matchId: string, reason: string) {
    const a = await get<Allocation>("match:" + matchId);
    if (!a) return;
    await this.reconcileFinal(a);
    if (["FINISHED", "FAILED"].includes(a.state)) return;
    const changed = await db.query(
      "UPDATE matches SET state='FAILED',finished_at=now() WHERE id=$1 AND state NOT IN('FINISHED','FAILED') RETURNING state",
      [matchId],
    );
    if (!changed.rowCount) {
      await this.reconcileFinal(a);
      return;
    }
    a.state = "FAILED";
    await this.closeMatch(a);
    this.log("match_failed", { matchId, reason });
  }
  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await lock(async () => {
        const now = Date.now();
        for (const mid of await redis.sMembers(key("live-matches"))) {
          const a = await get<Allocation>("match:" + mid);
          if (!a) {
            await redis.sRem(key("live-matches"), mid);
            continue;
          }
          const server = await get<Server>("server:" + a.serverId);
          if (
            now - this.bootedAt > config.SERVER_TIMEOUT_SECONDS * 1000 &&
            (!server ||
              now - server.lastSeen > config.SERVER_TIMEOUT_SECONDS * 1000)
          )
            await this.failMatch(mid, "SERVER_TIMEOUT");
          else if (now - a.created > config.MATCH_TIMEOUT_SECONDS * 1000)
            await this.failMatch(mid, "MATCH_TIMEOUT");
        }
        const queued: Queue[] = [];
        for (const qid of await redis.zRange(key("queues"), 0, 199)) {
          const q = await get<Queue>("queue:" + qid);
          if (!q || q.state !== "SEARCHING") {
            await redis.zRem(key("queues"), qid);
            continue;
          }
          if (now - q.created > config.QUEUE_TIMEOUT_SECONDS * 1000) {
            await this.closeQueue(q, "FAILED");
            continue;
          }
          queued.push(q);
        }
        const used = new Set<string>();
        for (const first of queued) {
          if (used.has(first.queueId)) continue;
          const server = await this.availableServer(first.region);
          if (!server) continue;
          const teams: string[][] = [[], []],
            ratings = [0, 0],
            selected: Queue[] = [];
          for (const candidate of queued) {
            if (
              used.has(candidate.queueId) ||
              candidate.region !== first.region
            )
              continue;
            const elapsed = (now - first.created) / 1000;
            if (
              candidate !== first &&
              (Math.abs(candidate.rating - first.rating) > 200 + elapsed * 30 ||
                Math.abs(candidate.rttMs - first.rttMs) > 80 + elapsed * 15)
            )
              continue;
            const fits = [0, 1].filter(
              (t) => teams[t].length + candidate.members.length <= 3,
            );
            if (!fits.length) continue;
            fits.sort(
              (x, y) =>
                teams[x].length - teams[y].length || ratings[x] - ratings[y],
            );
            const t = fits[0];
            teams[t].push(...candidate.members);
            ratings[t] += candidate.rating * candidate.members.length;
            selected.push(candidate);
            if (teams[0].length + teams[1].length === 6) break;
          }
          if (
            teams[0].length + teams[1].length < 6 &&
            now - first.created < config.BOT_FILL_SECONDS * 1000
          )
            continue;
          for (const q of selected) used.add(q.queueId);
          await this.allocate(server, teams, "QUICK", selected);
        }
      });
    } catch (error) {
      this.log("lifecycle_error", {
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      this.ticking = false;
    }
  }
  async metrics() {
    return {
      queued: await redis.zCard(key("queues")),
      liveMatches: await redis.sCard(key("live-matches")),
      registeredServers: await redis.sCard(key("servers")),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
  private log(event: string, data: object) {
    process.stdout.write(
      JSON.stringify({ level: "info", event, ...data }) + "\n",
    );
  }
}
