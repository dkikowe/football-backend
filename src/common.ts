import { HttpException } from "@nestjs/common";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { key, redis } from "./db";
export function fail(status: number, code: string, message: string): never {
  throw new HttpException({ statusCode: status, code, message }, status);
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const id = () => randomUUID();
export function secretEqual(a: string, b: string) {
  return (
    !!a && !!b && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
  );
}
export const character = z.enum([
  "kai",
  "leo",
  "ryan",
  "max",
  "bruno",
  "diego",
]);
export const uuid = z.uuid();
export const nickname = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N} _.-]+$/u);
export const region = z.string().regex(/^[a-z0-9-]{1,40}$/);
export function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success)
    fail(
      400,
      "VALIDATION_ERROR",
      r.error.issues
        .map((x) => `${x.path.join(".")}: ${x.message}`)
        .slice(0, 3)
        .join("; "),
    );
  return r.data;
}
export async function lock<T>(fn: () => Promise<T>): Promise<T> {
  const lockKey = key("lock:lifecycle"),
    owner = token();
  let acquired = false;
  for (let n = 0; n < 80; n++) {
    if (await redis.set(lockKey, owner, { NX: true, PX: 15000 })) {
      acquired = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!acquired) fail(503, "BUSY", "Please retry in a moment.");
  const renew = setInterval(
    () =>
      void redis
        .eval(
          'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("PEXPIRE",KEYS[1],15000) end return 0',
          { keys: [lockKey], arguments: [owner] },
        )
        .catch(() => {}),
    4000,
  );
  renew.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await redis
      .eval(
        'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) end return 0',
        { keys: [lockKey], arguments: [owner] },
      )
      .catch(() => {});
  }
}
export const rank = (rating: number) =>
  rating >= 1300
    ? "GOLD II"
    : rating >= 1150
      ? "GOLD I"
      : rating >= 950
        ? "SILVER II"
        : "BRONZE II";
