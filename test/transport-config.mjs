import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rootCertificates } from "node:tls";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function load(extra = {}) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      'const c=require("./dist/config").config; process.stdout.write(JSON.stringify({hasCertificate:!!c.caCertificate}));',
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://unused/test",
        GAME_SERVER_SECRET: "test-only-transport-config-secret-00000",
        PUBLIC_API_URL: "https://api.example.com",
        REGIONS_JSON: "",
        TRANSPORT_CA_CERTIFICATE: "",
        TRANSPORT_CA_CERTIFICATE_FILE: "",
        TRANSPORT_SERVER_NAME: "",
        ...extra,
      },
    },
  );
}
test("transport public PEM variable overrides file and valid file remains supported", () => {
  const directory = mkdtempSync(join(tmpdir(), "football-public-trust-"));
  try {
    const pemPath = join(directory, "public-ca.pem");
    writeFileSync(pemPath, rootCertificates[0]);
    for (const extra of [
      {
        TRANSPORT_CA_CERTIFICATE: rootCertificates[0],
        TRANSPORT_CA_CERTIFICATE_FILE: join(directory, "not-mounted.pem"),
      },
      { TRANSPORT_CA_CERTIFICATE_FILE: pemPath },
    ]) {
      const result = load({
        ...extra,
        TRANSPORT_SERVER_NAME: "game.example.com",
      });
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).hasCertificate, true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("transport rejects malformed certificates and private-key bundles", () => {
  for (const pem of [
    "not a certificate",
    "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    rootCertificates[0] +
      "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    rootCertificates[0] + rootCertificates[1],
  ])
    assert.notEqual(
      load({
        TRANSPORT_CA_CERTIFICATE: pem,
        TRANSPORT_SERVER_NAME: "game.example.com",
      }).status,
      0,
    );
});
test("production requires certificate and identity together but allows initial blank API provisioning", () => {
  assert.equal(load().status, 0);
  assert.notEqual(
    load({ TRANSPORT_CA_CERTIFICATE: rootCertificates[0] }).status,
    0,
  );
  assert.notEqual(
    load({ TRANSPORT_SERVER_NAME: "game.example.com" }).status,
    0,
  );
});
