ALTER TABLE balances ADD COLUMN gems integer NOT NULL DEFAULT 0 CHECK(gems>=0);
ALTER TABLE rewards ADD COLUMN gems integer NOT NULL DEFAULT 0 CHECK(gems>=0);
-- Replace the old device-only starter wallet with a single server starter grant.
UPDATE balances SET coins=coins+1000;
ALTER TABLE balances ALTER COLUMN coins SET DEFAULT 1000;
ALTER TABLE players ADD COLUMN selected_skin text NOT NULL DEFAULT 'skin:classic';
ALTER TABLE players ADD COLUMN selected_emote text NOT NULL DEFAULT '';
CREATE TABLE account_identities (
 provider text NOT NULL CHECK(provider IN ('email','apple')), subject text NOT NULL,
 player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 password_hash text, apple_refresh_cipher text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,subject), UNIQUE(player_id,provider)
);
CREATE TABLE inventory (
 player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE, item_id text NOT NULL,
 purchased_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(player_id,item_id)
);
INSERT INTO inventory(player_id,item_id) SELECT id,item FROM players CROSS JOIN unnest(ARRAY['char:kai','char:leo','char:ryan','skin:classic']) AS item;
-- Existing online character selections predate inventory enforcement; retain them once.
INSERT INTO inventory(player_id,item_id) SELECT id,'char:'||character_id FROM players ON CONFLICT DO NOTHING;
CREATE TABLE quest_claims (
 player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE, quest_id text NOT NULL,
 period date NOT NULL, PRIMARY KEY(player_id,quest_id,period)
);
ALTER TABLE players ADD COLUMN age integer CHECK(age BETWEEN 4 AND 120);
ALTER TABLE players ADD COLUMN onboarding_complete boolean NOT NULL DEFAULT false;

ALTER TABLE guest_refresh ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX guest_refresh_family ON guest_refresh(family_id);
