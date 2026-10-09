import test from "node:test";
import assert from "node:assert/strict";
import { validateUrl } from "../scripts/deployed-api-smoke.mjs";

test("public deployment rejects HTTP and loopback region probes", () => {
  for (const hostname of [
    "localhost",
    "localhost.",
    "probe.localhost",
    "127.0.0.1",
    "127.4.5.6",
    "[::1]",
    "[::ffff:127.0.0.1]",
  ])
    for (const protocol of ["http", "https"])
      assert.throws(() =>
        validateUrl(`${protocol}://${hostname}/v1/ping`, false),
      );
  assert.throws(() => validateUrl("http://api.example.com/v1/ping", false));
  assert.equal(
    validateUrl("https://api.example.com/v1/ping", false).protocol,
    "https:",
  );
});
test("local-only smoke still supports explicit loopback endpoints", () => {
  assert.equal(
    validateUrl("http://127.0.0.1:3000/v1/ping").hostname,
    "127.0.0.1",
  );
  assert.throws(() =>
    validateUrl("https://name:secret@api.example.com/v1/ping", false),
  );
});
