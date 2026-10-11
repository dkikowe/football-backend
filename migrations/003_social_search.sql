-- Search remains correct without an optional extension on restricted managed databases.
-- When pg_trgm is available, index case-insensitive nickname substrings.
DO $$
DECLARE extension_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Nickname substring index skipped: pg_trgm requires database CREATE privilege.';
    END;
  END IF;
  SELECT n.nspname INTO extension_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm';
  IF extension_schema IS NOT NULL THEN
    EXECUTE format('CREATE INDEX IF NOT EXISTS players_nickname_search ON players USING gin(nickname %I.gin_trgm_ops)', extension_schema);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS friendships_recipient ON friendships(recipient_id);
