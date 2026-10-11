import { Injectable } from "@nestjs/common";
import { db, transaction } from "./db";
import { AuthService } from "./auth";
import { fail, id } from "./common";
@Injectable()
export class SocialService {
  constructor(private readonly auth: AuthService) {}
  async friends(playerId: string) {
    const [relationships, matches] = await Promise.all([
      db.query("SELECT * FROM friendships WHERE requester_id=$1 OR recipient_id=$1", [playerId]),
      db.query("SELECT other.player_id,max(m.created_at) last_played FROM match_participants mine JOIN matches m ON m.id=mine.match_id JOIN match_participants other ON other.match_id=mine.match_id WHERE mine.player_id=$1 AND other.player_id IS NOT NULL AND other.player_id<>$1 AND m.created_at>now()-interval '30 days' GROUP BY other.player_id ORDER BY last_played DESC LIMIT 20", [playerId])
    ]);
    const rows = relationships.rows;
    const ids = (state: string, incoming = false) => rows.filter(r => r.state===state && (!incoming || r.recipient_id===playerId)).map(r => r.requester_id===playerId ? r.recipient_id : r.requester_id);
    const friends=ids("ACCEPTED"), requests=ids("PENDING",true), sent=rows.filter(r=>r.state==="PENDING" && r.requester_id===playerId).map(r=>r.recipient_id), recent=matches.rows.map(r=>r.player_id);
    const summaries=await this.auth.summaries([...new Set([...friends,...requests,...sent,...recent])]);
    const lookup=new Map(summaries.map(p=>[p.playerId,p]));
    const select=(ids:string[])=>ids.map(id=>lookup.get(id)).filter(Boolean);
    return {friends:select(friends),requests:select(requests),sent:select(sent),recent:select(recent)};
  }
  // Sorted row locks serialize just these two users, rather than every match in the game.
  private async friendship<T>(playerId:string,target:string,fn:(c:import("pg").PoolClient)=>Promise<T>) {
    if(playerId===target)fail(400,"VALIDATION_ERROR","Cannot add yourself.");
    return transaction(async c=>{
      const users=await c.query("SELECT id FROM players WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",[[playerId,target]]);
      if(users.rowCount!==2)fail(404,"NOT_FOUND","Player not found.");
      return fn(c);
    });
  }
  async request(playerId: string, target: string) {
    return this.friendship(playerId,target,async c=>{
      const existing=(await c.query("SELECT * FROM friendships WHERE (requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1)",[playerId,target])).rows[0];
      if(existing)return {ok:true,relationship:existing.state==="ACCEPTED"?"accepted":existing.requester_id===playerId?"pending_sent":"pending_received"};
      const counts=(await c.query("SELECT p.id,count(f.requester_id)::integer count FROM players p LEFT JOIN friendships f ON f.requester_id=p.id OR f.recipient_id=p.id WHERE p.id=ANY($1::uuid[]) GROUP BY p.id",[[playerId,target]])).rows;
      if(counts.some(r=>r.count>=100))fail(409,"FRIEND_LIMIT","Friend limit reached.");
      await c.query("INSERT INTO friendships(requester_id,recipient_id,state) VALUES($1,$2,'PENDING')",[playerId,target]);
      return {ok:true,relationship:"pending_sent"};
    });
  }
  async respond(playerId: string, requester: string, accept: boolean) {
    return this.friendship(playerId,requester,async c=>{
      if(accept)await c.query("UPDATE friendships SET state='ACCEPTED' WHERE requester_id=$1 AND recipient_id=$2 AND state='PENDING'",[requester,playerId]);
      else await c.query("DELETE FROM friendships WHERE requester_id=$1 AND recipient_id=$2 AND state='PENDING'",[requester,playerId]);
      return {ok:true};
    });
  }
  async removeFriend(playerId: string, target: string) {
    return this.friendship(playerId,target,async c=>{
      await c.query("DELETE FROM friendships WHERE (requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1)",[playerId,target]);
      return {ok:true};
    });
  }
  async party(playerId: string) {
    const own = (
      await db.query(
        "SELECT p.* FROM parties p JOIN party_memberships m ON m.party_id=p.id WHERE m.player_id=$1",
        [playerId],
      )
    ).rows[0];
    const invites = (
      await db.query(
        "SELECT i.party_id,p.leader_id,u.nickname FROM party_invites i JOIN parties p ON p.id=i.party_id JOIN players u ON u.id=p.leader_id WHERE i.player_id=$1 AND i.expires_at>now()",
        [playerId],
      )
    ).rows.map((r) => ({
      partyId: r.party_id,
      leaderId: r.leader_id,
      nickname: r.nickname,
    }));
    const members = own
      ? (
          await db.query(
            "SELECT player_id FROM party_memberships WHERE party_id=$1 ORDER BY joined_at,player_id",
            [own.id],
          )
        ).rows.map((r) => r.player_id)
      : [];
    return {
      partyId: own?.id || "",
      leaderId: own?.leader_id || "",
      members: await this.auth.summaries(members),
      invites,
    };
  }
  async createParty(playerId: string) {
    const current = await this.party(playerId);
    if (current.partyId) return current;
    await this.auth.available([playerId]);
    await transaction(async (c) => {
      const partyId = id();
      await c.query("INSERT INTO parties(id,leader_id) VALUES($1,$2)", [
        partyId,
        playerId,
      ]);
      await c.query(
        "INSERT INTO party_memberships(party_id,player_id) VALUES($1,$2)",
        [partyId, playerId],
      );
    });
    return this.party(playerId);
  }
  async invite(playerId: string, target: string) {
    const p = await this.party(playerId);
    if (!p.partyId || p.leaderId !== playerId)
      fail(403, "FORBIDDEN", "Only party leader can invite.");
    await this.auth.available(p.members.map((x) => x.playerId));
    if (p.members.length >= 3)
      fail(409, "PARTY_FULL", "Party already has three members.");
    if (
      !(
        await db.query(
          "SELECT 1 FROM friendships WHERE state='ACCEPTED' AND ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))",
          [playerId, target],
        )
      ).rowCount
    )
      fail(403, "FORBIDDEN", "Invite an accepted friend.");
    await db.query(
      "INSERT INTO party_invites(party_id,player_id) VALUES($1,$2) ON CONFLICT(party_id,player_id) DO UPDATE SET expires_at=now()+interval '10 minutes'",
      [p.partyId, target],
    );
    return { ok: true };
  }
  async respondInvite(playerId: string, partyId: string, accept: boolean) {
    if (!accept) {
      await db.query(
        "DELETE FROM party_invites WHERE party_id=$1 AND player_id=$2",
        [partyId, playerId],
      );
      return this.party(playerId);
    }
    await this.auth.available([playerId]);
    await transaction(async (c) => {
      const party = (
        await c.query("SELECT * FROM parties WHERE id=$1 FOR UPDATE", [partyId])
      ).rows[0];
      if (!party) fail(404, "NOT_FOUND", "Party no longer exists.");
      if (
        !(
          await c.query(
            "SELECT 1 FROM party_invites WHERE party_id=$1 AND player_id=$2 AND expires_at>now()",
            [partyId, playerId],
          )
        ).rowCount
      )
        fail(403, "FORBIDDEN", "Invitation expired.");
      const members = (
        await c.query(
          "SELECT player_id FROM party_memberships WHERE party_id=$1",
          [partyId],
        )
      ).rows.map((r) => r.player_id);
      await this.auth.available(members);
      if (members.length >= 3)
        fail(409, "PARTY_FULL", "Party already has three members.");
      if (
        (
          await c.query("SELECT 1 FROM party_memberships WHERE player_id=$1", [
            playerId,
          ])
        ).rowCount
      )
        fail(409, "ALREADY_IN_PARTY", "Leave your current party first.");
      await c.query(
        "INSERT INTO party_memberships(party_id,player_id) VALUES($1,$2)",
        [partyId, playerId],
      );
      await c.query("DELETE FROM party_invites WHERE player_id=$1", [playerId]);
    });
    return this.party(playerId);
  }
  async removeMember(playerId: string, target: string) {
    const party = await this.party(playerId);
    if (
      !party.partyId ||
      !party.members.some((m) => m.playerId === target) ||
      (playerId !== target && party.leaderId !== playerId)
    )
      fail(403, "FORBIDDEN", "Cannot remove this player.");
    await this.auth.available(party.members.map((x) => x.playerId));
    await transaction(async (c) => {
      await c.query(
        "DELETE FROM party_memberships WHERE party_id=$1 AND player_id=$2",
        [party.partyId, target],
      );
      const left = (
        await c.query(
          "SELECT player_id FROM party_memberships WHERE party_id=$1 ORDER BY joined_at,player_id",
          [party.partyId],
        )
      ).rows;
      if (!left.length)
        await c.query("DELETE FROM parties WHERE id=$1", [party.partyId]);
      else if (target === party.leaderId)
        await c.query("UPDATE parties SET leader_id=$2 WHERE id=$1", [
          party.partyId,
          left[0].player_id,
        ]);
    });
    return this.party(playerId);
  }
}
