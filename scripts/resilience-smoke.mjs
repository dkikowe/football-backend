#!/usr/bin/env node
// Six real Unity clients + one dedicated process. This harness only drives normal input.
// Two simultaneous process losses, then two automatic reconnects after UDP route loss.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, chmod, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const binary = process.argv[2] || process.env.UNITY_SERVER_BINARY;
if (!binary || !process.env.GAME_SERVER_SECRET) {
  console.error("Usage: node --env-file=.env.local scripts/resilience-smoke.mjs '/path/to/Arcade Football'\nRequires GAME_SERVER_SECRET; API must be running and no other IDLE dedicated servers may compete for allocation.");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BACKEND_URL || "http://127.0.0.1:3000";
const port = Number(process.env.RESILIENCE_GAME_PORT || 18877);
if (!Number.isInteger(port) || port < 1024 || port > 65520) throw new Error("Invalid RESILIENCE_GAME_PORT");
const serverId = "resilience-" + randomUUID().slice(0, 10);
await mkdir(join(root, ".local"), { recursive: true });
const out = await mkdtemp(join(root, ".local", "resilience-smoke-"));
await chmod(out, 0o700);
const children = [], credentialFiles = [], proxies = [], clients = new Array(6);
const identities = [], allocations = [], slots = [], sessionFiles = [];
const killedIndexes = [1, 4], automaticIndexes = [2, 5];
const report = { startedUtc: new Date().toISOString(), serverId, checks: [], artifacts: out,
  fixture: { humanClients: 6, dedicatedProcesses: 1, durationSeconds: 105,
    processLossClientIndexes: killedIndexes, automaticReconnectClientIndexes: automaticIndexes, maliciousPacketClientIndex: 5 } };
let server, keepAwake, matchId = "", interrupted = false, lastPollAt = Date.now();
const log = (text) => console.log("[resilience] " + text);
async function saveReport() { await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2)); }
async function passed(name, details = {}) {
  report.checks.push({ name, passed: true, atUtc: new Date().toISOString(), ...details });
  log(name + " PASS"); await saveReport();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  for (const h of children) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGTERM");
});
function safeEnv(overrides = {}, isServer = false) {
  const env = { ...process.env, ...overrides };
  for (const name of ["DATABASE_URL", "REDIS_URL", "POSTGRES_PASSWORD", "LOCAL_ADMIN_DATABASE_URL", "TEST_ADMIN_DATABASE_URL"])
    delete env[name];
  if (!isServer) for (const name of ["GAME_SERVER_SECRET", "GAME_TLS_KEY", "GAME_TLS_CERT"]) delete env[name];
  return env;
}
function launchUnity(name, args, env = {}) {
  const path = join(out, name + ".log");
  const child = spawn(resolve(binary), ["-batchmode", "-nographics", ...args, "-logFile", path],
    { env: safeEnv(env, args.includes("-football-server")), stdio: "ignore" });
  const handle = { child, path, name, expectedExit: false };
  child.on("error", (error) => { handle.launchError = error.message; });
  children.push(handle); return handle;
}
async function readLog(h) { try { return await readFile(h.path, "utf8"); } catch { return ""; } }
function snapshots(text) {
  return [...text.matchAll(/ONLINE_CLIENT_SNAPSHOT slot=(\d+) tick=(\d+) score=(\d+)-(\d+) ball=\(([^)]+)\) state=(\d+) rtt=([\d.]+) loss=([\d.]+) serverTime=([\d.]+) packets=(\d+)/g)]
    .map(m => ({ slot: +m[1], tick: +m[2], blue: +m[3], red: +m[4], ball: m[5].split(",").map(Number),
      state: +m[6], rtt: +m[7], loss: +m[8], serverTime: +m[9], packets: +m[10] }));
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function cadence(samples) {
  const tickRates = [], snapshotRates = [];
  let excludedGaps = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], elapsed = b.serverTime - a.serverTime;
    // The fixture has no packet delay/loss; discard reconnect gaps and counter resets,
    // without filtering on the measured rate itself (which would hide cadence bugs).
    if (elapsed < .5 || elapsed > 2 || b.tick <= a.tick || b.packets <= a.packets) { excludedGaps++; continue; }
    tickRates.push((b.tick - a.tick) / elapsed);
    snapshotRates.push((b.packets - a.packets) / elapsed);
  }
  return { windows: tickRates.length, excludedGaps,
    medianTicksPerSecond: tickRates.length ? Number(median(tickRates).toFixed(3)) : null,
    medianSnapshotsPerSecond: snapshotRates.length ? Number(median(snapshotRates).toFixed(3)) : null };
}
const last = values => values[values.length - 1];
async function lastSnapshot(handle) { return last(snapshots(await readLog(handle))); }
async function checkRuntime() {
  const now = Date.now(), gap = now - lastPollAt; lastPollAt = now;
  if (gap > 30000) {
    report.hostTimingGap = { atUtc: new Date().toISOString(), milliseconds: gap };
    throw new Error("HOST_TIMING_GAP: test process did not run for " + Math.round(gap / 1000) + "s; check host sleep before attributing failure to gameplay");
  }
  if (keepAwake && !keepAwake.expectedExit && (keepAwake.launchError || keepAwake.child.exitCode !== null || keepAwake.child.signalCode !== null))
    throw new Error("Scoped idle-sleep guard failed");
  for (const h of [server, ...clients].filter(Boolean)) {
    if (h.launchError) throw new Error(h.name + " launch: " + h.launchError);
    const text = await readLog(h);
    if (/NullReferenceException|MissingReferenceException|InvalidOperationException|StackOverflowException|NetworkManager cannot be nested/.test(text))
      throw new Error(h.name + " runtime exception; inspect its log");
    if (snapshots(text).some(s => s.blue >= 999 || s.red >= 999))
      throw new Error(h.name + " accepted the client-forged score");
    if (!h.expectedExit && (h.child.exitCode !== null || h.child.signalCode !== null))
      throw new Error(h.name + " exited unexpectedly (" + (h.child.exitCode ?? h.child.signalCode) + ")");
  }
}
async function until(name, predicate, timeout = 45000, details = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Interrupted; cleaning owned processes");
    await checkRuntime();
    const value = await predicate();
    if (value) { await passed(name, details); return value; }
    await sleep(700);
  }
  throw new Error(name + " timed out");
}
async function request(path, { method = "GET", body, session, internal = false, allowWait = false } = {}) {
  const response = await fetch(base + path, { method,
    headers: { "Content-Type": "application/json",
      ...(session ? { Authorization: "Bearer " + session.accessToken } : {}),
      ...(internal ? { Authorization: "Bearer " + process.env.GAME_SERVER_SECRET } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  const data = await response.json();
  if (!response.ok) {
    if (allowWait && [404, 409, 503].includes(response.status)) return null;
    throw new Error(`${method} ${path}: HTTP ${response.status} ${data.code || "REQUEST_FAILED"}`);
  }
  return data;
}
async function secretFile(name, value) {
  const file = join(out, name + ".json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  credentialFiles.push(file); return file;
}
async function halt(h, signal = "SIGTERM") {
  if (!h) return;
  h.expectedExit = true;
  if (h.child.exitCode !== null || h.child.signalCode !== null) return;
  const ended = new Promise(resolve => h.child.once("exit", resolve));
  h.child.kill(signal);
  await Promise.race([ended, sleep(2500)]);
  if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGKILL");
}
async function startProxy(index) {
  const child = spawn(process.env.PYTHON_BINARY || "python3", [join(root, "scripts", "udp-chaos.py"),
    "--listen", "127.0.0.1:" + (port + index + 1), "--target", "127.0.0.1:" + port,
    "--delay-ms", "0", "--jitter-ms", "0", "--loss", "0", "--seed", String(70 + index)],
    { env: safeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const handle = { child, name: "proxy-" + index, output: "", expectedExit: false, port: port + index + 1 };
  child.on("error", e => { handle.launchError = e.message; });
  child.stdout.on("data", d => { handle.output += d; });
  child.stderr.on("data", d => { handle.output += d; });
  children.push(handle); proxies.push(handle);
  const deadline = Date.now() + 5000;
  while (!/"event"\s*:\s*"started"/.test(handle.output) && Date.now() < deadline) {
    if (handle.launchError || child.exitCode !== null) throw new Error("Proxy launch failed: " + (handle.launchError || handle.output));
    await sleep(100);
  }
  if (!/"event"\s*:\s*"started"/.test(handle.output)) throw new Error("Proxy readiness timed out");
  return handle;
}
async function startClient(index, allocation, suffix = "") {
  const handle = launchUnity("client-" + index + suffix,
    ["-football-client", await secretFile("join-" + index + suffix, allocation),
      "-football-session", sessionFiles[index], "-network-smoke-drive",
      ...(index === 5 && !suffix ? ["-network-smoke-forge-goal"] : [])], { FOOTBALL_API_URL: base });
  clients[index] = handle; return handle;
}
const slotJoined = (text, slot, reconnect) => new RegExp("ONLINE_JOIN slot=" + slot + " reconnect=" + (reconnect ? "True" : "False"), "i").test(text);
const slotTakenOver = (text, slot) => new RegExp("ONLINE_BOT_TAKEOVER slot=" + slot + "\\b").test(text);

try {
  if (process.platform === "darwin") {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
    keepAwake = { child, name: "scoped-caffeinate", expectedExit: false };
    child.on("error", error => { keepAwake.launchError = error.message; });
    children.push(keepAwake);
    report.fixture.sleepGuard = "caffeinate -i -s -w <harness PID>; display sleep is unchanged";
  }
  await saveReport(); await request("/health");
  server = launchUnity("server", ["-football-server", "-game-port", String(port), "-network-smoke-duration", "105"],
    { BACKEND_URL: base, GAME_SERVER_ID: serverId, GAME_REGION: "local", GAME_PUBLIC_ADDRESS: "127.0.0.1",
      GAME_LISTEN_ADDRESS: "127.0.0.1", GAME_PORT: String(port) });
  const characters = ["kai", "leo", "ryan", "max", "bruno", "diego"];
  for (let i = 0; i < 6; i++) {
    identities.push(await request("/v1/auth/guest", { method: "POST", body: { nickname: "RESILIENCE " + (i + 1), characterId: characters[i] } }));
    sessionFiles.push(await secretFile("session-" + i, identities[i]));
  }
  if (new Set(identities.map(s => s.playerId)).size !== 6) throw new Error("Guest accounts are not distinct");
  const room = await request("/v1/rooms", { method: "POST", session: identities[0], body: { region: "local", characterId: characters[0] } });
  for (let i = 1; i < 6; i++) await request("/v1/rooms/join", { method: "POST", session: identities[i], body: { code: room.code, characterId: characters[i] } });
  const started = await until("dedicated registered and allocated", () => request("/v1/rooms/" + room.code + "/start",
    { method: "POST", session: identities[0], body: {}, allowWait: true }), 60000);
  matchId = started.matchId;
  for (let i = 0; i < 6; i++) {
    const allocation = await request("/v1/matches/" + matchId + "/join", { session: identities[i] });
    if (allocation.port !== port) throw new Error("Another idle server captured test allocation; stop it before this fixture");
    if (allocation.slots.length !== 6 || allocation.slots.some(s => s.isBot)) throw new Error("Expected six allocated human slots");
    allocations.push(allocation); slots.push(allocation.slots.find(s => s.playerId === identities[i].playerId).slot);
  }
  await passed("six distinct accounts occupy six distinct human slots", { slots });
  const routed = new Map();
  for (const index of automaticIndexes) routed.set(index, await startProxy(index));
  for (let i = 0; i < 6; i++) await startClient(i, routed.has(i)
    ? { ...allocations[i], address: "127.0.0.1", port: routed.get(i).port } : allocations[i]);
  await until("all six real clients receive matching assigned slots", async () => {
    const latest = await Promise.all(clients.map(lastSnapshot));
    return latest.every((s, i) => s && s.slot === slots[i]);
  }, 60000);
  await until("server has six authenticated human peers", async () => {
    const text = await readLog(server); return slots.every(slot => slotJoined(text, slot, false));
  });
  await until("real client emits forbidden GOAL/state/result packets", async () =>
    /ONLINE_FORGED_GOAL_SENT/.test(await readLog(clients[5])), 15000);
  await sleep(4000);
  await checkRuntime();
  await passed("received authoritative scores ignore forged 999 payload");

  const survivor = clients[0], survivorBefore = await lastSnapshot(survivor);
  report.processLoss = { atUtc: new Date().toISOString(), slots: killedIndexes.map(i => slots[i]),
    originalPids: killedIndexes.map(i => clients[i].child.pid) };
  await Promise.all(killedIndexes.map(i => halt(clients[i], "SIGKILL")));
  log("Killed two Unity clients concurrently; four clients and dedicated remain running.");
  await until("two original actors become server bots", async () => {
    const text = await readLog(server); return killedIndexes.every(i => slotTakenOver(text, slots[i]));
  }, 25000);
  await until("remaining client receives advancing match during both disconnects", async () => {
    const current = await lastSnapshot(survivor); return current && current.tick > survivorBefore.tick + 60;
  }, 20000);
  const restored = await until("both accounts receive same-slot reconnect allocations", async () => {
    const values = await Promise.all(killedIndexes.map(i => request("/v1/matches/" + matchId + "/reconnect",
      { method: "POST", session: identities[i], body: { reconnectToken: allocations[i].reconnectToken }, allowWait: true })));
    return values.every(Boolean) ? values : null;
  }, 35000);
  for (let j = 0; j < killedIndexes.length; j++) {
    const i = killedIndexes[j], slot = restored[j].slots.find(s => s.playerId === identities[i].playerId)?.slot;
    if (slot !== slots[i]) throw new Error("Concurrent reconnect changed account slot");
  }
  await Promise.all(killedIndexes.map((i, j) => startClient(i, restored[j], "-restored")));
  await until("both replacement clients resume original slots", async () => {
    const text = await readLog(server);
    for (const i of killedIndexes) {
      const s = await lastSnapshot(clients[i]);
      if (!s || s.slot !== slots[i] || !slotJoined(text, slots[i], true)) return false;
    }
    return true;
  }, 35000);
  report.processLoss.replacementPids = killedIndexes.map(i => clients[i].child.pid);

  await sleep(1500);
  const beforeAutomatic = await Promise.all(automaticIndexes.map(i => lastSnapshot(clients[i])));
  const autoPids = automaticIndexes.map(i => clients[i].child.pid);
  report.automaticReconnect = { cutAtUtc: new Date().toISOString(), slots: automaticIndexes.map(i => slots[i]),
    originalPids: autoPids, route: "initial pinned UDP proxy -> renewed backend-advertised direct UDP endpoint",
    reconnectApiCalledByHarness: false };
  await Promise.all(automaticIndexes.map(i => halt(routed.get(i))));
  log("Cut both UDP routes. Keeping both affected Unity clients alive; only their own reconnect logic may restore them.");
  await until("two route-loss clients also become bots", async () => {
    const text = await readLog(server); return automaticIndexes.every(i => slotTakenOver(text, slots[i]));
  }, 30000);
  await until("both live client processes automatically reconnect to original slots", async () => {
    const text = await readLog(server);
    for (let j = 0; j < automaticIndexes.length; j++) {
      const i = automaticIndexes[j], h = clients[i], s = await lastSnapshot(h);
      if (h.child.pid !== autoPids[j]) throw new Error("Automatic reconnect client process was replaced");
      if (!s || s.tick <= beforeAutomatic[j].tick + 90 || s.slot !== slots[i] || !slotJoined(text, slots[i], true)) return false;
    }
    return true;
  }, 45000);
  report.automaticReconnect.restoredAtUtc = new Date().toISOString();
  report.automaticReconnect.finalPids = automaticIndexes.map(i => clients[i].child.pid);

  const final = await until("server commits a trusted result after all four interruptions", () => request("/v1/matches/" + matchId + "/results",
    { session: identities[0], allowWait: true }), 150000);
  if (final.state !== "FINISHED") throw new Error("Interrupted fixture did not finish normally");
  for (let i = 1; i < 6; i++) {
    const result = await request("/v1/matches/" + matchId + "/results", { session: identities[i] });
    if (result.state !== "FINISHED" || result.blueScore !== final.blueScore || result.redScore !== final.redScore)
      throw new Error("Final account results disagree");
  }
  if (final.participants.filter(p => p.playerId).length !== 6) throw new Error("Final result lost an allocated human participant");
  await passed("all six accounts agree on committed score and retained participants");
  const mvpCount = final.participants.filter(p => p.isMvp === true).length;
  if (mvpCount !== 1) throw new Error("Expected exactly one shared MVP across six human participants; got " + mvpCount);
  await passed("all six human participants share exactly one MVP", { mvpCount });
  report.result = { matchId, blueScore: final.blueScore, redScore: final.redScore,
    humanParticipants: final.participants.filter(p => p.playerId).length, mvpCount };
  await sleep(1500);
  const samples = await Promise.all(clients.map(async h => snapshots(await readLog(h))));
  for (let i = 0; i < 6; i++) if (samples[i].length < 4) throw new Error("Too few authoritative samples for client " + i);
  report.networkCadence = { expectedTicksPerSecond: 30, expectedSnapshotsPerSecond: 15,
    windowSeconds: [.5, 2], samplesUseServerClock: true,
    clients: samples.map((values, clientIndex) => ({ clientIndex, slot: slots[clientIndex], ...cadence(values) })) };
  await saveReport();
  for (const c of report.networkCadence.clients) {
    if (c.windows < 10) throw new Error("Too few uninterrupted cadence windows for client " + c.clientIndex);
    if (c.medianTicksPerSecond < 28 || c.medianTicksPerSecond > 32)
      throw new Error("Expected 30 server ticks/sec, client " + c.clientIndex + " measured " + c.medianTicksPerSecond);
    if (c.medianSnapshotsPerSecond < 13 || c.medianSnapshotsPerSecond > 17)
      throw new Error("Expected 15 received snapshots/sec, client " + c.clientIndex + " measured " + c.medianSnapshotsPerSecond);
  }
  await passed("all six clients measure 30 Hz simulation and 15 Hz snapshots");
  let compared = 0, exactTickPairs = 0, largestTimedBallDifference = 0;
  for (let i = 1; i < 6; i++) for (const a of samples[0]) {
    const b = samples[i].reduce((best, v) => !best || Math.abs(v.tick - a.tick) < Math.abs(best.tick - a.tick) ? v : best, null);
    if (!b) continue;
    const delta = Math.abs(a.tick - b.tick);
    if (delta > 2 || (delta && (a.state !== b.state || a.blue !== b.blue || a.red !== b.red))) continue;
    if (!delta && (a.blue !== b.blue || a.red !== b.red)) throw new Error("Same tick score mismatch across clients");
    const distance = Math.hypot(...a.ball.map((v, axis) => v - b.ball[axis]));
    if (distance > .12 + 1.8 * delta) throw new Error("Ball snapshots disagree after tick alignment");
    compared++; if (!delta) exactTickPairs++;
    largestTimedBallDifference = Math.max(largestTimedBallDifference, distance);
  }
  if (compared < 10) throw new Error("Not enough tick-aligned six-client samples");
  report.synchronization = { comparedPairs: compared, exactTickPairs,
    largestTimedBallDifference: Number(largestTimedBallDifference.toFixed(3)),
    finalClientSnapshotCounts: samples.map(s => s.length) };
  await passed("time-aligned six-client ball and score samples agree");
  for (const h of children.filter(h => h.path && h.name.startsWith("client-")))
    if (snapshots(await readLog(h)).some(s => s.blue >= 999 || s.red >= 999))
      throw new Error("A client observed forged score 999 in authoritative state");
  await passed("forged GOAL/state/result never changes any recorded authoritative score");
  await checkRuntime(); await passed("no runtime exception markers");
  report.passed = true; log("PASS: " + join(out, "report.json"));
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1;
  log("FAIL: " + error.message);
} finally {
  await Promise.all(children.map(h => halt(h)));
  try { await request("/internal/servers/" + serverId + "/shutdown", { method: "POST", body: {}, internal: true }); } catch {}
  for (const path of credentialFiles) await unlink(path).catch(() => {});
  for (const proxy of proxies) await writeFile(join(out, proxy.name + ".jsonl"), proxy.output);
  report.finishedUtc = new Date().toISOString(); await saveReport();
  log("Redacted report and logs: " + out);
}
