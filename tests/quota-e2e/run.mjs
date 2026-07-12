import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";

const root = resolve(import.meta.dirname, "../..");
const only = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : "all";
const dir = await mkdtemp(join(tmpdir(), "gfa-quota-e2e-"));
const databasePath = join(dir, "quota.db");
const databaseUrl = `file:${databasePath}`;
const accountsFile = join(dir, "accounts.json");
const keysFile = join(dir, "keys.json");
const helperPath = join(dir, "quota-e2e-client");
const cards = Array.from({ length: 110 }, (_, i) => ({
  id: `card-${i + 1}`, key: `key-${i + 1}`, status: "active", durationMs: 86_400_000,
  bindings: { codex: i + 1, anthropic: i + 1 }, weight: 1,
}));
cards[8].salesSeatCapacity = { codex: 2 };
// Legacy cutover fixture: two cards already share account 70 before the first
// window-cu process starts.
cards[69].salesSeatCapacity = { codex: 2 };
cards[70].bindings.codex = 70;
cards[70].salesSeatCapacity = { codex: 2 };
// Two marketed-exclusive cards intentionally share one mother account. The
// backend allocates each half of the real account while both clients retain
// exclusive single-bar presentation.
for (const index of [79, 80]) {
  cards[index].bindings.codex = 80;
  cards[index].weight = 8;
  cards[index].exclusive = true;
  cards[index].salesSeatCapacity = { codex: 8 };
}
// One exclusive plus one shared card on the same account.
cards[81].bindings.codex = 82;
cards[81].weight = 8;
cards[81].exclusive = true;
cards[81].salesSeatCapacity = { codex: 8 };
cards[82].bindings.codex = 82;
cards[82].weight = 1;
cards[82].exclusive = false;
cards[82].salesSeatCapacity = { codex: 8 };
// Three ordinary shared cards sold into a two-seat mother account.
for (const index of [83, 84, 85]) {
  cards[index].bindings.codex = 84;
  cards[index].weight = 1;
  cards[index].exclusive = false;
  cards[index].salesSeatCapacity = { codex: 2 };
}
await writeFile(accountsFile, JSON.stringify({ accounts: cards.map((_, i) => ({ id: i + 1, email: `a${i + 1}@x.test`, refreshToken: "rt", enabled: true, planType: "pro" })) }));
await writeFile(keysFile, JSON.stringify({ keys: cards }));
await writeFile(databasePath, "");

function exec(command, args, env = {}, cwd = root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d); child.stderr.on("data", (d) => stderr += d);
    child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

// Exercise the production migration chain, not a schema-only db push. This
// catches migration/schema drift before the quota fixture starts.
await exec("pnpm", ["prisma", "migrate", "deploy"], { DATABASE_URL: databaseUrl });
const legacySeedAt = Date.now() - 60_000;
const seedPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
await seedPrisma.$connect();
await seedPrisma.fairShareWindow.createMany({ data: [
  { provider: "codex", accountId: 70, bucket: "codex-gpt", cardId: "card-70", windowStart: BigInt(legacySeedAt), weightedUsed: 999, attributedShare: 0.3, lockedDenominator: 2, lastFraction: 0.6, isParticipant: true, share: 0.5, isActive: true, isExclusive: false },
  { provider: "codex", accountId: 70, bucket: "codex-gpt", cardId: "card-71", windowStart: BigInt(legacySeedAt), weightedUsed: 999, attributedShare: 0.1, lockedDenominator: 2, lastFraction: 0.6, isParticipant: true, share: 0.5, isActive: true, isExclusive: false },
  { provider: "codex", accountId: 70, bucket: "codex-gpt::weekly", cardId: "card-70", windowStart: BigInt(legacySeedAt), weightedUsed: 999, attributedShare: 0.2, lockedDenominator: 2, lastFraction: 0.7, isParticipant: true, share: 0.5, isActive: true, isExclusive: false },
  { provider: "codex", accountId: 70, bucket: "codex-gpt::weekly", cardId: "card-71", windowStart: BigInt(legacySeedAt), weightedUsed: 999, attributedShare: 0.05, lockedDenominator: 2, lastFraction: 0.7, isParticipant: true, share: 0.5, isActive: true, isExclusive: false },
] });
await seedPrisma.$disconnect();
await exec("go", ["build", "-o", helperPath, "./cmd/quota-e2e-client"], {}, join(root, "apps/app"));
let server;
async function startServer() {
  server = spawn("pnpm", ["exec", "tsx", "--tsconfig", "apps/server/tsconfig.json", "tests/quota-e2e/server-fixture.ts"], {
    cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, QUOTA_E2E_ACCOUNTS: accountsFile, QUOTA_E2E_KEYS: keysFile, QUOTA_E2E_PORT: "0", QUOTA_E2E_FLUSH_INTERVAL_MS: "50" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    server.stdout.on("data", (d) => { buffer += d; const m = buffer.match(/QUOTA_E2E_READY (\d+)/); if (m) resolvePromise(Number(m[1])); });
    server.stderr.on("data", (d) => process.stderr.write(d));
    server.on("exit", (code) => reject(new Error(`quota E2E server exited early: ${code}`)));
  });
}
async function stopServer() {
  if (!server) return;
  const child = server;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  server = null;
}
async function crashServer() {
  if (!server) return;
  const child = server;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 1000))]);
  server = null;
}

function quota(accountId, hourly, weekly, observedAt, resetStep = 1, resetAnchor = observedAt) {
  return { accountId, observedAt, codexQuota: {
    hourlyPercent: hourly, weeklyPercent: weekly,
    hourlyResetTime: new Date(resetAnchor + resetStep * 5 * 60 * 60_000).toISOString(),
    weeklyResetTime: new Date(resetAnchor + resetStep * 7 * 24 * 60 * 60_000).toISOString(),
  }};
}
const lease = (card, model = "gpt-5.6-luna") => ({ method: "POST", path: "/api/app/lease/codex/lease-token", body: { clientId: card, modelKey: model } });
const report = (body, parallel = 0) => ({ method: "POST", path: "/api/app/lease/codex/report-result", body: { leaseId: "$leaseId", modelKey: "gpt-5.6-luna", ...body }, parallel });
function claudeQuota(accountId, hourly, weekly, observedAt, resetStep = 1, resetAnchor = observedAt) {
  return { accountId, observedAt, claudeQuota: {
    hourlyPercent: hourly, weeklyPercent: weekly,
    hourlyResetTime: new Date(resetAnchor + resetStep * 5 * 60 * 60_000).toISOString(),
    weeklyResetTime: new Date(resetAnchor + resetStep * 7 * 24 * 60 * 60_000).toISOString(),
  }};
}
const claudeLease = (card, model = "claude-opus-4-8") => ({ method: "POST", path: "/api/app/lease/anthropic/lease-token", body: { clientId: card, modelKey: model } });
const claudeReport = (body, parallel = 0) => ({ method: "POST", path: "/api/app/lease/anthropic/report-result", body: { leaseId: "$leaseId", modelKey: "claude-opus-4-8", ...body }, parallel });
const clock = (at) => ({ method: "POST", path: "/api/__quota-e2e/time", body: { now: at } });
async function useRealtimeClock() {
  const response = await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/time`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ realtime: true }) });
  assert(response.ok, "failed to restore E2E realtime clock");
}
async function runScenario(name, cardId, operations) {
  const file = join(dir, `${name}.json`); await writeFile(file, JSON.stringify({ cardId, operations }));
  const output = await exec(helperPath, ["--base", `http://127.0.0.1:${port}`, "--scenario", file], {}, join(root, "apps/app"));
  return JSON.parse(output);
}
async function persistKeys() { await writeFile(keysFile, JSON.stringify({ keys: cards })); }
function assert(value, message) { if (!value) throw new Error(`${message}`); }
async function testControl(path, body = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  assert(response.ok, `test control ${path} failed: HTTP ${response.status} ${JSON.stringify(parsed)}`);
  return parsed;
}
async function waitFor(label, check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

let port = await startServer();
const now = Date.now();
try {
  const smoke = await runScenario("smoke", "card-1", [
    clock(now),
    lease("card-1"),
    report({ reportId: "smoke-q0", status: 0, accountQuota: quota(1, 100, 100, now) }),
    clock(now + 3000),
    report({ reportId: "smoke-u1", traceId: "smoke-trace", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
      requestStartedAt: now + 1000, upstreamCompletedAt: now + 2000, accountQuota: quota(1, 80, 90, now + 3000, 1, now) }),
    report({ reportId: "smoke-u1", traceId: "smoke-trace", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000 }),
  ]);
  assert(smoke.responses.at(-1).body.ignored === true, "duplicate report was not ignored");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl }); await prisma.$connect();
  // One-shot segment-v1 -> window-cu cutover happens during real Nest startup.
  // Public blood bars must match the legacy T/e values and imported rows must
  // become restartable heads without inventing post-cutover CU.
  const cutoverHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 70, bucket: "codex-gpt" } });
  assert(cutoverHeads.length === 2, "startup cutover did not checkpoint both heads");
  for (const head of cutoverHeads) {
    const state = JSON.parse(head.stateJson);
    assert(Object.values(state.subjects).every((subject) => subject.cumulativeCu === 0), `cutover invented ${head.scope} CU`);
  }
  const cutoverA = await runScenario("cutover-a", "card-70", [{ ...lease("card-70"), allowStatus: 429 }]);
  const cutoverB = await runScenario("cutover-b", "card-71", [{ ...lease("card-71"), allowStatus: 429 }]);
  const cutoverPrimaryDebug = JSON.parse(cutoverHeads.find((head) => head.scope === "primary").stateJson);
  assert(cutoverA.responses[0].status === 200 && Math.abs(cutoverA.responses[0].body.fairShareQuota["codex-gpt"].fraction - 0.4) < 1e-9,
    `cutover changed card-70 primary blood bar: ${JSON.stringify(cutoverPrimaryDebug)}`);
  assert(cutoverB.responses[0].status === 200 && Math.abs(cutoverB.responses[0].body.fairShareQuota["codex-gpt"].fraction - 0.8) < 1e-9,
    `cutover changed card-71 primary blood bar: ${JSON.stringify(cutoverPrimaryDebug)}`);
  const heads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 1, bucket: "codex-gpt" } });
  assert(heads.length === 2, "smoke did not persist both windows");
  for (const head of heads) { const state = JSON.parse(head.stateJson); assert(state.subjects["card-1"].cumulativeCu === 1, `smoke ${head.scope} CU=${state.subjects["card-1"].cumulativeCu}`); }
  assert(await prisma.quotaReportReceipt.count({ where: { reportId: "smoke-u1" } }) === 1, "receipt missing");
  await useRealtimeClock();
  await exec("go", ["test", ".", "-run", "^TestQuota(ClientServer|PendingQueue)E2E$", "-count=1"], {
    BCAI_QUOTA_E2E_BASE: `http://127.0.0.1:${port}`,
  }, join(root, "apps/app"));
  const flush = await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/flush`, { method: "POST" });
  assert(flush.ok, `test fixture flush failed: ${flush.status}`);
  const codexGoHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 101, bucket: "codex-gpt" } });
  const claudeGoHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "anthropic", accountId: 102, bucket: "anthropic-claude" } });
  assert(codexGoHeads.length === 2 && claudeGoHeads.length === 2, "production Go leasers did not persist both provider windows");
  assert(JSON.parse(codexGoHeads.find((h) => h.scope === "primary").stateJson).lastReason === "LATE_USAGE_RECONCILED", "Codex production late report was not causally reconciled");
  const claudeUsage = await prisma.cardUsageHourly.findFirst({ where: { accessKeyId: "card-102", modelKey: "claude-opus-4-8" } });
  assert(claudeUsage?.cacheCreationTokens === 200_080, `Claude cache TTL total=${claudeUsage?.cacheCreationTokens}, want 200080`);
  assert(await prisma.requestLog.count({ where: { accessKeyId: { in: ["card-101", "card-102"] } } }) >= 2, "production Go reports missing from diagnostic trace");

  // Exclusive oversell display contract: effective fraction remains conserved,
  // while personalFraction only follows usage attributed to that card.
  {
    const id = 80, t = now + 8_000_000;
    const a = await runScenario("exclusive-oversell-a-baseline", "card-80", [
      clock(t), lease("card-80"),
      report({ reportId: "exclusive-a-q0", status: 0, accountQuota: quota(id, 100, 100, t) }),
    ]);
    const b = await runScenario("exclusive-oversell-b-baseline", "card-81", [
      clock(t + 1), lease("card-81"),
      report({ reportId: "exclusive-b-q0", status: 0, accountQuota: quota(id, 100, 100, t + 1, 1, t) }),
    ]);
    // Unknown mother burn happens before A's request, so it cannot be falsely
    // attributed to A when the later usage event is replayed.
    await runScenario("exclusive-oversell-unattributed", "card-81", [
      clock(t + 10),
      { method: "POST", path: "/api/app/lease/codex/report-result", body: {
        leaseId: b.leaseId, reportId: "exclusive-unattributed", status: 0, modelKey: "gpt-5.6-luna",
        accountQuota: quota(id, 80, 90, t + 10, 1, t),
      } },
    ]);
    await runScenario("exclusive-oversell-a-use", "card-80", [
      clock(t + 30),
      { method: "POST", path: "/api/app/lease/codex/report-result", body: {
        leaseId: a.leaseId, reportId: "exclusive-a-u1", status: 200, modelKey: "gpt-5.6-luna",
        inputTokens: 1_000_000, totalTokens: 1_000_000,
        requestStartedAt: t + 20, upstreamCompletedAt: t + 25,
        accountQuota: quota(id, 60, 80, t + 30, 1, t),
      } },
    ]);
    const qa = await runScenario("exclusive-oversell-a-read", "card-80", [lease("card-80")]);
    const qb = await runScenario("exclusive-oversell-b-read", "card-81", [lease("card-81")]);
    const aBody = qa.responses[0].body, bBody = qb.responses[0].body;
    const af = aBody.fairShareQuota?.["codex-gpt"], bf = bBody.fairShareQuota?.["codex-gpt"];
    const aw = aBody.weeklyFairShareQuota?.["codex-gpt"], bw = bBody.weeklyFairShareQuota?.["codex-gpt"];
    assert(aBody.accessKeyStatus?.exclusive === true && bBody.accessKeyStatus?.exclusive === true,
      "oversold exclusive cards lost their exclusive display flag");
    assert(Math.abs(af.personalFraction - 0.6) < 1e-9, `exclusive A personal=${af?.personalFraction}, want 0.6`);
    assert(Math.abs(bf.personalFraction - 1) < 1e-9, `exclusive B personal=${bf?.personalFraction}, want 1`);
    assert(af.fraction < af.personalFraction && bf.fraction < bf.personalFraction,
      `effective fractions were not conservation-scaled: A=${JSON.stringify(af)} B=${JSON.stringify(bf)}`);
    assert(af.fraction * af.share + bf.fraction * bf.share <= 0.6 + 1e-9,
      `oversold exclusive effective total exceeded mother: A=${JSON.stringify(af)} B=${JSON.stringify(bf)}`);
    assert(aw.personalFraction < 1 && bw.personalFraction === 1,
      `exclusive weekly attribution leaked: A=${JSON.stringify(aw)} B=${JSON.stringify(bw)}`);
    assert(aw.fraction * aw.share + bw.fraction * bw.share <= 0.8 + 1e-9,
      `oversold exclusive weekly total exceeded mother: A=${JSON.stringify(aw)} B=${JSON.stringify(bw)}`);

    const flush = await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/flush`, { method: "POST" });
    assert(flush.ok, "exclusive display state did not flush before restart");
    const diagnosticRow = await prisma.requestLog.findFirst({ where: { reportId: "exclusive-a-u1" } });
    const diagnostic = JSON.parse(diagnosticRow?.reason || "{}");
    assert(diagnostic.quota?.primary?.personalFraction != null
      && diagnostic.quota?.primary?.effectiveFraction != null
      && diagnostic.quota?.primary?.accountFraction != null
      && diagnostic.quota?.primary?.revision != null,
    `exclusive request diagnostic missing quota state: ${diagnosticRow?.reason}`);
    await stopServer();
    port = await startServer();
    const restartedA = await runScenario("exclusive-oversell-a-restart", "card-80", [lease("card-80")]);
    const restartedB = await runScenario("exclusive-oversell-b-restart", "card-81", [lease("card-81")]);
    const raf = restartedA.responses[0].body.fairShareQuota?.["codex-gpt"];
    const rbf = restartedB.responses[0].body.fairShareQuota?.["codex-gpt"];
    assert(Math.abs(raf.personalFraction - 0.6) < 1e-9 && Math.abs(rbf.personalFraction - 1) < 1e-9,
      `exclusive personal fractions changed after restart: A=${JSON.stringify(raf)} B=${JSON.stringify(rbf)}`);

    // NOTE: the official-reset continuation of this scenario (which jumps the
    // global virtual clock forward by 7 days) runs at the very END of the
    // matrix — see "exclusive-oversell-official-reset" below. Every scenario
    // shares one virtual clock, so a +7d jump here would silently expire other
    // accounts' windows mid-matrix (the cutover-restart flake).
  }

  // Mixed mother: the exclusive card keeps its single-bar flag and personal
  // fraction, while the shared card remains a dual-bar client of the same pool.
  {
    const id = 82, t = now + 8_200_000;
    const exclusive = await runScenario("mixed-exclusive-baseline", "card-82", [
      clock(t), lease("card-82"),
      report({ reportId: "mixed-exclusive-q0", status: 0, accountQuota: quota(id, 100, 100, t) }),
    ]);
    await runScenario("mixed-shared-baseline", "card-83", [
      clock(t + 1), lease("card-83"),
      report({ reportId: "mixed-shared-q0", status: 0, accountQuota: quota(id, 100, 100, t + 1, 1, t) }),
    ]);
    await runScenario("mixed-exclusive-use", "card-82", [
      clock(t + 20),
      { method: "POST", path: "/api/app/lease/codex/report-result", body: {
        leaseId: exclusive.leaseId, reportId: "mixed-exclusive-u1", status: 200, modelKey: "gpt-5.6-luna",
        inputTokens: 1_000_000, totalTokens: 1_000_000,
        requestStartedAt: t + 10, upstreamCompletedAt: t + 15,
        accountQuota: quota(id, 90, 95, t + 20, 1, t),
      } },
    ]);
    const exRead = await runScenario("mixed-exclusive-read", "card-82", [lease("card-82")]);
    const shRead = await runScenario("mixed-shared-read", "card-83", [lease("card-83")]);
    const exBody = exRead.responses[0].body, shBody = shRead.responses[0].body;
    const ex = exBody.fairShareQuota?.["codex-gpt"], sh = shBody.fairShareQuota?.["codex-gpt"];
    const exWeekly = exBody.weeklyFairShareQuota?.["codex-gpt"], shWeekly = shBody.weeklyFairShareQuota?.["codex-gpt"];
    assert(exBody.accessKeyStatus?.exclusive === true, "mixed mother lost exclusive card flag");
    assert(shBody.accessKeyStatus?.exclusive === false, "mixed mother marked shared card exclusive");
    assert(ex.personalFraction < 1 && sh.personalFraction === 1,
      `mixed personal attribution leaked between cards: ex=${JSON.stringify(ex)} shared=${JSON.stringify(sh)}`);
    assert(ex.fraction * ex.share + sh.fraction * sh.share <= 0.9 + 1e-9,
      `mixed effective total exceeded mother: ex=${JSON.stringify(ex)} shared=${JSON.stringify(sh)}`);
    assert(exWeekly.personalFraction < 1 && shWeekly.personalFraction === 1,
      `mixed weekly attribution leaked: ex=${JSON.stringify(exWeekly)} shared=${JSON.stringify(shWeekly)}`);
    assert(exWeekly.fraction * exWeekly.share + shWeekly.fraction * shWeekly.share <= 0.95 + 1e-9,
      `mixed weekly total exceeded mother: ex=${JSON.stringify(exWeekly)} shared=${JSON.stringify(shWeekly)}`);
  }

  // Pure shared oversell remains a shared/dual-bar contract for every card.
  {
    const id = 84, t = now + 8_400_000;
    const a = await runScenario("shared-only-a-baseline", "card-84", [
      clock(t), lease("card-84"),
      report({ reportId: "shared-only-a-q0", status: 0, accountQuota: quota(id, 100, 100, t) }),
    ]);
    await runScenario("shared-only-b-baseline", "card-85", [
      clock(t + 1), lease("card-85"),
      report({ reportId: "shared-only-b-q0", status: 0, accountQuota: quota(id, 100, 100, t + 1, 1, t) }),
    ]);
    await runScenario("shared-only-c-baseline", "card-86", [
      clock(t + 2), lease("card-86"),
      report({ reportId: "shared-only-c-q0", status: 0, accountQuota: quota(id, 100, 100, t + 2, 1, t) }),
    ]);
    await runScenario("shared-only-a-use", "card-84", [
      clock(t + 20),
      { method: "POST", path: "/api/app/lease/codex/report-result", body: {
        leaseId: a.leaseId, reportId: "shared-only-a-u1", status: 200, modelKey: "gpt-5.6-luna",
        inputTokens: 1_000_000, totalTokens: 1_000_000,
        requestStartedAt: t + 10, upstreamCompletedAt: t + 15,
        accountQuota: quota(id, 80, 90, t + 20, 1, t),
      } },
    ]);
    const ar = await runScenario("shared-only-a-read", "card-84", [lease("card-84")]);
    const br = await runScenario("shared-only-b-read", "card-85", [lease("card-85")]);
    const cr = await runScenario("shared-only-c-read", "card-86", [lease("card-86")]);
    const ab = ar.responses[0].body, bb = br.responses[0].body, cb = cr.responses[0].body;
    const aq = ab.fairShareQuota?.["codex-gpt"], bq = bb.fairShareQuota?.["codex-gpt"], cq = cb.fairShareQuota?.["codex-gpt"];
    const aw = ab.weeklyFairShareQuota?.["codex-gpt"], bw = bb.weeklyFairShareQuota?.["codex-gpt"], cw = cb.weeklyFairShareQuota?.["codex-gpt"];
    assert(ab.accessKeyStatus?.exclusive === false && bb.accessKeyStatus?.exclusive === false && cb.accessKeyStatus?.exclusive === false,
      "pure shared mother changed display contract");
    assert(aq.personalFraction < 1 && bq.personalFraction === 1 && cq.personalFraction === 1,
      `pure shared attribution leaked: A=${JSON.stringify(aq)} B=${JSON.stringify(bq)} C=${JSON.stringify(cq)}`);
    assert(aq.fraction * aq.share + bq.fraction * bq.share + cq.fraction * cq.share <= 0.8 + 1e-9,
      `pure shared effective total exceeded mother: A=${JSON.stringify(aq)} B=${JSON.stringify(bq)} C=${JSON.stringify(cq)}`);
    assert(aw.personalFraction < 1 && bw.personalFraction === 1 && cw.personalFraction === 1,
      `pure shared weekly attribution leaked: A=${JSON.stringify(aw)} B=${JSON.stringify(bw)} C=${JSON.stringify(cw)}`);
    assert(aw.fraction * aw.share + bw.fraction * bw.share + cw.fraction * cw.share <= 0.9 + 1e-9,
      `pure shared weekly total exceeded mother: A=${JSON.stringify(aw)} B=${JSON.stringify(bw)} C=${JSON.stringify(cw)}`);
  }

  if (only === "smoke" || only === "oversell-display") {
    await prisma.$disconnect();
    console.log(`quota-e2e ${only}: ok`);
    process.exitCode = 0;
  }
  else {
    // Arrival permutations and boundary lateness, each isolated by account.
    for (const [index, late] of [1000, 30_000, 599_000, 601_000].entries()) {
      const id = index + 2, t = now + id * 100_000;
      await runScenario(`late-${late}`, `card-${id}`, [clock(t), lease(`card-${id}`),
        report({ reportId: `q0-${id}`, status: 0, accountQuota: quota(id, 100, 100, t) }),
        clock(t + 20_000),
        report({ reportId: `q1-${id}`, status: 0, accountQuota: quota(id, 90, 90, t + 20_000, 1, t) }),
        clock(t + 20_000 + late),
        report({ reportId: `u-${id}`, status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 9000, upstreamCompletedAt: t + 10_000 }),
      ]);
      await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/flush`, { method: "POST" });
      const expectedReason = late <= 599_000 ? "LATE_USAGE_RECONCILED" : "USAGE_EVIDENCE_MISSING";
      const trace = await prisma.requestLog.findFirst({ where: { provider: "codex", reportId: `u-${id}` } });
      const actualReason = trace?.primaryReason;
      assert(actualReason === expectedReason, `Codex lateness ${late} reason=${actualReason}, want ${expectedReason}`);
    }
    // The same causal ordering contract must hold through the production Claude
    // controller; provider symmetry is not inferred from the shared reducer.
    for (const [index, late] of [1000, 30_000, 599_000, 601_000].entries()) {
      const id = index + 12, t = now + id * 100_000;
      await runScenario(`claude-late-${late}`, `card-${id}`, [clock(t), claudeLease(`card-${id}`),
        claudeReport({ reportId: `cq0-${id}`, status: 0, accountQuota: claudeQuota(id, 100, 100, t) }),
        clock(t + 20_000),
        claudeReport({ reportId: `cq1-${id}`, status: 0, accountQuota: claudeQuota(id, 90, 90, t + 20_000, 1, t) }),
        clock(t + 20_000 + late),
        claudeReport({ reportId: `cu-${id}`, status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 9000, upstreamCompletedAt: t + 10_000 }),
      ]);
      await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/flush`, { method: "POST" });
      const expectedReason = late <= 599_000 ? "LATE_USAGE_RECONCILED" : "USAGE_EVIDENCE_MISSING";
      const trace = await prisma.requestLog.findFirst({ where: { provider: "anthropic", reportId: `cu-${id}` } });
      const actualReason = trace?.primaryReason;
      assert(actualReason === expectedReason, `Claude lateness ${late} reason=${actualReason}, want ${expectedReason}`);
    }

    // A1: an upstream "unknown" (-1) primary window must not be converted to
    // empty quota or block the next lease. The first real primary snapshot is a
    // baseline, not a fabricated 100% -> 90% burn.
    {
      const id = 41, t = now + 4_100_000;
      const partial = await runScenario("invalid-fraction", `card-${id}`, [clock(t), lease(`card-${id}`),
        report({ reportId: "invalid-fraction", status: 0, accountQuota: { accountId: id, observedAt: t, codexQuota: {
          hourlyPercent: -1, weeklyPercent: 80,
          weeklyResetTime: new Date(t + 7 * 24 * 60 * 60_000).toISOString(),
        } } }),
        lease(`card-${id}`),
      ]);
      assert(partial.responses[2].status === 200, "fraction=-1 falsely blocked the next lease");
      let primary = JSON.parse((await prisma.fairShareWindowHead.findFirst({ where: { accountId: id, scope: "primary" } })).stateJson);
      assert(primary.primed === false && primary.fraction === 1 && primary.assignedBurn === 0, "fraction=-1 mutated the primary window");
      await runScenario("invalid-fraction-real", `card-${id}`, [clock(t + 1_000), report({
        leaseId: partial.leaseId, reportId: "invalid-fraction-real", status: 0,
        accountQuota: { accountId: id, observedAt: t + 1_000, codexQuota: {
          hourlyPercent: 90, weeklyPercent: -1,
          hourlyResetTime: new Date(t + 5 * 60 * 60_000).toISOString(),
        } },
      })]);
      primary = JSON.parse((await prisma.fairShareWindowHead.findFirst({ where: { accountId: id, scope: "primary" } })).stateJson);
      assert(primary.primed === true && primary.fraction === 0.9 && primary.assignedBurn === 0, "first real snapshot was not adopted as baseline");
    }

    // A2 + A15: once a window is established, missing or backward resetAt may
    // update the observed fraction but cannot clear CU or shorten the boundary.
    for (const [id, mode] of [[42, "missing"], [43, "backward"]]) {
      const t = now + id * 100_000;
      const resetAt = t + 5 * 60 * 60_000;
      await runScenario(`reset-guard-${mode}`, `card-${id}`, [clock(t), lease(`card-${id}`),
        report({ reportId: `reset-guard-${mode}-q0`, status: 0, accountQuota: quota(id, 100, 100, t) }),
        clock(t + 2_000),
        report({ reportId: `reset-guard-${mode}-u`, status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 500, upstreamCompletedAt: t + 1_000,
          accountQuota: { accountId: id, observedAt: t + 1_500, codexQuota: {
            hourlyPercent: 80, weeklyPercent: 100,
            ...(mode === "backward" ? { hourlyResetTime: new Date(resetAt - 60 * 60_000).toISOString() } : {}),
            weeklyResetTime: new Date(t + 7 * 24 * 60 * 60_000).toISOString(),
          } },
        }),
      ]);
      const state = JSON.parse((await prisma.fairShareWindowHead.findFirst({ where: { accountId: id, scope: "primary" } })).stateJson);
      assert(state.resetAt === resetAt, `${mode} resetAt changed the established boundary`);
      assert(state.subjects[`card-${id}`].cumulativeCu === 1, `${mode} resetAt cleared current-window CU`);
      assert(Math.abs(state.assignedBurn - 0.2) < 1e-9, `${mode} resetAt lost the fraction delta`);
    }

    // A14: two snapshots plus the intervening usage must materialize exactly the
    // same accounting state for every network arrival order inside ten minutes.
    {
      const t = now + 4_400_000;
      const eventQuota = (id, percent, observedAt) => quota(id, percent, percent, observedAt, 1, t);
      const permutations = [
        ["old", "usage", "new"], ["old", "new", "usage"],
        ["usage", "old", "new"], ["usage", "new", "old"],
        ["new", "old", "usage"], ["new", "usage", "old"],
      ];
      const materialized = [];
      for (const [index, ordering] of permutations.entries()) {
        const id = 55 + index;
        const operations = [clock(t), lease(`card-${id}`),
          report({ reportId: `order-${id}-q0`, status: 0, accountQuota: eventQuota(id, 100, t) })];
        for (const [arrivalIndex, event] of ordering.entries()) {
          operations.push(clock(t + 30_000 + arrivalIndex * 1_000));
          operations.push(event === "usage"
            ? report({ reportId: `order-${id}-usage`, status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
                requestStartedAt: t + 14_000, upstreamCompletedAt: t + 15_000 })
            : report({ reportId: `order-${id}-${event}`, status: 0,
                accountQuota: eventQuota(id, event === "old" ? 90 : 70, event === "old" ? t + 10_000 : t + 20_000) }));
        }
        await runScenario(`snapshot-order-${ordering.join("-")}`, `card-${id}`, operations);
        const state = JSON.parse((await prisma.fairShareWindowHead.findFirst({ where: { accountId: id, scope: "primary" } })).stateJson);
        const subject = state.subjects[`card-${id}`];
        materialized.push({ fraction: state.fraction, assignedBurn: state.assignedBurn, unattributedShare: state.unattributedShare,
          cumulativeCu: subject.cumulativeCu, carriedAttributedShare: subject.carriedAttributedShare, attributedShare: subject.attributedShare });
      }
      for (const state of materialized.slice(1)) {
        assert(JSON.stringify(state) === JSON.stringify(materialized[0]), `in-horizon arrival order changed accounting: ${JSON.stringify(materialized)}`);
      }
      assert(Math.abs(materialized[0].assignedBurn - 0.2) < 1e-9 && Math.abs(materialized[0].unattributedShare - 0.1) < 1e-9,
        `snapshot permutation partitioned burn incorrectly: ${JSON.stringify(materialized[0])}`);
    }

    // A6: a dated model ID must resolve by the longest quota-rates alias. Mini is
    // 0.75 CU/M input; matching the shorter gpt-5.4 alias would incorrectly charge 2.5.
    {
      const id = 46, t = now + 4_600_000, model = "gpt-5.4-mini-2026-03-17";
      const result = await runScenario("dated-model-rate", `card-${id}`, [clock(t), lease(`card-${id}`, model),
        report({ reportId: "dated-model-q0", status: 0, modelKey: model, accountQuota: quota(id, 100, 100, t) }),
        clock(t + 1_000),
        report({ reportId: "dated-model-u", status: 200, modelKey: model, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 400, upstreamCompletedAt: t + 500 }),
      ]);
      const datedHeads = await prisma.fairShareWindowHead.findMany({ where: { accountId: id, scope: "primary" } });
      const state = JSON.parse(datedHeads.find((head) => head.bucket === "codex-gpt").stateJson);
      assert(Math.abs(state.subjects[`card-${id}`].cumulativeCu - 0.75) < 1e-9,
        `dated mini model used the wrong quota multiplier: CU=${state.subjects[`card-${id}`].cumulativeCu}, responses=${JSON.stringify(result.responses)}`);
    }

    // Provider symmetry and high-cost fallback: dated Claude aliases must keep
    // their exact tier, and Fable must remain twice Opus rather than collapsing
    // into a single family multiplier.
    for (const [id, model, expectedCu] of [
      [47, "claude-opus-4-8-2026-07-01", 5],
      [50, "claude-fable-5-2026-07-01", 10],
    ]) {
      const t = now + id * 100_000;
      await runScenario(`claude-model-rate-${id}`, `card-${id}`, [clock(t), claudeLease(`card-${id}`, model),
        claudeReport({ reportId: `claude-model-rate-${id}-q0`, status: 0, modelKey: model, accountQuota: claudeQuota(id, 100, 100, t) }),
        clock(t + 1_000),
        claudeReport({ reportId: `claude-model-rate-${id}-u`, status: 200, modelKey: model,
          inputTokens: 1_000_000, totalTokens: 1_000_000, requestStartedAt: t + 400, upstreamCompletedAt: t + 500 }),
      ]);
      const state = JSON.parse((await prisma.fairShareWindowHead.findFirst({
        where: { provider: "anthropic", accountId: id, bucket: "anthropic-claude", scope: "primary" },
      })).stateJson);
      assert(Math.abs(state.subjects[`card-${id}`].cumulativeCu - expectedCu) < 1e-9,
        `${model} CU=${state.subjects[`card-${id}`].cumulativeCu}, want ${expectedCu}`);
    }

    // A7: exhaust only the user's 5h share while the mother account still has
    // quota, then inspect the real controller's 429 body.
    {
      const id = 48, t = now + 4_800_000;
      const result = await runScenario("chinese-429", `card-${id}`, [clock(t), lease(`card-${id}`),
        report({ reportId: "chinese-429-q0", status: 0, accountQuota: quota(id, 100, 100, t) }),
        clock(t + 1_000),
        report({ reportId: "chinese-429-u", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 400, upstreamCompletedAt: t + 500, accountQuota: quota(id, 80, 100, t + 600, 1, t) }),
        { ...lease(`card-${id}`), allowStatus: 429 },
      ]);
      const denied = result.responses.at(-1);
      assert(denied.status === 429 && denied.body.code === "primary_exhausted", `429 reason contract mismatch: ${JSON.stringify(denied)}`);
      assert(typeof denied.body.error === "string" && /额度已用完/.test(denied.body.error) && !/exhausted/i.test(denied.body.error),
        `429 message is not user-facing Chinese: ${JSON.stringify(denied.body)}`);
    }

    // A28: for an allowed request the decision metadata must point at the window
    // that actually supplies the minimum remaining fraction.
    {
      const id = 49, t = now + 4_900_000;
      await runScenario("limiting-window", `card-${id}`, [clock(t), lease(`card-${id}`),
        report({ reportId: "limiting-window-q0", status: 0, accountQuota: quota(id, 10, 5, t) }),
      ]);
      const decision = await testControl("check", { provider: "codex", accountId: id, cardId: `card-${id}`, bucket: "codex-gpt" });
      assert(decision.allowed === true && decision.window === "7d", `allowed decision did not select weekly limiter: ${JSON.stringify(decision)}`);
      assert(decision.resetAt === t + 7 * 24 * 60 * 60_000, `allowed decision paired the wrong resetAt: ${JSON.stringify(decision)}`);
    }

    // A12: lease expiry is not request expiry. A long stream completed recently
    // is accepted, while an ancient completion outside the replay horizon is not.
    {
      const longT = now + 5_200_000;
      const long = await runScenario("long-stream-report", "card-52", [clock(longT), lease("card-52"),
        clock(longT + 2 * 60 * 60_000), report({ reportId: "long-stream-report", status: 200, inputTokens: 100, totalTokens: 100,
          requestStartedAt: longT, upstreamCompletedAt: longT + 2 * 60 * 60_000 - 100 }),
      ]);
      assert(long.responses.at(-1).body.ignored !== true, `recent long stream was rejected: ${JSON.stringify(long.responses.at(-1))}`);
      // Keep the entire matrix inside the seeded five-hour cutover window while
      // still exceeding the 35-minute replay horizon.
      const ancientT = longT + 2 * 60 * 60_000 + 60_000;
      const ancient = await runScenario("ancient-report", "card-53", [clock(ancientT), lease("card-53"),
        clock(ancientT + 36 * 60_000), report({ reportId: "ancient-report", status: 200, inputTokens: 100, totalTokens: 100,
          requestStartedAt: ancientT, upstreamCompletedAt: ancientT + 1_000 }),
      ]);
      assert(ancient.responses.at(-1).body.ignored === true && ancient.responses.at(-1).body.reason === "report_expired",
        `ancient report was not rejected at ingress: ${JSON.stringify(ancient.responses.at(-1))}`);
      assert(await prisma.quotaReportReceipt.count({ where: { reportId: "ancient-report" } }) === 0, "ancient report created a receipt");
      await useRealtimeClock();
    }

    // A4: a stale lower-revision checkpoint, including its synthetic receipt,
    // must lose at SQLite and leave the current head/card summary untouched.
    {
      const id = 54, t = now + 5_400_000;
      await runScenario("stale-checkpoint-base", `card-${id}`, [clock(t), lease(`card-${id}`),
        report({ reportId: "stale-checkpoint-q0", status: 0, accountQuota: quota(id, 100, 100, t) }),
        clock(t + 1_000),
        report({ reportId: "stale-checkpoint-u", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 400, upstreamCompletedAt: t + 500, accountQuota: quota(id, 80, 90, t + 600, 1, t) }),
      ]);
      const before = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: id, bucket: "codex-gpt" }, orderBy: { scope: "asc" } });
      const summarizeRows = (rows) => rows.map((row) => ({
        bucket: row.bucket,
        cardId: row.cardId,
        windowStart: String(row.windowStart),
        weightedUsed: row.weightedUsed,
        attributedShare: row.attributedShare,
        lockedDenominator: row.lockedDenominator,
        lastFraction: row.lastFraction,
        isParticipant: row.isParticipant,
        share: row.share,
        isActive: row.isActive,
        isExclusive: row.isExclusive,
      }));
      const beforeSummary = summarizeRows(await prisma.fairShareWindow.findMany({
        where: { provider: "codex", accountId: id },
        orderBy: [{ bucket: "asc" }, { cardId: "asc" }],
      }));
      await testControl("stale-checkpoint", { provider: "codex", accountId: id, bucket: "codex-gpt", reportId: "stale-checkpoint-receipt" });
      const after = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: id, bucket: "codex-gpt" }, orderBy: { scope: "asc" } });
      const afterSummary = summarizeRows(await prisma.fairShareWindow.findMany({
        where: { provider: "codex", accountId: id },
        orderBy: [{ bucket: "asc" }, { cardId: "asc" }],
      }));
      assert(JSON.stringify(after.map((row) => [String(row.revision), row.stateJson])) === JSON.stringify(before.map((row) => [String(row.revision), row.stateJson])),
        "stale checkpoint rolled a durable head backward");
      assert(JSON.stringify(afterSummary) === JSON.stringify(beforeSummary), "stale checkpoint changed card summary");
      assert(await prisma.quotaReportReceipt.count({ where: { reportId: "stale-checkpoint-receipt" } }) === 0, "stale checkpoint created an orphan receipt");
    }

    // A3: fail exactly one scheduled SQLite commit. The rejection must be caught,
    // the Nest process must remain healthy, and the following tick must persist.
    {
      const status = await testControl("background-flush-failure", { provider: "codex", accountId: 54, bucket: "codex-gpt" });
      assert(status.armed === true, "checkpoint fault was not armed");
      const fault = await waitFor("failed revision to retry into SQLite", async () => {
        const value = await testControl("fault-status", { provider: "codex" });
        return value.failures === 1 && value.recovered === true ? value : null;
      });
      assert(fault.failures === 1 && fault.recovered === true,
        `scheduled checkpoint was not retried durably: ${JSON.stringify(fault)}`);
      const health = await fetch(`http://127.0.0.1:${port}/api/app/lease/codex/health`);
      assert(health.ok, "scheduled flush rejection terminated the server");
    }
    await useRealtimeClock();
    // Cold-start proof for the cutover account: SIGKILL and restart, then the
    // legacy blood bar must be identical. Clock-jumping scenarios all run at
    // the end of the matrix, so no cross-scenario pollution can expire this
    // window in the meantime.
    await crashServer();
    port = await startServer();
    const restartedCutoverA = await runScenario("cutover-restart-a", "card-70", [lease("card-70")]);
    const restartedCutoverQuota = restartedCutoverA.responses[0].body.fairShareQuota?.["codex-gpt"];
    assert(restartedCutoverQuota && Math.abs(restartedCutoverQuota.fraction - 0.4) < 1e-9,
      `cutover blood bar missing/changed after restart: ${JSON.stringify(restartedCutoverA.responses[0].body)}`);

    // Rebound, an in-horizon reordered snapshot, and independent forward reset.
    await runScenario("reset-rebound", "card-6", [clock(now + 600_000), lease("card-6"),
      report({ reportId: "rr-q0", status: 0, accountQuota: quota(6, 100, 100, now + 600_000) }),
      clock(now + 602_000),
      report({ reportId: "rr-u", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
        requestStartedAt: now + 600_500, upstreamCompletedAt: now + 601_000,
        accountQuota: quota(6, 20, 70, now + 602_000, 1, now + 600_000) }),
      clock(now + 603_000),
      report({ reportId: "rr-rebound", status: 0, accountQuota: quota(6, 80, 90, now + 603_000, 1, now + 600_000) }),
      clock(now + 604_000),
      report({ reportId: "rr-stale", status: 0, accountQuota: quota(6, 10, 10, now + 601_500, 1, now + 600_000) }),
      clock(now + 600_000 + 5 * 60 * 60_000),
      lease("card-6"),
      report({ reportId: "rr-reset", status: 0, accountQuota: quota(6, 100, 90, now + 600_000 + 5 * 60 * 60_000, 2, now + 600_000) }),
    ]);
    const resetHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 6, bucket: "codex-gpt" } });
    assert(resetHeads.length === 2, "official reset did not retain both scopes");
    const resetPrimary = JSON.parse(resetHeads.find((head) => head.scope === "primary").stateJson);
    const resetWeekly = JSON.parse(resetHeads.find((head) => head.scope === "weekly").stateJson);
    assert(resetPrimary.fraction === 1 && resetPrimary.assignedBurn === 0 && resetPrimary.subjects["card-6"].cumulativeCu === 0,
      `official primary reset mismatch: ${JSON.stringify({ fraction: resetPrimary.fraction, assignedBurn: resetPrimary.assignedBurn, cu: resetPrimary.subjects["card-6"].cumulativeCu, resetAt: resetPrimary.resetAt })}`);
    assert(resetWeekly.fraction === 0.9 && resetWeekly.assignedBurn > 0 && resetWeekly.subjects["card-6"].cumulativeCu === 1,
      `official weekly reset mismatch: ${JSON.stringify({ fraction: resetWeekly.fraction, assignedBurn: resetWeekly.assignedBurn, unattributedShare: resetWeekly.unattributedShare, cu: resetWeekly.subjects["card-6"].cumulativeCu, resetAt: resetWeekly.resetAt, revision: resetWeekly.revision, lastReason: resetWeekly.lastReason, tail: resetWeekly.reorderTail?.length })}`);
    await useRealtimeClock();
    // Cross-account snapshot must not mutate account 7.
    await runScenario("cross-account", "card-7", [lease("card-7"), report({ reportId: "cross", status: 0, accountQuota: quota(8, 0, 0, now + 700_000) })]);
    const crossHeads = await prisma.fairShareWindowHead.findMany({ where: { accountId: 7 } });
    assert(crossHeads.length === 2, "cross-account report receipt did not checkpoint current windows");
    for (const head of crossHeads) {
      const state = JSON.parse(head.stateJson);
      assert(state.primed === false && state.fraction === 1, "cross-account snapshot polluted window");
    }
    // Join, renew, leave, and rebind through the production reload endpoint.
    await runScenario("member-base", "card-9", [lease("card-9"), report({ reportId: "m-q0", status: 0, accountQuota: quota(9, 100, 100, now + 710_000) })]);
    cards[9].bindings.codex = 9; cards[9].salesSeatCapacity = { codex: 2 }; await persistKeys();
    await runScenario("member-join", "card-9", [{ method: "POST", path: "/api/app/lease/codex/reload-access-keys", body: {} }]);
    let memberHead = await prisma.fairShareWindowHead.findFirst({ where: { accountId: 9, scope: "primary" } });
    let memberState = JSON.parse(memberHead.stateJson);
    assert(memberState.subjects["card-9"].active && memberState.subjects["card-10"].active, "mid-window join not applied");
    assert(Math.abs(memberState.subjects["card-9"].share + memberState.subjects["card-10"].share - 1) < 1e-9, "join shares invalid");
    cards[9].durationMs *= 2; await persistKeys();
    await runScenario("member-renew", "card-10", [{ method: "POST", path: "/api/app/lease/codex/reload-access-keys", body: {} }]);
    cards[8].bindings.codex = 0; await persistKeys();
    await runScenario("member-leave", "card-10", [{ method: "POST", path: "/api/app/lease/codex/reload-access-keys", body: {} }]);
    memberHead = await prisma.fairShareWindowHead.findFirst({ where: { accountId: 9, scope: "primary" } });
    memberState = JSON.parse(memberHead.stateJson);
    assert(memberState.subjects["card-9"].active === false, "mid-window leave not retained as inactive evidence");
    cards[9].bindings.codex = 10; await persistKeys();
    await runScenario("member-rebind", "card-10", [{ method: "POST", path: "/api/app/lease/codex/reload-access-keys", body: {} }]);
    memberHead = await prisma.fairShareWindowHead.findFirst({ where: { accountId: 9, scope: "primary" } });
    memberState = JSON.parse(memberHead.stateJson);
    assert(memberState.subjects["card-10"].active === false, "rebind left old membership active");

    // Invalid multi-user exclusive and oversell both retain the mother-cap invariant.
    cards[10].bindings.codex = 11; cards[10].exclusive = true; cards[11].bindings.codex = 11;
    for (let i = 19; i < 31; i++) { cards[i].bindings.codex = 20; cards[i].salesSeatCapacity = { codex: 2 }; }
    await persistKeys();
    await runScenario("exclusive-fallback", "card-11", [
      { method: "POST", path: "/api/app/lease/codex/reload-access-keys", body: {} }, lease("card-11"),
      report({ reportId: "ex-q0", status: 0, accountQuota: quota(11, 25, 25, now + 720_000) }),
    ]);
    await runScenario("oversell", "card-20", [lease("card-20"), report({ reportId: "over-q0", status: 0, accountQuota: quota(20, 60, 60, now + 730_000) })]);
    for (const accountId of [11, 20]) {
      const head = await prisma.fairShareWindowHead.findFirst({ where: { accountId, scope: "primary" } });
      const state = JSON.parse(head.stateJson); const active = Object.values(state.subjects).filter((s) => s.active);
      const raw = active.reduce((sum, s) => sum + Math.max(0, s.share - s.attributedShare), 0);
      const usable = Math.min(raw, state.fraction);
      assert(usable <= state.fraction + 1e-12, `mother cap broken for account ${accountId}`);
      assert(active.reduce((sum, s) => sum + s.share, 0) <= 1 + 1e-12, `shares oversold above mother for account ${accountId}`);
    }

    // Model multiplier parity: one million Sol input is 5 CU, Luna was 1 CU.
    await runScenario("model-rate", "card-40", [lease("card-40", "gpt-5.6-sol"),
      { ...report({ reportId: "sol-q0", status: 0, modelKey: "gpt-5.6-sol", accountQuota: quota(40, 100, 100, now + 740_000) }), body: { leaseId: "$leaseId", reportId: "sol-q0", status: 0, modelKey: "gpt-5.6-sol", accountQuota: quota(40, 100, 100, now + 740_000) } },
      { ...report({}), body: { leaseId: "$leaseId", reportId: "sol-u", status: 200, modelKey: "gpt-5.6-sol", inputTokens: 1_000_000, totalTokens: 1_000_000, upstreamCompletedAt: now + 741_000 } },
    ]);
    const solHead = await prisma.fairShareWindowHead.findFirst({ where: { accountId: 40, scope: "primary" } });
    assert(JSON.parse(solHead.stateJson).subjects["card-40"].cumulativeCu === 5, "model CU parity failed");
    // 100 simultaneous reports through the Go process and real HTTP controller.
    await runScenario("concurrency", "card-8", [lease("card-8"),
      report({ reportId: "c-q0", status: 0, accountQuota: quota(8, 100, 100, now + 800_000) }),
      report({ reportId: "c-$i", status: 200, inputTokens: 10_000, totalTokens: 10_000,
        requestStartedAt: now + 801_000, upstreamCompletedAt: now + 802_000 }, 100),
    ]);
    const concurrent = await prisma.quotaReportReceipt.count({ where: { accountId: 8 } });
    assert(concurrent === 101, `concurrent receipts=${concurrent}, want 101`);

    // Read the quota actually returned to 100 independent clients and prove the
    // public blood bars conserve the mother account. This deliberately avoids
    // inspecting/reusing the reducer's internal min/scale calculation.
    for (let i = 0; i < 100; i++) {
      cards[i].bindings.anthropic = 110;
      cards[i].exclusive = false;
      cards[i].salesSeatCapacity = { ...(cards[i].salesSeatCapacity ?? {}), anthropic: 100 };
    }
    cards[109].bindings.anthropic = 0;
    await persistKeys();
    await runScenario("anthropic-cap-reload", "card-1", [
      { method: "POST", path: "/api/app/lease/anthropic/reload-access-keys", body: {} },
      claudeLease("card-1"),
      claudeReport({ reportId: "anthropic-cap-q0", status: 0, accountQuota: claudeQuota(110, 60, 60, now + 900_000) }),
    ]);
    const clientBars = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      runScenario(`anthropic-cap-client-${i + 1}`, `card-${i + 1}`, [claudeLease(`card-${i + 1}`)])));
    for (const [field, scope] of [["fairShareQuota", "primary"], ["weeklyFairShareQuota", "weekly"]]) {
      const absoluteTotal = clientBars.reduce((sum, result) => {
        const quota = result.responses[0].body[field]?.["anthropic-claude"];
        assert(quota && Number.isFinite(quota.fraction) && Number.isFinite(quota.share), `client missing ${field}`);
        return sum + quota.fraction * quota.share;
      }, 0);
      const head = await prisma.fairShareWindowHead.findFirst({ where: { provider: "anthropic", accountId: 110, bucket: "anthropic-claude", scope } });
      const motherRemaining = JSON.parse(head.stateJson).fraction;
      assert(absoluteTotal <= motherRemaining + 1e-9, `${scope} clients oversold: ${absoluteTotal} > ${motherRemaining}`);
      assert(Math.abs(absoluteTotal - motherRemaining) < 1e-9, `${scope} public bars did not fully allocate mother remainder`);
    }
    // A8: membership changes while the process is down. Startup must load the old
    // window, reconcile the current key file, and durably checkpoint before ready.
    await runScenario("restart-membership-base", "card-72", [lease("card-72"),
      report({ reportId: "restart-membership-q0", status: 0, accountQuota: quota(72, 80, 90, now + 9_200_000) }),
    ]);
    await crashServer();
    cards[71].bindings.codex = 0;
    cards[72].bindings.codex = 72;
    cards[72].salesSeatCapacity = { codex: 2 };
    await persistKeys();
    port = await startServer();
    const membershipHead = await prisma.fairShareWindowHead.findFirst({ where: { provider: "codex", accountId: 72, bucket: "codex-gpt", scope: "primary" } });
    assert(membershipHead, "restart did not restore the membership window");
    const membershipState = JSON.parse(membershipHead.stateJson);
    assert(membershipState.subjects["card-72"].active === false && membershipState.subjects["card-73"].active === true,
      `restart membership was not reconciled: ${JSON.stringify(membershipState.subjects)}`);
    // Normal restart: state and receipt survive and old lease retry is ignored.
    const retry = await runScenario("restart-duplicate", "card-1", [report({ leaseId: smoke.leaseId, reportId: "smoke-u1", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000 })]);
    assert(retry.responses[0].body.ignored === true, "restart duplicate was not ignored");

    // 防重复扣:确认 checkpoint 失败(客户端拿到 5xx、必然重试)后,定时 flush
    // 必须把「窗口状态 + 回执」原子落库;崩溃重启后重试同一 reportId 不再计 CU。
    {
      const t = now + 9_400_000;
      const base = await runScenario("receipt-carry-base", "card-61", [clock(t), lease("card-61"),
        report({ reportId: "receipt-carry-q0", status: 0, accountQuota: quota(61, 100, 100, t) }),
      ]);
      await testControl("background-flush-failure", { provider: "codex", accountId: 61, bucket: "codex-gpt", requireReceipt: true });
      await runScenario("receipt-carry-usage", "card-61", [clock(t + 2_000),
        { ...report({ leaseId: base.leaseId, reportId: "receipt-carry-u1", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 500, upstreamCompletedAt: t + 1_000 }), allowStatus: 500 },
      ]);
      await waitFor("failed receipt to ride the next scheduled flush", async () =>
        (await prisma.quotaReportReceipt.count({ where: { reportId: "receipt-carry-u1" } })) === 1 ? true : null);
      await crashServer();
      port = await startServer();
      const retryAfterCrash = await runScenario("receipt-carry-retry", "card-61", [clock(t + 10_000),
        report({ leaseId: base.leaseId, reportId: "receipt-carry-u1", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 500, upstreamCompletedAt: t + 1_000 }),
      ]);
      assert(retryAfterCrash.responses.at(-1).body.ignored === true, "receipt-carry retry was not deduped after crash");
      const carryHead = await prisma.fairShareWindowHead.findFirst({ where: { provider: "codex", accountId: 61, bucket: "codex-gpt", scope: "primary" } });
      const carryCu = JSON.parse(carryHead.stateJson).subjects["card-61"].cumulativeCu;
      assert(carryCu === 1, `receipt-carry CU=${carryCu}, want exactly 1 (no double count)`);
    }

    // 长流式归因:lease 过期 + 清扫触发之后、35 分钟补报宽限之内,完成上报
    // 仍必须归因到原账号,不能变成无主消耗。
    {
      const t = now + 9_500_000;
      const stream = await runScenario("long-stream-base", "card-63", [clock(t), lease("card-63"),
        report({ reportId: "long-stream-q0", status: 0, accountQuota: quota(63, 100, 100, t) }),
      ]);
      // 42 分钟后:绑定 lease(TTL 40 分钟)已过期;另一张卡租号触发生产清扫路径。
      await testControl("time", { now: t + 42 * 60_000 });
      await runScenario("long-stream-sweeper", "card-64", [lease("card-64")]);
      await runScenario("long-stream-report", "card-63", [
        report({ leaseId: stream.leaseId, reportId: "long-stream-u1", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000,
          requestStartedAt: t + 1_000, upstreamCompletedAt: t + 42 * 60_000 - 100 }),
      ]);
      await testControl("flush");
      const streamHead = await prisma.fairShareWindowHead.findFirst({ where: { provider: "codex", accountId: 63, bucket: "codex-gpt", scope: "primary" } });
      const streamCu = JSON.parse(streamHead?.stateJson || "{}").subjects?.["card-63"]?.cumulativeCu;
      assert(streamCu === 1, `long-stream usage was not attributed after lease expiry: CU=${streamCu}, want 1`);
    }

    // 启动屏障:订阅表未就绪时放租必须 503(而不是拿残缺成员表算出 429),
    // 就绪后立即恢复正常租号。
    {
      await testControl("subscription-barrier", { provider: "codex" });
      const gated = await runScenario("warming-up-lease", "card-65", [{ ...lease("card-65"), allowStatus: 503 }]);
      assert(gated.responses[0].status === 503 && gated.responses[0].body.code === "server_warming_up",
        `not-ready lease was not gated: ${JSON.stringify(gated.responses[0])}`);
      await testControl("subscription-barrier", { provider: "codex", ready: true });
      const released = await runScenario("warming-up-released", "card-65", [lease("card-65")]);
      assert(released.responses[0].status === 200, `lease after readiness failed: ${JSON.stringify(released.responses[0])}`);
    }

    // A real forward reset clears both personal attribution and conservation
    // scaling for primary and weekly windows. Runs LAST: it moves the shared
    // virtual clock +7 days, which would expire every other scenario's window.
    {
      const id = 80, t = now + 8_000_000;
      const resetObservedAt = t + 7 * 24 * 60 * 60_000 + 1_000;
      await runScenario("exclusive-oversell-official-reset", "card-81", [
        clock(resetObservedAt),
        lease("card-81"),
        report({ reportId: "exclusive-official-reset", status: 0,
          accountQuota: quota(id, 100, 100, resetObservedAt, 1, resetObservedAt) }),
      ]);
      const resetA = await runScenario("exclusive-oversell-a-reset-read", "card-80", [lease("card-80")]);
      const resetB = await runScenario("exclusive-oversell-b-reset-read", "card-81", [lease("card-81")]);
      for (const body of [resetA.responses[0].body, resetB.responses[0].body]) {
        const primary = body.fairShareQuota?.["codex-gpt"];
        const weekly = body.weeklyFairShareQuota?.["codex-gpt"];
        assert(primary.personalFraction === 1 && primary.fraction === 1,
          `exclusive primary did not reset: ${JSON.stringify(primary)}`);
        assert(weekly.personalFraction === 1 && weekly.fraction === 1,
          `exclusive weekly did not reset: ${JSON.stringify(weekly)}`);
      }
      await useRealtimeClock();
    }
    await prisma.$disconnect();
    console.log("quota-e2e full matrix: ok");
  }
} finally {
  await stopServer().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
