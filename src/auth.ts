import { Injectable } from "@nestjs/common";
import { Request } from "express";
import { db, redis, key, get, set, transaction } from "./db";
import { config } from "./config";
import { fail, hash, id, token, rank, secretEqual } from "./common";
@Injectable()
export class AuthService {
  async guest(nickname: string, characterId: string) {
    const playerId = id();
    return transaction(async (c) => {
      await c.query(
        "INSERT INTO players(id,nickname,character_id) VALUES($1,$2,$3)",
        [playerId, nickname, characterId],
      );
      await c.query("INSERT INTO player_stats(player_id) VALUES($1)", [
        playerId,
      ]);
      await c.query("INSERT INTO ratings(player_id) VALUES($1)", [playerId]);
      await c.query("INSERT INTO balances(player_id) VALUES($1)", [playerId]);
      const refreshToken = token();
      await c.query(
        "INSERT INTO guest_refresh(token_hash,player_id,expires_at) VALUES($1,$2,now()+$3::int*interval '1 day')",
        [hash(refreshToken), playerId, config.REFRESH_TOKEN_DAYS],
      );
      return this.session(playerId, refreshToken);
    });
  }
  private async session(playerId: string, refreshToken: string) {
    const accessToken = token();
    await redis.set(key("access:" + hash(accessToken)), playerId, {
      EX: config.ACCESS_TOKEN_SECONDS,
    });
    return {
      playerId,
      accessToken,
      refreshToken,
      expiresIn: config.ACCESS_TOKEN_SECONDS,
    };
  }
  async refresh(refreshToken: string) {
    return transaction(async (c) => {
      const previous = hash(refreshToken);
      const r = await c.query(
        "SELECT * FROM guest_refresh WHERE token_hash=$1 AND expires_at>now() FOR UPDATE",
        [previous],
      );
      if (!r.rowCount) fail(401, "UNAUTHENTICATED", "Guest session expired.");
      if (r.rows[0].revoked_at) {
        const retry = await get<{ playerId: string; refreshToken: string }>(
          "refresh-retry:" + previous,
        );
        if (retry) return this.session(retry.playerId, retry.refreshToken);
        fail(401, "UNAUTHENTICATED", "Guest session expired.");
      }
      const next = token(),
        playerId = r.rows[0].player_id;
      await c.query(
        "UPDATE guest_refresh SET revoked_at=now() WHERE token_hash=$1",
        [previous],
      );
      await c.query(
        "INSERT INTO guest_refresh(token_hash,player_id,expires_at) VALUES($1,$2,now()+$3::int*interval '1 day')",
        [hash(next), playerId, config.REFRESH_TOKEN_DAYS],
      );
      await set(
        "refresh-retry:" + previous,
        { playerId, refreshToken: next },
        60,
      );
      return this.session(playerId, next);
    });
  }
  async auth(req: Request) {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer "))
      fail(401, "UNAUTHENTICATED", "Sign in first.");
    const playerId = await redis.get(
      key("access:" + hash(authorization.slice(7))),
    );
    if (!playerId) fail(401, "UNAUTHENTICATED", "Session expired.");
    await redis.set(key("presence:" + playerId), "1", { EX: 45 });
    return playerId;
  }
  internal(req: Request) {
    const supplied = req.headers.authorization?.slice(7) || "";
    if (
      !req.headers.authorization?.startsWith("Bearer ") ||
      !secretEqual(supplied, config.GAME_SERVER_SECRET)
    )
      fail(401, "UNAUTHENTICATED", "Server authentication required.");
  }
  async status(playerId: string) {
    return (await redis.exists(key("active-match:" + playerId)))
      ? "IN_MATCH"
      : (await redis.exists(key("presence:" + playerId)))
        ? "ONLINE"
        : "OFFLINE";
  }
  async summary(row: any) {
    return {
      playerId: row.id,
      nickname: row.nickname,
      characterId: row.character_id,
      rank: rank(Number(row.rating ?? 1000)),
      rating: Number(row.rating ?? 1000),
      status: await this.status(row.id),
    };
  }
  async summaries(ids: string[]) {
    if (!ids.length) return [];
    const rows = (
      await db.query(
        "SELECT p.*,r.rating FROM players p JOIN ratings r ON r.player_id=p.id WHERE p.id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    return Promise.all(
      ids
        .map((x) => rows.find((r) => r.id === x))
        .filter(Boolean)
        .map((x) => this.summary(x)),
    );
  }
  async me(playerId: string) {
    const r = await db.query(
      "SELECT p.*,r.rating,s.matches,s.wins,s.losses,s.draws,s.goals,s.assists,s.mvp_count,b.coins,b.xp FROM players p JOIN ratings r ON r.player_id=p.id JOIN player_stats s ON s.player_id=p.id JOIN balances b ON b.player_id=p.id WHERE p.id=$1",
      [playerId],
    );
    if (!r.rowCount) fail(401, "UNAUTHENTICATED", "Account not found.");
    const row = r.rows[0];
    return {
      ...(await this.summary(row)),
      activeMatchId: (await redis.get(key("active-match:" + playerId))) || "",
      activeQueueId: (await redis.get(key("active-queue:" + playerId))) || "",
      level: 1 + Math.floor(row.xp / 500),
      coins: row.coins,
      xp: row.xp,
      matches: row.matches,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      goals: row.goals,
      assists: row.assists,
      mvpCount: row.mvp_count,
    };
  }
  async profile(playerId: string, nickname: string, characterId: string) {
    if (await redis.exists(key("active-match:" + playerId)))
      fail(409, "IN_MATCH", "Change character after the match.");
    await db.query(
      "UPDATE players SET nickname=$2,character_id=$3 WHERE id=$1",
      [playerId, nickname, characterId],
    );
    return this.me(playerId);
  }
  async available(ids: string[]) {
    for (const playerId of ids) {
      if (await redis.exists(key("active-match:" + playerId)))
        fail(409, "IN_MATCH", "A player is already in a match.");
      if (await redis.exists(key("active-queue:" + playerId)))
        fail(409, "ALREADY_QUEUED", "A player is already searching.");
    }
  }
  async search(search: string) {
    const rows = (
      await db.query(
        "SELECT p.*,r.rating FROM players p JOIN ratings r ON r.player_id=p.id WHERE p.nickname ILIKE $1 ESCAPE '\\' ORDER BY p.nickname LIMIT 20",
        [search.replace(/[\\%_]/g, "\\$&") + "%"],
      )
    ).rows;
    return { players: await Promise.all(rows.map((r) => this.summary(r))) };
  }
  async leaderboard() {
    return {
      players: await Promise.all(
        (
          await db.query(
            "SELECT p.*,r.rating FROM players p JOIN ratings r ON r.player_id=p.id ORDER BY r.rating DESC,p.created_at LIMIT 50",
          )
        ).rows.map((x) => this.summary(x)),
      ),
    };
  }
}
