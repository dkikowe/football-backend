import test from "node:test";
import assert from "node:assert/strict";
import { clientIpResolver } from "../dist/client-ip.js";
const request = (peer, headers = {}) => ({
  socket: { remoteAddress: peer },
  headers,
});
test("untrusted requests cannot spoof client IP", () => {
  const resolve = clientIpResolver("127.0.0.1/32");
  assert.equal(
    resolve(request("203.0.113.2", { "x-real-ip": "198.51.100.1" })),
    "203.0.113.2",
  );
  assert.equal(
    clientIpResolver("")(request("127.0.0.1", { "x-real-ip": "198.51.100.1" })),
    "127.0.0.1",
  );
});
test("only a valid single real IP from a configured direct peer is accepted", () => {
  const resolve = clientIpResolver("127.0.0.1/32,fd00::/64");
  assert.equal(
    resolve(request("::ffff:127.0.0.1", { "x-real-ip": "198.51.100.1" })),
    "198.51.100.1",
  );
  assert.equal(
    resolve(request("fd00::3", { "x-real-ip": "2001:0db8::0001" })),
    "2001:db8::1",
  );
  for (const value of ["bad", "198.51.100.1, 198.51.100.2", ["198.51.100.1"]])
    assert.equal(
      resolve(request("127.0.0.1", { "x-real-ip": value })),
      "127.0.0.1",
    );
  assert.equal(
    resolve(request("127.0.0.1", { "x-forwarded-for": "198.51.100.1" })),
    "127.0.0.1",
  );
});
test("unsafe or malformed proxy ranges fail startup", () => {
  for (const value of [
    "0.0.0.0/0",
    "::/0",
    "true",
    "10.0.0.0/99",
    "127.0.0.1/no",
  ])
    assert.throws(() => clientIpResolver(value));
});
