import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { z } from "zod";
const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    REDIS_PREFIX: z.string().min(1).default("football:local:"),
    GAME_SERVER_SECRET: z.string().min(32),
    PUBLIC_API_URL: z.url().default("http://127.0.0.1:3000"),
    REGIONS_JSON: z.string().optional(),
    BOT_FILL_SECONDS: z.coerce.number().min(0).max(120).default(12),
    QUEUE_TIMEOUT_SECONDS: z.coerce.number().min(1).max(180).default(60),
    SERVER_TIMEOUT_SECONDS: z.coerce.number().min(3).max(120).default(18),
    MATCH_TIMEOUT_SECONDS: z.coerce.number().min(30).max(3600).default(900),
    RECONNECT_SECONDS: z.coerce.number().min(1).max(90).default(90),
    JOIN_TICKET_SECONDS: z.coerce.number().min(5).max(120).default(60),
    ACCESS_TOKEN_SECONDS: z.coerce.number().min(30).default(3600),
    REFRESH_TOKEN_DAYS: z.coerce.number().min(1).max(180).default(90),
    TRANSPORT_CA_CERTIFICATE: z.string().max(65536).optional(),
    TRANSPORT_CA_CERTIFICATE_FILE: z.string().optional(),
    TRANSPORT_SERVER_NAME: z.string().trim().default(""),
    API_RATE_LIMIT: z.coerce.number().min(10).max(10000).default(240),
    TRUSTED_PROXY_CIDRS: z.string().default(""),
  })
  .parse(process.env);
// Railway can store the public trust certificate directly; a nonempty env PEM
// takes precedence over a mounted file. Never accept a bundled private key.
let caCertificate =
  env.TRANSPORT_CA_CERTIFICATE?.trim() ||
  (env.TRANSPORT_CA_CERTIFICATE_FILE
    ? readFileSync(env.TRANSPORT_CA_CERTIFICATE_FILE, "utf8").trim()
    : "");
if (caCertificate) {
  if (
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(
      caCertificate,
    )
  )
    throw new Error(
      "Transport trust must contain exactly one public PEM certificate and no private key.",
    );
  try {
    caCertificate = new X509Certificate(caCertificate).toString();
  } catch {
    throw new Error(
      "Transport trust certificate is not a valid X.509 PEM certificate.",
    );
  }
}
if (
  env.NODE_ENV === "production" &&
  Boolean(caCertificate) !== Boolean(env.TRANSPORT_SERVER_NAME)
)
  throw new Error(
    "Public transport trust requires both a certificate and TRANSPORT_SERVER_NAME.",
  );
export const config = {
  ...env,
  regions: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,40}$/),
        probeUrl: z.url(),
      }),
    )
    .min(1)
    .parse(
      JSON.parse(
        env.REGIONS_JSON ||
          JSON.stringify([
            {
              id: "local",
              probeUrl: `${env.PUBLIC_API_URL}/v1/ping?region=local`,
            },
          ]),
      ),
    ),
  caCertificate,
};
if (
  config.GAME_SERVER_SECRET.includes("GENERATE_") ||
  config.GAME_SERVER_SECRET.includes("CHANGE_ME")
)
  throw new Error("Generate GAME_SERVER_SECRET before startup.");
if (
  config.NODE_ENV === "production" &&
  !config.PUBLIC_API_URL.startsWith("https://")
)
  throw new Error("Production PUBLIC_API_URL requires HTTPS.");
