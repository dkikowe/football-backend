CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS players (
 id uuid PRIMARY KEY, nickname varchar(24) NOT NULL, character_id varchar(20) NOT NULL DEFAULT 'kai',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_nickname ON players(lower(nickname));
CREATE TABLE IF NOT EXISTS guest_refresh (
 token_hash char(64) PRIMARY KEY, player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS refresh_player ON guest_refresh(player_id);
CREATE TABLE IF NOT EXISTS friendships (
 requester_id uuid NOT NULL REFERENCES players(id), recipient_id uuid NOT NULL REFERENCES players(id),
 state varchar(10) NOT NULL CHECK(state IN ('PENDING','ACCEPTED')), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(requester_id,recipient_id), CHECK(requester_id <> recipient_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS friendship_pair ON friendships(LEAST(requester_id,recipient_id),GREATEST(requester_id,recipient_id));
CREATE TABLE IF NOT EXISTS parties (id uuid PRIMARY KEY, leader_id uuid NOT NULL REFERENCES players(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS party_memberships (
 party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE, player_id uuid PRIMARY KEY REFERENCES players(id),
 joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS party_invites (
 party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE, player_id uuid NOT NULL REFERENCES players(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',PRIMARY KEY(party_id,player_id)
);
CREATE TABLE IF NOT EXISTS matches (
 id uuid PRIMARY KEY, server_id varchar(80) NOT NULL, region varchar(40) NOT NULL, mode varchar(20) NOT NULL,
 state varchar(20) NOT NULL, blue_score int NOT NULL DEFAULT 0 CHECK(blue_score>=0),red_score int NOT NULL DEFAULT 0 CHECK(red_score>=0),
 duration_seconds real NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 result_hash char(64)
);
CREATE TABLE IF NOT EXISTS match_participants (
 match_id uuid NOT NULL REFERENCES matches(id), slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 5),
 team smallint NOT NULL CHECK(team IN(0,1)), player_id uuid REFERENCES players(id),character_id varchar(20) NOT NULL,nickname varchar(24) NOT NULL,
 goals int NOT NULL DEFAULT 0,assists int NOT NULL DEFAULT 0,shots int NOT NULL DEFAULT 0,passes int NOT NULL DEFAULT 0,tackles int NOT NULL DEFAULT 0,
 possession_seconds real NOT NULL DEFAULT 0,is_mvp boolean NOT NULL DEFAULT false,
 PRIMARY KEY(match_id,slot),UNIQUE(match_id,player_id)
);
CREATE INDEX IF NOT EXISTS participant_player ON match_participants(player_id,match_id);
CREATE TABLE IF NOT EXISTS player_stats (
 player_id uuid PRIMARY KEY REFERENCES players(id),matches int NOT NULL DEFAULT 0,wins int NOT NULL DEFAULT 0,
 losses int NOT NULL DEFAULT 0,draws int NOT NULL DEFAULT 0,goals int NOT NULL DEFAULT 0,assists int NOT NULL DEFAULT 0,mvp_count int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ratings (player_id uuid PRIMARY KEY REFERENCES players(id),rating int NOT NULL DEFAULT 1000 CHECK(rating>=0));
CREATE TABLE IF NOT EXISTS balances (player_id uuid PRIMARY KEY REFERENCES players(id),coins int NOT NULL DEFAULT 0 CHECK(coins>=0),xp int NOT NULL DEFAULT 0 CHECK(xp>=0));
CREATE TABLE IF NOT EXISTS rewards (
 match_id uuid NOT NULL REFERENCES matches(id),player_id uuid NOT NULL REFERENCES players(id),coins int NOT NULL,xp int NOT NULL,rating_delta int NOT NULL,
 PRIMARY KEY(match_id,player_id)
);
