import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Header,
} from "@nestjs/common";
import { Request } from "express";
import { z } from "zod";
import { config } from "./config";
import { db, redis, key } from "./db";
import { privacyPage, supportPage } from "./public-pages";
import { AuthService } from "./auth";
import { SocialService } from "./social";
import { MatchesService } from "./matches";
import { character, nickname, uuid, region, parse, lock, fail } from "./common";
const strict = <T extends z.ZodRawShape>(fields: T) => z.strictObject(fields);
const guest = strict({ nickname, characterId: character });
const secret = z.string().min(24).max(256);
const serverId = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/);
const trusted = { serverId, matchSecret: secret };
const participant = strict({
  playerId: z.union([uuid, z.literal("")]),
  slot: z.number().int().min(0).max(5),
  goals: z.number().int().min(0).max(100),
  assists: z.number().int().min(0).max(100),
  shots: z.number().int().min(0).max(1000),
  passes: z.number().int().min(0).max(2000),
  tackles: z.number().int().min(0).max(2000),
  possessionSeconds: z.number().min(0).max(3600),
  isMvp: z.boolean(),
});
@Controller()
export class ApiController {
  constructor(
    private readonly auth: AuthService,
    private readonly social: SocialService,
    private readonly matches: MatchesService,
  ) {}
  @Get("health") async health() {
    let postgres = false,
      redisOk = false;
    try {
      await db.query("SELECT 1");
      postgres = true;
    } catch {}
    try {
      redisOk = (await redis.ping()) === "PONG";
    } catch {}
    if (!postgres || !redisOk)
      fail(503, "SERVICE_UNAVAILABLE", "Database health check failed.");
    return { status: "ok", postgres, redis: redisOk };
  }
  @Get("v1/regions") regions() {
    return { regions: config.regions };
  }
  @Get("v1/ping") ping(@Query("region") selected?: string) {
    const value = selected || config.regions[0].id;
    if (!config.regions.some((x) => x.id === value))
      fail(400, "VALIDATION_ERROR", "Unknown region.");
    return { region: value, serverTimeUtc: new Date().toISOString() };
  }
  @Post("v1/auth/guest") guest(@Body() body: unknown) {
    const b = parse(guest, body);
    return this.auth.guest(b.nickname, b.characterId);
  }
  @Post("v1/auth/refresh") refresh(@Body() body: unknown) {
    const token = parse(strict({ refreshToken: secret }), body).refreshToken;
    return lock(() => this.auth.refresh(token));
  }
  @Get("privacy") @Header("Content-Type", "text/html; charset=utf-8") privacy() { return privacyPage; }
  @Get("support") @Header("Content-Type", "text/html; charset=utf-8") support() { return supportPage; }
  @Delete("v1/me") async deleteAccount(@Req() req: Request) {
    return lock(async () => {
      if (await this.auth.wasDeleted(req)) return {ok:true};
      const pid=await this.auth.auth(req);
      const unfinished=await db.query("SELECT 1 FROM match_participants p JOIN matches m ON m.id=p.match_id WHERE p.player_id=$1 AND m.state NOT IN ('FINISHED','FAILED') LIMIT 1",[pid]);
      if(unfinished.rowCount) fail(409,"MATCH_FINISHING","Your online match is still finishing. Retry when it has ended.");
      const queue=await redis.get(key("active-queue:"+pid));
      if(queue) await this.matches.cancel(pid,queue);
      const room=await redis.get(key("active-room:"+pid));
      if(room) await this.matches.leaveRoom(pid,room);
      return this.auth.deleteAccount(pid);
    });
  }
  @Get("v1/me") async me(@Req() req: Request) {
    return this.auth.me(await this.auth.auth(req));
  }
  @Patch("v1/me") async profile(@Req() req: Request, @Body() body: unknown) {
    const pid = await this.auth.auth(req),
      b = parse(guest, body);
    return lock(() => this.auth.profile(pid, b.nickname, b.characterId));
  }
  @Post("v1/presence") async presence(@Req() req: Request) {
    const pid = await this.auth.auth(req);
    return { status: await this.auth.status(pid) };
  }
  @Get("v1/players") async players(
    @Req() req: Request,
    @Query("search") query: unknown,
  ) {
    await this.auth.auth(req);
    return this.auth.search(parse(z.string().trim().min(2).max(24), query));
  }
  @Get("v1/leaderboard") async leaderboard(@Req() req: Request) {
    await this.auth.auth(req);
    return this.auth.leaderboard();
  }
  @Get("v1/history") async history(@Req() req: Request) {
    return this.matches.history(await this.auth.auth(req));
  }
  @Get("v1/friends") async friends(@Req() req: Request) {
    return this.social.friends(await this.auth.auth(req));
  }
  @Post("v1/friends/requests") async friendRequest(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ playerId: uuid }), body);
    return lock(() => this.social.request(pid, b.playerId));
  }
  @Post("v1/friends/requests/:playerId/respond") async friendRespond(
    @Req() req: Request,
    @Param("playerId") requester: string,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ accept: z.boolean() }), body);
    parse(uuid, requester);
    return lock(() => this.social.respond(pid, requester, b.accept));
  }
  @Delete("v1/friends/:playerId") async removeFriend(
    @Req() req: Request,
    @Param("playerId") target: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, target);
    return lock(() => this.social.removeFriend(pid, target));
  }
  @Get("v1/party") async party(@Req() req: Request) {
    return this.social.party(await this.auth.auth(req));
  }
  @Post("v1/party") async createParty(@Req() req: Request) {
    const pid = await this.auth.auth(req);
    return lock(() => this.social.createParty(pid));
  }
  @Post("v1/party/invites") async invite(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ playerId: uuid }), body);
    return lock(() => this.social.invite(pid, b.playerId));
  }
  @Post("v1/party/invites/:partyId/respond") async respondInvite(
    @Req() req: Request,
    @Param("partyId") partyId: string,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ accept: z.boolean() }), body);
    parse(uuid, partyId);
    return lock(() => this.social.respondInvite(pid, partyId, b.accept));
  }
  @Delete("v1/party/members/:playerId") async removeMember(
    @Req() req: Request,
    @Param("playerId") target: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, target);
    return lock(() => this.social.removeMember(pid, target));
  }
  @Post("v1/matchmaking") async queue(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(
        strict({
          region,
          rttMs: z.number().min(0).max(2000),
          characterId: character,
          partyId: z.union([uuid, z.literal("")]).optional(),
        }),
        body,
      );
    return lock(() => this.matches.queue(pid, b));
  }
  @Get("v1/matchmaking/:queueId") async queueStatus(
    @Req() req: Request,
    @Param("queueId") queueId: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, queueId);
    return lock(() => this.matches.queueStatus(pid, queueId));
  }
  @Delete("v1/matchmaking/:queueId") async cancel(
    @Req() req: Request,
    @Param("queueId") queueId: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, queueId);
    return lock(() => this.matches.cancel(pid, queueId));
  }
  @Post("v1/rooms") async createRoom(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ region, characterId: character.optional() }), body);
    return lock(() => this.matches.createRoom(pid, b.region, b.characterId));
  }
  @Post("v1/rooms/join") async joinRoom(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ code, characterId: character }), body);
    return lock(() => this.matches.joinRoom(pid, b.code, b.characterId));
  }
  @Get("v1/rooms/:code") async room(
    @Req() req: Request,
    @Param("code") roomCode: string,
  ) {
    const pid = await this.auth.auth(req);
    return this.matches.roomStatus(pid, parse(code, roomCode));
  }
  @Post("v1/rooms/:code/start") async start(
    @Req() req: Request,
    @Param("code") roomCode: string,
  ) {
    const pid = await this.auth.auth(req);
    return lock(() => this.matches.startRoom(pid, parse(code, roomCode)));
  }
  @Delete("v1/rooms/:code") async leaveRoom(
    @Req() req: Request,
    @Param("code") roomCode: string,
  ) {
    const pid = await this.auth.auth(req);
    return lock(() => this.matches.leaveRoom(pid, parse(code, roomCode)));
  }
  @Get("v1/matches/:matchId/join") async allocation(
    @Req() req: Request,
    @Param("matchId") matchId: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, matchId);
    return lock(() => this.matches.connection(pid, matchId));
  }
  @Post("v1/matches/:matchId/reconnect") async reconnect(
    @Req() req: Request,
    @Param("matchId") matchId: string,
    @Body() body: unknown,
  ) {
    const pid = await this.auth.auth(req),
      b = parse(strict({ reconnectToken: secret }), body);
    parse(uuid, matchId);
    return lock(() => this.matches.reconnect(pid, matchId, b.reconnectToken));
  }
  @Post("v1/matches/:matchId/leave") async leave(
    @Req() req: Request,
    @Param("matchId") matchId: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, matchId);
    return lock(() => this.matches.leave(pid, matchId));
  }
  @Get("v1/matches/:matchId/results") async results(
    @Req() req: Request,
    @Param("matchId") matchId: string,
  ) {
    const pid = await this.auth.auth(req);
    parse(uuid, matchId);
    return this.matches.results(pid, matchId);
  }
  @Post("internal/servers/register") async register(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    this.auth.internal(req);
    const b = parse(
      strict({
        serverId,
        region,
        address: z.string().regex(/^[A-Za-z0-9.:-]{1,253}$/),
        port: z.number().int().min(1).max(65535),
        buildId: z.string().min(1).max(80),
      }),
      body,
    );
    return lock(() => this.matches.register(b));
  }
  @Post("internal/servers/:serverId/heartbeat") async heartbeat(
    @Req() req: Request,
    @Param("serverId") sid: string,
    @Body() body: unknown,
  ) {
    this.auth.internal(req);
    parse(serverId, sid);
    const b = parse(
      strict({ state: z.enum(["IDLE", "ASSIGNED", "RUNNING", "FINISHED"]) }),
      body,
    );
    return lock(() => this.matches.heartbeat(sid, b.state));
  }
  @Post("internal/servers/:serverId/shutdown") async shutdown(
    @Req() req: Request,
    @Param("serverId") sid: string,
  ) {
    this.auth.internal(req);
    parse(serverId, sid);
    return lock(() => this.matches.shutdown(sid));
  }
  @Get("internal/matches/:matchId") async internalMatch(
    @Req() req: Request,
    @Param("matchId") matchId: string,
  ) {
    this.auth.internal(req);
    parse(uuid, matchId);
    return this.matches.internalMatch(matchId);
  }
  @Post("internal/matches/:matchId/join") async validateJoin(
    @Req() req: Request,
    @Param("matchId") matchId: string,
    @Body() body: unknown,
  ) {
    this.auth.internal(req);
    parse(uuid, matchId);
    const b = parse(
      strict({ ...trusted, joinTicket: secret, attemptId: uuid.optional() }),
      body,
    );
    return lock(() => this.matches.join(matchId, b));
  }
  @Post("internal/matches/:matchId/disconnect") async disconnect(
    @Req() req: Request,
    @Param("matchId") matchId: string,
    @Body() body: unknown,
  ) {
    this.auth.internal(req);
    parse(uuid, matchId);
    const b = parse(
      strict({
        ...trusted,
        playerId: z.union([uuid, z.literal("")]),
        voluntary: z.boolean(),
        connectionId: uuid.optional(),
      }),
      body,
    );
    return lock(() => this.matches.disconnect(matchId, b));
  }
  @Post("internal/matches/:matchId/results") async saveResults(
    @Req() req: Request,
    @Param("matchId") matchId: string,
    @Body() body: unknown,
  ) {
    this.auth.internal(req);
    parse(uuid, matchId);
    const b = parse(
      strict({
        ...trusted,
        blueScore: z.number().int().min(0).max(100),
        redScore: z.number().int().min(0).max(100),
        durationSeconds: z.number().min(0).max(3600),
        participants: z.array(participant).max(6),
      }),
      body,
    );
    return lock(() => this.matches.storeResults(matchId, b));
  }
  @Get("internal/metrics") metrics(@Req() req: Request) {
    this.auth.internal(req);
    return this.matches.metrics();
  }
}
