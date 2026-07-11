import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { RemoteCodexService } from "../../remote-codex/service/remote-codex.service";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

const T = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;
const BUCKET = "codex-gpt";

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

describe("causal report-result integration", () => {
  let dir: string;
  let accountsFile: string;
  let keysFile: string;
  let now: number;
  let leaseSeq: number;
  let prisma: PrismaClient;
  const tokenProvider = vi.fn();
  const services: RemoteCodexService[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-report-ordering-"));
    accountsFile = path.join(dir, "accounts.json");
    keysFile = path.join(dir, "keys.json");
    now = T;
    leaseSeq = 0;
    tokenProvider.mockReset();
    tokenProvider.mockResolvedValue("token");
    writeJson(accountsFile, { accounts: [{ id: 11, email: "a@x.com", refreshToken: "rt", enabled: true, planType: "pro" }] });
    writeJson(keysFile, { keys: [{
      id: "card-A", key: "secret", status: "active", durationMs: HOUR,
      bindings: { codex: 11 }, weight: 1,
    }] });
    prisma = new PrismaClient({ datasourceUrl: `file:${path.join(dir, "quota.db")}` });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`CREATE TABLE FairShareWindowHead (
      provider TEXT NOT NULL, accountId INTEGER NOT NULL, bucket TEXT NOT NULL, scope TEXT NOT NULL,
      stateJson TEXT NOT NULL, revision INTEGER NOT NULL, algorithm TEXT NOT NULL,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, accountId, bucket, scope))`);
    await prisma.$executeRawUnsafe(`CREATE TABLE FairShareWindow (
      provider TEXT NOT NULL, accountId INTEGER NOT NULL, bucket TEXT NOT NULL, cardId TEXT NOT NULL,
      windowStart INTEGER NOT NULL, weightedUsed REAL NOT NULL DEFAULT 0,
      attributedShare REAL NOT NULL DEFAULT 0, lockedDenominator REAL NOT NULL DEFAULT 0,
      lastFraction REAL NOT NULL DEFAULT 1, isParticipant INTEGER NOT NULL DEFAULT 0,
      share REAL NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      isExclusive INTEGER NOT NULL DEFAULT 0, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, accountId, bucket, cardId))`);
    await prisma.$executeRawUnsafe(`CREATE TABLE QuotaReportReceipt (
      provider TEXT NOT NULL, reportId TEXT NOT NULL, accountId INTEGER NOT NULL, bucket TEXT NOT NULL,
      revision INTEGER NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, reportId))`);
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.onModuleDestroy();
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function service() {
    const value = withSessionResolver(new RemoteCodexService({
      accountsFilePath: accountsFile,
      accessKeysFilePath: keysFile,
      tokenProvider,
      now: () => now,
      randomId: () => `lease-${++leaseSeq}`,
      minClientVersion: "",
      fairShareAlgorithm: "window-cu-v1",
      prisma,
    }));
    services.push(value);
    return value;
  }

  async function lease(value: RemoteCodexService) {
    return value.leaseToken(sessionReqFor("card-A"), { clientId: "client-A", modelKey: "gpt-5.6-luna" });
  }

  const accountQuota = (hourly: number, weekly: number, observedAt: number) => ({
    accountId: 11,
    observedAt,
    codexQuota: {
      hourlyPercent: hourly,
      weeklyPercent: weekly,
      hourlyResetTime: new Date(T + 5 * HOUR).toISOString(),
      weeklyResetTime: new Date(T + WEEK).toISOString(),
    },
  });

  async function quotaOnly(value: RemoteCodexService, leaseId: string, reportId: string, fraction: number, observedAt: number) {
    now = Math.max(now, observedAt);
    return value.reportResult(sessionReqFor("card-A"), {
      leaseId, reportId, status: 0, modelKey: "gpt-5.6-luna",
      accountQuota: accountQuota(fraction * 100, fraction * 100, observedAt),
    });
  }

  async function usage(value: RemoteCodexService, leaseId: string, reportId: string, completedAt: number) {
    return value.reportResult(sessionReqFor("card-A"), {
      leaseId, reportId, traceId: `trace-${reportId}`, status: 200, modelKey: "gpt-5.6-luna",
      inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, totalTokens: 1_000_000,
      requestStartedAt: completedAt - 1_000,
      upstreamCompletedAt: completedAt,
    });
  }

  it("makes an independent snapshot-before-report equal report-before-snapshot", async () => {
    const first = service();
    const firstLease = await lease(first);
    await quotaOnly(first, firstLease.leaseId, "q0", 1, T);
    now = T + 10;
    await usage(first, firstLease.leaseId, "u1", T + 10);
    await quotaOnly(first, firstLease.leaseId, "q1", 0.9, T + 20);
    const expected = first.fairShareTracker!.getWindowStateForTesting(11, BUCKET);

    const second = service();
    const secondLease = await lease(second);
    await quotaOnly(second, secondLease.leaseId, "q0-second", 1, T);
    await quotaOnly(second, secondLease.leaseId, "q1-second", 0.9, T + 20);
    now = T + 30;
    await usage(second, secondLease.leaseId, "u1-second", T + 10);
    const actual = second.fairShareTracker!.getWindowStateForTesting(11, BUCKET);

    expect(actual).toEqual(expected);
    expect(second.fairShareTracker!.getWindowReasons(11, BUCKET)?.primary).toBe("LATE_USAGE_RECONCILED");
    expect(actual!.primary.subjects["card-A"].attributedShare).toBeCloseTo(0.1, 12);
    expect(actual!.primary.unattributedShare).toBe(0);
  });

  it("processes usage before an attached snapshot and deduplicates retries", async () => {
    const value = service();
    const currentLease = await lease(value);
    await quotaOnly(value, currentLease.leaseId, "q0", 1, T);
    now = T + 20;
    const payload = {
      leaseId: currentLease.leaseId,
      reportId: "attached-1",
      traceId: "trace-attached-1",
      status: 200,
      modelKey: "gpt-5.6-luna",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 1_000_000,
      requestStartedAt: T + 5,
      upstreamCompletedAt: T + 10,
      accountQuota: accountQuota(80, 90, T + 20),
    };
    const first = await value.reportResult(sessionReqFor("card-A"), payload);
    const beforeRetry = value.fairShareTracker!.getWindowStateForTesting(11, BUCKET);
    const duplicate = await value.reportResult(sessionReqFor("card-A"), payload);
    const afterRetry = value.fairShareTracker!.getWindowStateForTesting(11, BUCKET);

    expect(first.ok).toBe(true);
    expect(duplicate).toMatchObject({ ok: true, ignored: true, reason: "already_reported" });
    expect(afterRetry).toEqual(beforeRetry);
    expect(afterRetry!.primary.subjects["card-A"].cumulativeCu).toBe(1);
    expect(afterRetry!.primary.subjects["card-A"].attributedShare).toBeCloseTo(0.2, 12);
    expect(afterRetry!.weekly.subjects["card-A"].attributedShare).toBeCloseTo(0.1, 12);
  });

  it("restores the window and ignores an acknowledged report after service restart", async () => {
    const first = service();
    const currentLease = await lease(first);
    await quotaOnly(first, currentLease.leaseId, "restart-q0", 1, T);
    now = T + 20;
    const payload = {
      leaseId: currentLease.leaseId, reportId: "restart-u1", status: 200,
      modelKey: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 0,
      cachedInputTokens: 0, totalTokens: 1_000_000,
      requestStartedAt: T + 5, upstreamCompletedAt: T + 10,
      accountQuota: accountQuota(80, 90, T + 20),
    };
    await first.reportResult(sessionReqFor("card-A"), payload);
    expect(await prisma.quotaReportReceipt.findMany()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportId: "restart-u1" }),
    ]));
    const expected = first.fairShareTracker!.getWindowStateForTesting(11, BUCKET);
    await first.onModuleDestroy();
    services.splice(services.indexOf(first), 1);

    const restarted = service();
    await restarted.fairShareTracker!.load();
    expect(await restarted.fairShareTracker!.hasPersistedReport("restart-u1")).toBe(true);
    const duplicate = await restarted.reportResult(sessionReqFor("card-A"), payload);

    expect(duplicate).toMatchObject({ ok: true, ignored: true, reason: "already_reported" });
    expect(restarted.fairShareTracker!.getWindowStateForTesting(11, BUCKET)).toEqual(expected);
  });

  it("retries a failed SQLite checkpoint without double-applying usage", async () => {
    const value = service();
    const currentLease = await lease(value);
    await quotaOnly(value, currentLease.leaseId, "failure-q0", 1, T);
    now = T + 20;
    const payload = {
      leaseId: currentLease.leaseId, reportId: "failure-u1", status: 200,
      modelKey: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 0,
      cachedInputTokens: 0, totalTokens: 1_000_000,
      requestStartedAt: T + 5, upstreamCompletedAt: T + 10,
    };
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database busy"));
    await expect(value.reportResult(sessionReqFor("card-A"), payload)).rejects.toThrow("database busy");
    expect(value.accessKeyStore.hasUsageReport("card-A", "failure-u1")).toBe(false);

    await expect(value.reportResult(sessionReqFor("card-A"), payload)).resolves.toMatchObject({ ok: true });
    const state = value.fairShareTracker!.getWindowStateForTesting(11, BUCKET);
    expect(state!.primary.subjects["card-A"].cumulativeCu).toBe(1);
    expect(value.accessKeyStore.hasUsageReport("card-A", "failure-u1")).toBe(true);
  });
});
