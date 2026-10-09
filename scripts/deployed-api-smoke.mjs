#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BlockList, isIP } from "node:net";
import { pathToFileURL } from "node:url";

// Intentionally read-only: no account creation, queueing, balance or match writes.
// Only short-lived request-rate counters may be written by normal API middleware.
const checks = [];
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");
export function isLoopback(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(hostname);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (family > 0 &&
      loopbackAddresses.check(hostname, family === 4 ? "ipv4" : "ipv6"))
  );
}
export function validateUrl(raw, allowLoopback = true) {
  const url = new URL(raw);
  const loopback = isLoopback(url);
  assert(
    allowLoopback || !loopback,
    "A public API cannot advertise a loopback region probe.",
  );
  assert(
    !url.username && !url.password,
    "Do not put credentials in the API URL.",
  );
  assert(
    url.protocol === "https:" || (loopback && url.protocol === "http:"),
    "A public API must use HTTPS.",
  );
  return url;
}
async function get(url, status = 200) {
  const started = performance.now();
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(
    response.status,
    status,
    `${url.pathname}: unexpected HTTP status`,
  );
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const data = await response.json();
  checks.push({
    path: url.pathname,
    status,
    durationMs: Math.round(performance.now() - started),
  });
  return data;
}
async function main() {
  try {
    assert(
      process.argv[2],
      "Usage: npm run smoke:deployed -- https://your-api.up.railway.app",
    );
    const base = validateUrl(process.argv[2]);
    assert(
      !base.search &&
        !base.hash &&
        (base.pathname === "/" || base.pathname === ""),
      "Supply only the API origin.",
    );
    const health = await get(new URL("/health", base));
    assert.equal(health.status, "ok");
    assert.equal(health.postgres, true);
    assert.equal(health.redis, true);
    const { regions } = await get(new URL("/v1/regions", base));
    assert(
      Array.isArray(regions) && regions.length > 0 && regions.length <= 12,
      "Invalid region list.",
    );
    for (const region of regions) {
      assert.match(region.id, /^[a-z0-9-]{1,40}$/);
      const probe = validateUrl(region.probeUrl, isLoopback(base));
      const ping = await get(probe);
      assert.equal(ping.region, region.id);
      assert(
        Number.isFinite(Date.parse(ping.serverTimeUtc)),
        "Invalid server time.",
      );
    }
    for (const path of ["/v1/me", "/v1/history", "/internal/metrics"]) {
      const denied = await get(new URL(path, base), 401);
      assert.equal(denied.statusCode, 401);
      assert.equal(typeof denied.code, "string");
    }
    process.stdout.write(
      JSON.stringify(
        {
          result: "PASS",
          origin: base.origin,
          scope:
            "HTTPS API readiness, regions and authentication boundaries; not a UDP match",
          checks,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify(
        {
          result: "FAIL",
          error: error instanceof Error ? error.message : "Probe failed",
          checks,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
