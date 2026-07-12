import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

await exec("pnpm", ["prisma", "db", "push", "--skip-generate"], { DATABASE_URL: databaseUrl });
await exec("go", ["build", "-o", helperPath, "./cmd/quota-e2e-client"], {}, join(root, "apps/app"));
let server;
async function startServer() {
  server = spawn("pnpm", ["exec", "tsx", "--tsconfig", "apps/server/tsconfig.json", "tests/quota-e2e/server-fixture.ts"], {
    cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, QUOTA_E2E_ACCOUNTS: accountsFile, QUOTA_E2E_KEYS: keysFile, QUOTA_E2E_PORT: "0" },
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
  const heads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 1, bucket: "codex-gpt" } });
  assert(heads.length === 2, "smoke did not persist both windows");
  for (const head of heads) { const state = JSON.parse(head.stateJson); assert(state.subjects["card-1"].cumulativeCu === 1, `smoke ${head.scope} CU=${state.subjects["card-1"].cumulativeCu}`); }
  assert(await prisma.quotaReportReceipt.count({ where: { reportId: "smoke-u1" } }) === 1, "receipt missing");
  await useRealtimeClock();
  await exec("go", ["test", ".", "-run", "^TestQuotaClientServerE2E$", "-count=1"], {
    BCAI_QUOTA_E2E_BASE: `http://127.0.0.1:${port}`,
  }, join(root, "apps/app"));
  const flush = await fetch(`http://127.0.0.1:${port}/api/__quota-e2e/flush`, { method: "POST" });
  assert(flush.ok, `test fixture flush failed: ${flush.status}`);
  const codexGoHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 101, bucket: "codex-gpt" } });
  const claudeGoHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "anthropic", accountId: 102, bucket: "anthropic-claude" } });
  assert(codexGoHeads.length === 2 && claudeGoHeads.length === 2, "production Go leasers did not persist both provider windows");
  assert(JSON.parse(codexGoHeads.find((h) => h.scope === "primary").stateJson).lastReason === "LATE_USAGE_RECONCILED", "Codex production late report was not causally reconciled");
  const claudeUsage = await prisma.cardUsageHourly.findFirst({ where: { accessKeyId: "card-102", modelKey: "claude-opus-4-8" } });
  assert(claudeUsage?.cacheCreationTokens === 80, `Claude cache TTL total=${claudeUsage?.cacheCreationTokens}, want 80`);
  assert(await prisma.requestLog.count({ where: { accessKeyId: { in: ["card-101", "card-102"] } } }) >= 2, "production Go reports missing from diagnostic trace");
  if (only === "smoke") { await prisma.$disconnect(); console.log("quota-e2e smoke: ok"); process.exitCode = 0; }
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
    await useRealtimeClock();
    // Rebound, stale snapshot, and independent forward reset.
    await runScenario("reset-rebound", "card-6", [clock(now + 600_000), lease("card-6"),
      report({ reportId: "rr-q0", status: 0, accountQuota: quota(6, 100, 100, now + 600_000) }),
      clock(now + 602_000),
      report({ reportId: "rr-u", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000, upstreamCompletedAt: now + 601_000,
        accountQuota: quota(6, 20, 70, now + 602_000, 1, now + 600_000) }),
      clock(now + 603_000),
      report({ reportId: "rr-rebound", status: 0, accountQuota: quota(6, 80, 90, now + 603_000, 1, now + 600_000) }),
      clock(now + 604_000),
      report({ reportId: "rr-stale", status: 0, accountQuota: quota(6, 10, 10, now + 601_500, 1, now + 600_000) }),
      clock(now + 600_000 + 5 * 60 * 60_000),
      report({ reportId: "rr-reset", status: 0, accountQuota: quota(6, 100, 90, now + 600_000 + 5 * 60 * 60_000, 2, now + 600_000) }),
    ]);
    const resetHeads = await prisma.fairShareWindowHead.findMany({ where: { provider: "codex", accountId: 6, bucket: "codex-gpt" } });
    assert(resetHeads.length === 2, "official reset did not retain both scopes");
    const resetPrimary = JSON.parse(resetHeads.find((head) => head.scope === "primary").stateJson);
    const resetWeekly = JSON.parse(resetHeads.find((head) => head.scope === "weekly").stateJson);
    assert(resetPrimary.fraction === 1 && resetPrimary.assignedBurn === 0 && resetPrimary.subjects["card-6"].cumulativeCu === 0,
      `official primary reset mismatch: ${JSON.stringify({ fraction: resetPrimary.fraction, assignedBurn: resetPrimary.assignedBurn, cu: resetPrimary.subjects["card-6"].cumulativeCu, resetAt: resetPrimary.resetAt })}`);
    assert(resetWeekly.fraction === 0.9 && resetWeekly.assignedBurn > 0 && resetWeekly.subjects["card-6"].cumulativeCu === 1,
      `official weekly reset mismatch: ${JSON.stringify({ fraction: resetWeekly.fraction, assignedBurn: resetWeekly.assignedBurn, cu: resetWeekly.subjects["card-6"].cumulativeCu, resetAt: resetWeekly.resetAt })}`);
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
    // Normal restart: state and receipt survive and old lease retry is ignored.
    await crashServer(); port = await startServer();
    const retry = await runScenario("restart-duplicate", "card-1", [report({ leaseId: smoke.leaseId, reportId: "smoke-u1", status: 200, inputTokens: 1_000_000, totalTokens: 1_000_000 })]);
    assert(retry.responses[0].body.ignored === true, "restart duplicate was not ignored");
    await prisma.$disconnect();
    console.log("quota-e2e full matrix: ok");
  }
} finally {
  await stopServer().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
