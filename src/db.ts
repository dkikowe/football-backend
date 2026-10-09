import { Pool, PoolClient } from "pg";
import { createClient } from "redis";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
export const redis = createClient({
  url: config.REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (attempt: number) => Math.min(1000, attempt * 100),
  },
});
redis.on("error", () =>
  process.stderr.write(
    JSON.stringify({ level: "error", event: "redis_error" }) + "\n",
  ),
);
export async function transaction<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of readdirSync(join(__dirname, "../migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(78234201)");
      if (
        (
          await c.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
            name,
          ])
        ).rowCount
      )
        return;
      await c.query(
        readFileSync(join(__dirname, "../migrations", name), "utf8"),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        name,
      ]);
    });
  }
}
export const key = (s: string) => config.REDIS_PREFIX + s;
export async function get<T>(s: string): Promise<T | null> {
  const v = await redis.get(key(s));
  return v ? JSON.parse(v) : null;
}
export async function set(s: string, v: unknown, ttl = 3600) {
  await redis.set(key(s), JSON.stringify(v), { EX: ttl });
}
