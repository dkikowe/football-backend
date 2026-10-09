#!/usr/bin/env node
// Real dedicated Unity + two independent clients; never simulates physics in Node.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  unlink,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const binary = process.argv[2] || process.env.UNITY_SERVER_BINARY;
if (!binary || !process.env.GAME_SERVER_SECRET) {
  console.error(
    "Usage: node --env-file=.env.local scripts/multiplayer-smoke.mjs /path/to/Football [--chaos]\nSet GAME_SERVER_SECRET and BACKEND_URL in the environment.",
  );
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BACKEND_URL || "http://127.0.0.1:3000";
const serverId = "smoke-" + randomUUID().slice(0, 12),
  port = Number(process.env.SMOKE_GAME_PORT || 17877);
await mkdir(join(root, ".local"), { recursive: true });
const out = await mkdtemp(join(root, ".local", "multiplayer-smoke-"));
await chmod(out, 0o700);
const processes = [],
  credentialFiles = [],
  report = {
    startedUtc: new Date().toISOString(),
    serverId,
    checks: [],
    artifacts: out,
  };
let matchId = "",
  server,
  client1,
  client2,
  replacement,
  chaosProxy,
  proxyLog = "",
  interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    for (const child of processes)
      if (child.exitCode === null) child.kill("SIGTERM");
  });
const log = (message) => console.log("[smoke] " + message);
function launch(name, args, env = {}) {
  const path = join(out, name + ".log");
  const launchEnv = { ...process.env, ...env };
  // Client test processes never inherit backend or dedicated-server credentials.
  for (const name of ["DATABASE_URL", "REDIS_URL", "POSTGRES_PASSWORD"])
    delete launchEnv[name];
  if (!args.includes("-football-server"))
    for (const name of ["GAME_SERVER_SECRET", "GAME_TLS_KEY", "GAME_TLS_CERT"])
      delete launchEnv[name];
  const child = spawn(
    resolve(binary),
    ["-batchmode", "-nographics", ...args, "-logFile", path],
    { env: launchEnv, stdio: ["ignore", "ignore", "ignore"] },
  );
  child.on("error", (e) => {
    report.checks.push({
      name: name + " launch",
      passed: false,
      message: e.message,
    });
  });
  processes.push(child);
  return { child, path, name };
}
async function readLog(handle) {
  try {
    return await readFile(handle.path, "utf8");
  } catch {
    return "";
  }
}
async function request(
  path,
  {
    method = "GET",
    body,
    session,
    internal = false,
    allowConflict = false,
  } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: "Bearer " + session.accessToken } : {}),
      ...(internal
        ? { Authorization: "Bearer " + process.env.GAME_SERVER_SECRET }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const value = await response.json();
  if (!response.ok) {
    if (allowConflict && [404, 409, 503].includes(response.status)) return null;
    throw new Error(
      `${method} ${path}: ${response.status} ${value.code || "request_failed"} ${value.message || ""}`,
    );
  }
  return value;
}
async function until(name, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interrupted)
      throw new Error(
        "Smoke interrupted; owned processes are being cleaned up.",
      );
    for (const handle of [server, client1, replacement].filter(Boolean)) {
      const currentLog = await readLog(handle);
      if (
        /NullReferenceException|MissingReferenceException|NetworkManager cannot be nested/.test(
          currentLog,
        )
      )
        throw new Error(handle.name + " runtime error; inspect " + handle.path);
    }
    const value = await fn();
    if (value) {
      report.checks.push({ name, passed: true });
      log(name + " PASS");
      return value;
    }
    await sleep(400);
  }
  throw new Error(name + " timed out");
}
async function joinFile(name, allocation) {
  const file = join(out, name + ".json");
  await writeFile(file, JSON.stringify(allocation), { mode: 0o600 });
  credentialFiles.push(file);
  return file;
}
async function halt(handle, signal = "SIGTERM") {
  if (!handle?.child || handle.child.exitCode !== null) return;
  handle.child.kill(signal);
  await Promise.race([
    new Promise((r) => handle.child.once("exit", r)),
    sleep(3000),
  ]);
  if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
}
try {
  await request("/health");
  server = launch(
    "server",
    [
      "-football-server",
      "-game-port",
      String(port),
      "-network-smoke-duration",
      "55",
    ],
    {
      BACKEND_URL: base,
      GAME_SERVER_ID: serverId,
      GAME_REGION: "local",
      GAME_PUBLIC_ADDRESS: "127.0.0.1",
      GAME_LISTEN_ADDRESS: "127.0.0.1",
      GAME_PORT: String(port),
    },
  );
  const a = await request("/v1/auth/guest", {
      method: "POST",
      body: { nickname: "SMOKE BLUE", characterId: "kai" },
    }),
    b = await request("/v1/auth/guest", {
      method: "POST",
      body: { nickname: "SMOKE RED", characterId: "leo" },
    });
  const room = await request("/v1/rooms", {
    method: "POST",
    session: a,
    body: { region: "local", characterId: "kai" },
  });
  await request("/v1/rooms/join", {
    method: "POST",
    session: b,
    body: { code: room.code, characterId: "leo" },
  });
  const started = await until(
    "dedicated registered and allocated",
    () =>
      request("/v1/rooms/" + room.code + "/start", {
        method: "POST",
        session: a,
        body: {},
        allowConflict: true,
      }),
    60000,
  );
  matchId = started.matchId;
  const allocationA = await request("/v1/matches/" + matchId + "/join", {
      session: a,
    }),
    allocationB = await request("/v1/matches/" + matchId + "/join", {
      session: b,
    });
  if (allocationA.port !== port)
    throw new Error(
      "Another local dedicated server received the smoke allocation; stop other idle servers before running.",
    );
  if (
    allocationA.slots.length !== 6 ||
    allocationA.slots.filter((s) => s.isBot).length !== 4
  )
    throw new Error("Expected two humans and four server bots.");
  report.checks.push({
    name: "exactly six slots: 2 humans + 4 bots",
    passed: true,
  });
  let clientAllocationA = allocationA,
    clientAllocationB = allocationB;
  if (process.argv.includes("--chaos")) {
    const proxyPath = join(root, "scripts", "udp-chaos.py");
    const proxyPort = port + 1;
    const p = spawn(
      process.env.PYTHON_BINARY || "python3",
      [
        proxyPath,
        "--listen",
        "127.0.0.1:" + proxyPort,
        "--target",
        "127.0.0.1:" + port,
        "--delay-ms",
        "75",
        "--jitter-ms",
        "20",
        "--loss",
        "0.03",
        "--seed",
        "41",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    chaosProxy = p;
    p.stdout.on("data", (data) => {
      proxyLog += data;
    });
    p.stderr.on("data", (data) => {
      proxyLog += data;
    });
    processes.push(p);
    await sleep(500);
    if (p.exitCode !== null)
      throw new Error(
        "UDP chaos proxy failed to start; check CLI arguments in udp-chaos.py.",
      );
    clientAllocationB = {
      ...allocationB,
      address: "127.0.0.1",
      port: proxyPort,
    };
  }
  const sessionAFile = await joinFile("session-blue", a);
  const sessionBFile = await joinFile("session-red", b);
  client1 = launch(
    "client-blue",
    [
      "-football-client",
      await joinFile("join-blue", clientAllocationA),
      "-football-session",
      sessionAFile,
      "-network-smoke-drive",
    ],
    { FOOTBALL_API_URL: base },
  );
  client2 = launch(
    "client-red",
    [
      "-football-client",
      await joinFile("join-red", clientAllocationB),
      "-football-session",
      sessionBFile,
      "-network-smoke-drive",
    ],
    { FOOTBALL_API_URL: base },
  );
  await until(
    "both clients receive authoritative snapshots",
    async () =>
      /ONLINE_CLIENT_SNAPSHOT/.test(await readLog(client1)) &&
      /ONLINE_CLIENT_SNAPSHOT/.test(await readLog(client2)),
    60000,
  );
  await sleep(10000);
  await halt(client2, "SIGKILL");
  log("Killed red client to simulate unexpected network loss.");
  const restored = await until(
    "backend allows same-account reconnect",
    () =>
      request("/v1/matches/" + matchId + "/reconnect", {
        method: "POST",
        body: { reconnectToken: allocationB.reconnectToken },
        session: b,
        allowConflict: true,
      }),
    60000,
  );
  const oldSlot = allocationB.slots.find((s) => s.playerId === b.playerId),
    newSlot = restored.slots.find((s) => s.playerId === b.playerId);
  if (!oldSlot || newSlot.slot !== oldSlot.slot)
    throw new Error("Reconnect changed player slot.");
  if (process.argv.includes("--chaos")) {
    restored.address = clientAllocationB.address;
    restored.port = clientAllocationB.port;
    chaosProxy.kill("SIGUSR1");
    await until(
      "UDP proxy accepts replacement endpoint",
      async () => /"event"\s*:\s*"binding_reset"/.test(proxyLog),
      5000,
    );
  }
  replacement = launch(
    "client-red-reconnected",
    [
      "-football-client",
      await joinFile("join-red-reconnected", restored),
      "-football-session",
      sessionBFile,
      "-network-smoke-drive",
    ],
    { FOOTBALL_API_URL: base },
  );
  await until(
    "replacement client receives current authoritative snapshot",
    async () => /ONLINE_CLIENT_SNAPSHOT/.test(await readLog(replacement)),
    60000,
  );
  const final = await until(
    "dedicated commits trusted final result",
    () =>
      request("/v1/matches/" + matchId + "/results", {
        session: a,
        allowConflict: true,
      }),
    240000,
  );
  if (final.state !== "FINISHED")
    throw new Error("Match failed instead of finishing.");
  await sleep(1800);
  const finalB = await request("/v1/matches/" + matchId + "/results", {
    session: b,
  });
  if (
    finalB.blueScore !== final.blueScore ||
    finalB.redScore !== final.redScore
  )
    throw new Error("Clients received different final scores.");
  report.checks.push({ name: "both accounts agree final score", passed: true });
  report.result = {
    matchId,
    blueScore: final.blueScore,
    redScore: final.redScore,
    participants: final.participants.length,
  };
  const blueLog = await readLog(client1);
  const redLog = (await readLog(client2)) + "\n" + (await readLog(replacement));
  const parseSnapshots = (text) =>
    [
      ...text.matchAll(
        /ONLINE_CLIENT_SNAPSHOT slot=(\d+) tick=(\d+) score=(\d+)-(\d+) ball=\(([^)]+)\) state=(\d+) rtt=([\d.]+) loss=([\d.]+)/g,
      ),
    ].map((m) => ({
      tick: Number(m[2]),
      score: m[3] + "-" + m[4],
      ball: m[5].split(",").map(Number),
      state: Number(m[6]),
      rtt: Number(m[7]),
      loss: Number(m[8]),
    }));
  const blueSamples = parseSnapshots(blueLog),
    redSamples = parseSnapshots(redLog);
  let pairs = 0,
    maxBallDifference = 0;
  for (const blue of blueSamples) {
    const red = redSamples.reduce(
      (best, sample) =>
        !best ||
        Math.abs(sample.tick - blue.tick) < Math.abs(best.tick - blue.tick)
          ? sample
          : best,
      null,
    );
    if (!red || Math.abs(red.tick - blue.tick) > 2) continue;
    const difference = Math.hypot(...blue.ball.map((v, i) => v - red.ball[i]));
    const ticks = Math.abs(red.tick - blue.tick);
    if (ticks && (blue.state !== red.state || blue.score !== red.score))
      continue;
    if (!ticks && blue.score !== red.score)
      throw new Error("Same authoritative tick has conflicting client scores.");
    // Two different ticks may contain up to 67ms of real ball travel. Exact ticks tolerate only rounding.
    if (difference > 0.12 + 1.8 * ticks)
      throw new Error(
        "Client ball snapshots disagree beyond time-alignment tolerance.",
      );
    pairs++;
    maxBallDifference = Math.max(maxBallDifference, difference);
  }
  if (pairs < 4)
    throw new Error(
      "Too few time-aligned client snapshots to validate ball agreement.",
    );
  report.checks.push({
    name: "time-aligned authoritative ball and score snapshots agree",
    passed: true,
  });
  const rtts = redSamples.map((s) => s.rtt).filter((x) => x > 0);
  report.network = {
    comparedSnapshotPairs: pairs,
    maxBallDifference: Number(maxBallDifference.toFixed(3)),
    redSnapshotCount: redSamples.length,
    redMeanRttMs: rtts.length
      ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)
      : 0,
    redMaxObservedLossPercent: Math.max(0, ...redSamples.map((s) => s.loss)),
    impaired: process.argv.includes("--chaos"),
  };
  const serverLog = await readLog(server);
  if (!/ONLINE_.*BOT|BOT_CONTROLLED|AI_TAKEOVER/i.test(serverLog))
    throw new Error("No dedicated bot takeover marker observed.");
  report.checks.push({ name: "server logged bot takeover", passed: true });
  if (
    !new RegExp(
      "ONLINE_JOIN slot=" + oldSlot.slot + " reconnect=True",
      "i",
    ).test(serverLog)
  )
    throw new Error("No same-slot reconnect confirmation in dedicated logs.");
  report.checks.push({
    name: "server confirms original slot reconnect",
    passed: true,
  });
  if (
    /NullReferenceException|InvalidOperationException|MissingReferenceException|StackOverflowException/.test(
      serverLog + (await readLog(client1)) + (await readLog(replacement)),
    )
  )
    throw new Error("Runtime exception found in multiplayer logs.");
  report.checks.push({ name: "no runtime exception markers", passed: true });
  report.passed = true;
  log("PASS. Redacted report: " + join(out, "report.json"));
} catch (error) {
  report.passed = false;
  report.error = error.message;
  log("FAIL: " + error.message);
  process.exitCode = 1;
} finally {
  for (const child of processes.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await sleep(800);
  for (const child of processes)
    if (child.exitCode === null) child.kill("SIGKILL");
  try {
    await request("/internal/servers/" + serverId + "/shutdown", {
      method: "POST",
      internal: true,
      body: {},
    });
  } catch {}
  for (const file of credentialFiles) await unlink(file).catch(() => {});
  if (proxyLog) await writeFile(join(out, "udp-chaos.jsonl"), proxyLog);
  report.finishedUtc = new Date().toISOString();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  log("Logs: " + out);
}
