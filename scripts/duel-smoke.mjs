#!/usr/bin/env node
// Real public dedicated server + two real Unity clients (scripted input, no server bots). Never launches/registers a server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, chmod, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const binary = process.argv[2] || process.env.UNITY_CLIENT_BINARY;
if (!binary || !process.env.PUBLIC_SMOKE_API) {
  console.error("Usage: PUBLIC_SMOKE_API=https://api.example.com PUBLIC_SMOKE_REGION=us-east node scripts/public-match-smoke.mjs '/path/to/Arcade Football'");
  process.exit(2);
}
const origin = new URL(process.env.PUBLIC_SMOKE_API);
assert(origin.protocol === "https:" && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/", "Supply a public HTTPS API origin without credentials.");
const base = origin.origin;
const region = process.env.PUBLIC_SMOKE_REGION || "us-east";
const expectedAddress = process.env.PUBLIC_SMOKE_GAME_ADDRESS || "167.172.156.89";
const expectedPort = Number(process.env.PUBLIC_SMOKE_GAME_PORT || 7777);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, ".local"), { recursive: true });
const out = await mkdtemp(join(root, ".local", "duel-smoke-"));
await chmod(out, 0o700);
const children = [], credentialFiles = [], sessions = [], allocations = [], clients = [];
const report = { startedUtc: new Date().toISOString(), apiOrigin: base, region,
  fixture: { humanClients: 2, serverBots: 0, localServerProcesses: 0, input: "one stationary client, one ordinary movement/shoot/tackle client; disconnect/reconnect exercised", serverRules: "unchanged release match" },
  checks: [], artifacts: out };
let matchId = "", roomCode = "", interrupted = false, lastPollAt = Date.now(), guard;
const log = message => console.log("[duel-smoke] " + message);
async function saveReport() { await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2)); }
async function passed(name, details = {}) {
  report.checks.push({ name, passed: true, atUtc: new Date().toISOString(), ...details });
  log(name + " PASS"); await saveReport();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  for (const h of children) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGTERM");
});
async function request(path, { method = "GET", body, session, waitCodes = [] } = {}) {
  const response = await fetch(base + path, { method, redirect: "error",
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: "Bearer " + session.accessToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) {
    if (waitCodes.includes(data.code)) return null;
    throw new Error(`${method} ${path}: HTTP ${response.status} ${data.code || "REQUEST_FAILED"}`);
  }
  return data;
}
async function credentialFile(name, data) {
  const path = join(out, name + ".json");
  await writeFile(path, JSON.stringify(data), { mode: 0o600 }); credentialFiles.push(path); return path;
}
async function readLog(h) { try { return await readFile(h.path, "utf8"); } catch { return ""; } }
function snapshots(text) {
  return [...text.matchAll(/ONLINE_CLIENT_SNAPSHOT slot=(\d+) tick=(\d+) score=(\d+)-(\d+) ball=\(([^)]+)\) state=(\d+) rtt=([\d.]+) loss=([\d.]+) serverTime=([\d.]+) packets=(\d+)/g)]
    .map(m => ({ slot: +m[1], tick: +m[2], blue: +m[3], red: +m[4], ball: m[5].split(",").map(Number),
      state: +m[6], rtt: +m[7], loss: +m[8], serverTime: +m[9], packets: +m[10] }));
}
const last = a => a[a.length - 1];
async function latest(h) { return last(snapshots(await readLog(h))); }
async function checkRuntime() {
  const now = Date.now(), gap = now - lastPollAt; lastPollAt = now;
  if (gap > 30000) throw new Error("HOST_TIMING_GAP: harness did not run for " + Math.round(gap / 1000) + "s; check host sleep");
  if (interrupted) throw new Error("Interrupted; cleaning owned clients");
  for (const h of children) {
    if (h.launchError) throw new Error(h.name + " launch failed");
    if (!h.expectedExit && (h.child.exitCode !== null || h.child.signalCode !== null)) throw new Error(h.name + " exited unexpectedly");
    if (!h.path) continue;
    if (/NullReferenceException|MissingReferenceException|InvalidOperationException|StackOverflowException|NetworkManager cannot be nested/.test(await readLog(h)))
      throw new Error(h.name + " runtime exception; inspect its local log");
  }
}
async function until(name, predicate, timeout = 45000, pollMs = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await checkRuntime();
    const value = await predicate();
    if (value) { await passed(name); return value; }
    await sleep(pollMs);
  }
  throw new Error(name + " timed out");
}
async function startClient(index, allocation, sessionFile, suffix = "") {
  const path = join(out, "client-" + index + suffix + ".log");
  // Allowlist only OS/session environment; clients never inherit deployment credentials.
  const env = { FOOTBALL_API_URL: base };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "XDG_RUNTIME_DIR", "DYLD_LIBRARY_PATH"])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(resolve(binary), ["-batchmode", "-nographics", "-football-client",
    await credentialFile("join-" + index + suffix, allocation), "-football-session", sessionFile,
    "-network-smoke-drive", index === 0 ? "false" : "true", "-logFile", path], { env, stdio: "ignore" });
  const h = { child, path, name: "client-" + index + suffix, expectedExit: false };
  child.on("error", () => { h.launchError = true; }); children.push(h); clients[index] = h; return h;
}
async function halt(h, signal = "SIGTERM") {
  if (!h) return; h.expectedExit = true;
  if (h.child.exitCode !== null || h.child.signalCode !== null) return;
  const ended = new Promise(resolve => h.child.once("exit", resolve));
  h.child.kill(signal); await Promise.race([ended, sleep(2500)]);
  if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGKILL");
}
function assertAllocation(a) {
  assert.equal(a.matchId, matchId, "Allocation match changed");
  assert.equal(a.address, expectedAddress, "Wrong public dedicated address");
  assert.equal(a.port, expectedPort, "Wrong public dedicated UDP port");
  assert.equal(a.region, region, "Wrong allocated region");
  assert.match(a.caCertificate || "", /-----BEGIN CERTIFICATE-----/, "Public allocation requires a CA certificate");
  assert(a.serverName, "Public allocation requires a DTLS server name");
  assert.equal(a.slots.length, 6); assert.equal(a.slots.filter(s => s.isBot).length, 0);
  assert.equal(new Set(a.slots.map(s => s.slot)).size, 6);
  assert.equal(a.slots.filter(s=>s.isEmpty).length,4);
}
try {
  if (process.platform === "darwin") {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
    guard = { child, name: "scoped-idle-sleep-guard", expectedExit: false };
    child.on("error", () => { guard.launchError = true; }); children.push(guard);
  }
  await saveReport();
  const health = await request("/health"); assert(health.status === "ok" && health.postgres && health.redis);
  const advertised = await request("/v1/regions");
  assert(advertised.regions.some(r => r.id === region), "Requested region is not advertised");
  for (const [nickname, characterId] of Array.from({length:2}, (_, i) => ["LOAD TEST " + (i+1), ["kai","leo","ryan","bruno","max","diego"][i]]))
    sessions.push(await request("/v1/auth/guest", { method: "POST", body: { nickname, characterId } }));
  assert.notEqual(sessions[0].playerId, sessions[1].playerId);
  const sessionFiles = await Promise.all(sessions.map((s, i) => credentialFile("session-" + i, s)));
  const room = await request("/v1/rooms", { method: "POST", session: sessions[0], body: { region, duel: true } });
  roomCode = room.code;
  for(let i=1;i<2;i++) await request("/v1/rooms/join", { method: "POST", session: sessions[i], body: { code: roomCode, supportsDuel:true, characterId: ["kai","leo","ryan","bruno","max","diego"][i] } });
  const started = await until("real public dedicated allocated through private-room flow", () =>
    request("/v1/rooms/" + roomCode + "/start", { method: "POST", session: sessions[0], body: {}, waitCodes: ["NO_SERVER"] }), 60000);
  matchId = started.matchId;
  for (const session of sessions) {
    const a = await request("/v1/matches/" + matchId + "/join", { session }); assertAllocation(a); allocations.push(a);
  }
  const slots = sessions.map((s, i) => allocations[i].slots.find(a => a.playerId === s.playerId)?.slot);
  assert(slots.every(Number.isInteger) && new Set(slots).size === 2, "Human accounts need distinct assigned slots");
  report.endpoint = { address: expectedAddress, port: expectedPort, serverName: allocations[0].serverName,
    caSha256: createHash("sha256").update(allocations[0].caCertificate).digest("hex"), slots };
  await passed("allocation contains two humans, zero bots and public DTLS trust");
  await Promise.all(allocations.map((a, i) => startClient(i, a, sessionFiles[i])));
  await until("both actual Mac clients receive public authoritative snapshots over DTLS", async () => {
    const values = await Promise.all(clients.map(latest)); return values.every((s, i) => s && s.slot === slots[i]);
  }, 60000);
  await until("both clients observe advancing match ticks", async () => {
    const values = await Promise.all(clients.map(async h => snapshots(await readLog(h))));
    return values.every(a => a.length >= 4 && last(a).tick > a[0].tick + 60);
  }, 20000);
  await halt(clients[1], "SIGKILL");
  await sleep(7000);
  const disconnectSamples=snapshots(await readLog(clients[0]));
  assert(last(disconnectSamples).state!==3, "Duel ended unexpectedly during reconnect window");
  const renewed=await request("/v1/matches/"+matchId+"/reconnect", {method:"POST",session:sessions[1],body:{reconnectToken:allocations[1].reconnectToken}});
  await startClient(1,renewed,sessionFiles[1],"-reconnect");
  await until("opponent reconnects to the original duel slot", async()=>{const state=await latest(clients[1]);return state&&state.slot===slots[1];},30000);
  const final = await until("public dedicated commits a normal match result", () =>
    request("/v1/matches/" + matchId + "/results", { session: sessions[0], waitCodes: ["MATCH_NOT_FINISHED"] }), 360000, 2500);
  assert.equal(final.state, "FINISHED", "Public match failed instead of finishing");
  for(const session of sessions) assert.deepEqual(await request("/v1/matches/" + matchId + "/results", { session }), final, "All accounts must agree on the result");
  assert.equal(final.participants.length, 2);
  assert.equal(final.participants.filter(p => p.playerId).length, 2);
  assert(final.participants.filter(p => p.isMvp).length <= 1, "At most one human can be MVP");
  for (const session of sessions) {
    const history = await request("/v1/history", { session });
    assert(history.matches.some(m => m.matchId === matchId && m.state === "FINISHED"), "Committed result missing from account history");
  }
  report.result = { matchId, blueScore: final.blueScore, redScore: final.redScore, durationSeconds: final.durationSeconds,
    humanParticipants: 2, participants: 2 };
  await passed("both accounts agree on committed result and persisted history");
  report.clients = [];
  for(let i=0;i<2;i++) {
    const text=await readLog(clients[i]);
    const samples=snapshots(text);
    const bots=text.split("\n").filter(line=>/state=1 /.test(line)).map(line=>/packets=\d+ bots=(\d+)/.exec(line)).filter(Boolean).map(m=>+m[1]);
    assert(bots.length>=4 && bots.every(b=>b===0), "Server bots present or missing bot telemetry on client "+i);
    const active=samples.filter(s=>s.state===1);
    const cadence=[];
    for(let j=1;j<active.length;j++){let dt=active[j].serverTime-active[j-1].serverTime;if(dt>0)cadence.push((active[j].tick-active[j-1].tick)/dt);}
    report.clients.push({slot:slots[i],samples:samples.length,botSamples:bots.length,maxBots:Math.max(...bots),meanRttMs:Math.round(samples.reduce((n,s)=>n+s.rtt,0)/samples.length),maxLossPercent:Math.max(...samples.map(s=>s.loss)),medianTickRate:cadence.sort((a,b)=>a-b)[Math.floor(cadence.length/2)]});
  }
  await passed("both clients saw zero server bots throughout active gameplay");
  const samplesByClient=await Promise.all(clients.map(async c=>snapshots(await readLog(c))));
  let pairs=0,exactTickPairs=0,maxBallDifference=0;
  for(const other of samplesByClient.slice(1)) {
    let viewerPairs=0;
    for(const a of samplesByClient[0]) {
      const b=other.reduce((best,s)=>!best||Math.abs(s.tick-a.tick)<Math.abs(best.tick-a.tick)?s:best,null);
      if(!b)continue;
      const delta=Math.abs(b.tick-a.tick);
      if(delta>2 || (delta && (a.state!==b.state || a.blue!==b.blue || a.red!==b.red)))continue;
      if(!delta)assert(a.blue===b.blue && a.red===b.red,"Same-tick scores differ");
      const distance=Math.hypot(...a.ball.map((v,i)=>v-b.ball[i]));
      assert(distance<=.12+1.8*delta,"Time-aligned authoritative ball positions differ");
      viewerPairs++;pairs++;if(!delta)exactTickPairs++;maxBallDifference=Math.max(maxBallDifference,distance);
    }
    assert(viewerPairs>=4,"Not enough aligned snapshots for one of the two clients");
  }
  const rtts=samplesByClient.flat().map(s=>s.rtt).filter(v=>v>0);
  report.network={comparedSnapshotPairs:pairs,exactTickPairs,maxTimeAlignedBallDifference:+maxBallDifference.toFixed(3),
    meanAppRttMs:Math.round(rtts.reduce((a,b)=>a+b,0)/rtts.length),
    maxObservedLossPercent:Math.max(0,...samplesByClient.flat().map(s=>s.loss))};
  await passed("both clients agree on time-aligned public ball and score snapshots");
  await checkRuntime(); await passed("no client runtime exception markers");
  report.passed = true; log("PASS: " + join(out, "report.json"));
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1; log("FAIL: " + error.message);
} finally {
  await Promise.all(children.map(h => halt(h)));
  if (!report.passed) for (const session of sessions) {
    try {
      if (matchId) await request("/v1/matches/" + matchId + "/leave", { method: "POST", session });
      else if (roomCode) await request("/v1/rooms/" + roomCode, { method: "DELETE", session });
    } catch {}
  }
  for (const session of sessions) {
    try { await request("/v1/me", {method:"DELETE",session}); }
    catch { /* Deletion may be blocked until the server completes its end-of-match grace period. */ }
  }
  for (const path of credentialFiles) await unlink(path).catch(() => {});
  report.finishedUtc = new Date().toISOString(); await saveReport();
  log("Redacted report and client logs: " + out);
}
