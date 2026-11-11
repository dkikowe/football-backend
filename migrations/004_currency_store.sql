-- StoreKit consumables and server-authoritative gem-to-coin exchanges.
ALTER TABLE balances ADD COLUMN paid_gems_debt integer NOT NULL DEFAULT 0 CHECK(paid_gems_debt>=0);
CREATE TABLE currency_exchanges (
 player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, pack_id text NOT NULL,
 gems_spent integer NOT NULL CHECK(gems_spent>0), coins_granted integer NOT NULL CHECK(coins_granted>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(player_id,request_id)
);
-- Retain transaction uniqueness after account deletion without retaining profile data.
CREATE TABLE apple_purchase_transactions (
 environment text NOT NULL CHECK(environment IN ('Production','Sandbox')),
 transaction_id text NOT NULL, product_id text NOT NULL,
 account_token_hash char(64) NOT NULL,
 player_id uuid REFERENCES players(id) ON DELETE SET NULL,
 gems integer NOT NULL CHECK(gems>0), granted_at timestamptz,
 revoked boolean NOT NULL DEFAULT false,
 state_signed_at bigint NOT NULL DEFAULT 0,
 purchase_at timestamptz NOT NULL, receipt_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(environment,transaction_id)
);
CREATE INDEX apple_purchase_player ON apple_purchase_transactions(player_id);
CREATE TABLE apple_store_notifications (
 environment text NOT NULL CHECK(environment IN ('Production','Sandbox')),
 notification_id uuid NOT NULL, notification_type text NOT NULL,
 payload_hash char(64) NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(environment,notification_id)
);

-- Both match-earned and purchased gems settle spent-refund debt before becoming spendable.
CREATE FUNCTION settle_paid_gems_debt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offset_gems integer;
BEGIN
 IF NEW.gems>0 AND NEW.paid_gems_debt>0 THEN
   offset_gems:=LEAST(NEW.gems,NEW.paid_gems_debt);
   NEW.gems:=NEW.gems-offset_gems;
   NEW.paid_gems_debt:=NEW.paid_gems_debt-offset_gems;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER balances_settle_paid_gems_debt
 BEFORE INSERT OR UPDATE OF gems,paid_gems_debt ON balances
 FOR EACH ROW EXECUTE FUNCTION settle_paid_gems_debt();
