import { PoolClient } from "pg";
import { db, transaction } from "./db";
import { fail } from "./common";
export const starters = ["char:kai", "char:leo", "char:ryan", "skin:classic"];
export const catalog: Record<string, { price: number; gems?: boolean }> = {
  "char:kai":{price:0},"char:leo":{price:0},"char:ryan":{price:0},
  "char:bruno":{price:5000},"char:max":{price:8500},"char:diego":{price:10000},
  "skin:classic":{price:0},"skin:galaxy":{price:75,gems:true},"skin:sunset":{price:500},
  "emote:wave":{price:250},"emote:victory":{price:900},"emote:legend":{price:1000,gems:true},
};
export async function initializeInventory(c:PoolClient, playerId:string) {
  for(const item of starters)await c.query("INSERT INTO inventory(player_id,item_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[playerId,item]);
}
export async function requireOwned(playerId:string,item:string) {
  if(!(await db.query("SELECT 1 FROM inventory WHERE player_id=$1 AND item_id=$2",[playerId,item])).rowCount)
    fail(403,"ITEM_LOCKED","Unlock this item in the shop first.");
}
export async function buy(playerId:string,itemId:string) {
  const item=catalog[itemId];if(!item)fail(404,"ITEM_UNAVAILABLE","Item unavailable.");
  await transaction(async c=>{
    const balance=(await c.query("SELECT * FROM balances WHERE player_id=$1 FOR UPDATE",[playerId])).rows[0];
    if(!balance)fail(401,"UNAUTHENTICATED","Sign in again.");
    if((await c.query("SELECT 1 FROM inventory WHERE player_id=$1 AND item_id=$2",[playerId,itemId])).rowCount)return;
    const currency=item.gems?"gems":"coins";
    if(balance[currency]<item.price)fail(409,"INSUFFICIENT_FUNDS",`Not enough ${currency}.`);
    await c.query(`UPDATE balances SET ${currency}=${currency}-$2 WHERE player_id=$1`,[playerId,item.price]);
    await c.query("INSERT INTO inventory(player_id,item_id) VALUES($1,$2)",[playerId,itemId]);
  });
}
export async function selectItem(playerId:string,itemId:string) {
  if(!catalog[itemId])fail(404,"ITEM_UNAVAILABLE","Item unavailable.");
  await requireOwned(playerId,itemId);
  const column=itemId.startsWith("char:")?"character_id":itemId.startsWith("skin:")?"selected_skin":"selected_emote";
  await db.query(`UPDATE players SET ${column}=$2 WHERE id=$1`,[playerId,column==="character_id"?itemId.slice(5):itemId]);
}
export const quests=[
 {id:"welcome",metric:"visit",target:1,coins:75,xp:25,weekly:false},
 {id:"match",metric:"matches",target:1,coins:120,xp:80,weekly:false},
 {id:"goals",metric:"goals",target:2,coins:150,xp:100,weekly:false},
 {id:"daily_assist",metric:"assists",target:1,coins:80,xp:60,weekly:false},
 {id:"five",metric:"matches",target:5,coins:500,xp:300,weekly:true},
 {id:"wins",metric:"wins",target:3,coins:600,xp:400,weekly:true},
 {id:"weekly_goals",metric:"goals",target:8,coins:200,xp:160,weekly:true},
 {id:"weekly_assists",metric:"assists",target:5,coins:200,xp:160,weekly:true},
];
export async function questState(playerId:string, c:PoolClient|typeof db=db) {
  const rows=[];
  for(const q of quests){
    const period=q.weekly?"week":"day";
    const data=(await c.query(`SELECT (date_trunc('${period}',now() AT TIME ZONE 'UTC'))::date::text period,
      count(*)::int matches,coalesce(sum(p.goals),0)::int goals,coalesce(sum(p.assists),0)::int assists,
      count(*) FILTER (WHERE (p.team=0 AND m.blue_score>m.red_score) OR (p.team=1 AND m.red_score>m.blue_score))::int wins
      FROM matches m JOIN match_participants p ON p.match_id=m.id WHERE p.player_id=$1 AND m.state='FINISHED'
      AND m.finished_at>=date_trunc('${period}',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[playerId])).rows[0];
    const claimed=!!(await c.query("SELECT 1 FROM quest_claims WHERE player_id=$1 AND quest_id=$2 AND period=$3::date",[playerId,q.id,data.period])).rowCount;
    rows.push({id:q.id,period:data.period,progress:Math.min(q.target,q.metric==="visit"?1:data[q.metric]),claimed});
  }
  return rows;
}
export async function claimQuest(playerId:string,id:string){
  const q=quests.find(x=>x.id===id);if(!q)fail(404,"QUEST_UNAVAILABLE","Quest unavailable.");
  await transaction(async c=>{
    await c.query("SELECT player_id FROM balances WHERE player_id=$1 FOR UPDATE",[playerId]);
    const state=(await questState(playerId,c)).find(x=>x.id===id)!;
    if(state.claimed)return;
    if(state.progress<q.target)fail(409,"QUEST_INCOMPLETE","Complete the quest first.");
    await c.query("INSERT INTO quest_claims(player_id,quest_id,period) VALUES($1,$2,$3::date)",[playerId,id,state.period]);
    await c.query("UPDATE balances SET coins=coins+$2,xp=xp+$3 WHERE player_id=$1",[playerId,q.coins,q.xp]);
  });
}
