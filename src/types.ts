export interface Slot {
  slot: number;
  team: number;
  playerId: string;
  nickname: string;
  characterId: string;
  isBot: boolean;
  isEmpty?: boolean;
}
export interface Queue {
  queueId: string;
  leaderId: string;
  members: string[];
  region: string;
  rttMs: number;
  rating: number;
  created: number;
  state: string;
  matchId: string;
}
export interface Server {
  serverId: string;
  region: string;
  address: string;
  port: number;
  buildId: string;
  state: string;
  lastSeen: number;
  matchId: string;
}
export interface Lease {
  playerId: string;
  slot: number;
  reconnectHash: string;
  active: boolean;
  joined: boolean;
  disconnectedAt: number;
  voluntary: boolean;
  connectionId?: string;
  ticket: string;
}
export interface Allocation {
  roomCode?: string;
  matchId: string;
  matchSecret: string;
  serverId: string;
  region: string;
  address: string;
  port: number;
  slots: Slot[];
  leases: Lease[];
  created: number;
  state: string;
  queueIds: string[];
}
export interface Room {
  supportsRoomReturn?: boolean;
  returnedPlayerIds?: string[];
  previousMatchId?: string;
  duel?: boolean;
  code: string;
  leaderId: string;
  region: string;
  members: string[];
  state: string;
  matchId: string;
  created: number;
}
