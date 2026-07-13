import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compactWindowForCheckpoint,
  createQuotaWindows,
  reduceQuotaWindows,
  type QuotaWindowsState,
  type SnapshotEvent,
  type UsageCuEvent,
} from "./fair-share-window";
import { FairShareWindowRepository } from "./fair-share-window-repository";
import { FairShareTracker } from "../token-server/fair-share-tracker";

const T = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

function snapshot(scope: "primary" | "weekly", fraction: number, at: number): SnapshotEvent {
  return {
    kind: "snapshot",
    snapshotId: `${scope}-${at}`,
    fraction,
    observedAt: at,
    arrivedAt: at,
    resetAt: T + (scope === "primary" ? FIVE_HOURS : WEEK),
  };
}

function usage(reportId: string, at: number): UsageCuEvent {
  return { kind: "usage", reportId, quotaSubjectId: "A", cu: 100, upstreamCompletedAt: at, arrivedAt: at };
}

function populatedWindows() {
  let windows = createQuotaWindows({
    subjects: [{ quotaSubjectId: "A", share: 0.5 }, { quotaSubjectId: "B", share: 0.5 }],
    primaryWindowMs: FIVE_HOURS,
    weeklyWindowMs: WEEK,
  });
  windows = reduceQuotaWindows(windows, { scope: "primary", event: snapshot("primary", 1, T) });
  windows = reduceQuotaWindows(windows, { scope: "weekly", event: snapshot("weekly", 1, T) });
  windows = reduceQuotaWindows(windows, { scope: "both", event: usage("r1", T + 10) });
  windows = reduceQuotaWindows(windows, { scope: "primary", event: snapshot("primary", 0.8, T + 20) });
  windows = reduceQuotaWindows(windows, { scope: "weekly", event: snapshot("weekly", 0.9, T + 20) });
  return windows;
}

function checkpointed(windows: QuotaWindowsState): QuotaWindowsState {
  return {
    primary: compactWindowForCheckpoint(windows.primary),
    weekly: compactWindowForCheckpoint(windows.weekly),
  };
}

describe("FairShareWindowRepository with SQLite", () => {
  let dir: string;
  let prisma: PrismaClient;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gfa-quota-window-"));
    prisma = new PrismaClient({ datasourceUrl: `file:${join(dir, "test.db")}` });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      CREATE TABLE FairShareWindowHead (
        provider TEXT NOT NULL,
        accountId INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        scope TEXT NOT NULL,
        stateJson TEXT NOT NULL,
        revision INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, accountId, bucket, scope)
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE FairShareWindow (
        provider TEXT NOT NULL,
        accountId INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        cardId TEXT NOT NULL,
        windowStart INTEGER NOT NULL,
        weightedUsed REAL NOT NULL DEFAULT 0,
        attributedShare REAL NOT NULL DEFAULT 0,
        lockedDenominator REAL NOT NULL DEFAULT 0,
        lastFraction REAL NOT NULL DEFAULT 1,
        isParticipant INTEGER NOT NULL DEFAULT 0,
        share REAL NOT NULL DEFAULT 0,
        isActive INTEGER NOT NULL DEFAULT 1,
        isExclusive INTEGER NOT NULL DEFAULT 0,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, accountId, bucket, cardId)
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE QuotaReportReceipt (
        provider TEXT NOT NULL,
        reportId TEXT NOT NULL,
        accountId INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        revision INTEGER NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, reportId)
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE TABLE CardUsageHourly (
      id TEXT NOT NULL PRIMARY KEY, hourStart DATETIME NOT NULL, accessKeyId TEXT NOT NULL,
      accountEmail TEXT NOT NULL DEFAULT '', customerId TEXT NOT NULL DEFAULT '', modelKey TEXT NOT NULL,
      bucket TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, failedRequests INTEGER NOT NULL DEFAULT 0,
      inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
      cachedInputTokens INTEGER NOT NULL DEFAULT 0, cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
      rawTotalTokens INTEGER NOT NULL DEFAULT 0, totalTokens INTEGER NOT NULL DEFAULT 0,
      reverseProxyHits INTEGER NOT NULL DEFAULT 0, priorityTokens INTEGER NOT NULL DEFAULT 0,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(hourStart, accessKeyId, accountEmail, customerId, modelKey, bucket)
    )`);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("restores materialized accounting but not the in-memory reorder tail", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const expected = populatedWindows();
    expect(expected.primary.reorderTail.length).toBeGreaterThan(0);
    expect(expected.weekly.reorderTail.length).toBeGreaterThan(0);
    await repository.checkpointAccount(7, "codex-gpt", expected);

    const restored = await new FairShareWindowRepository(prisma, "codex").loadAccount(7, "codex-gpt");
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored.windows.primary.reorderTail).toEqual([]);
    expect(restored.windows.weekly.reorderTail).toEqual([]);
    for (const scope of ["primary", "weekly"] as const) {
      expect(restored.windows[scope]).toMatchObject({
        fraction: expected[scope].fraction,
        assignedBurn: expected[scope].assignedBurn,
        unattributedShare: expected[scope].unattributedShare,
        resetAt: expected[scope].resetAt,
        revision: expected[scope].revision,
        subjects: expected[scope].subjects,
      });
      expect(restored.windows[scope].base.subjects).toEqual(expected[scope].subjects);
    }
  });

  it("cuts over fixed legacy rows without changing blood bars and checkpoints a restartable head", async () => {
    const legacyRows = [
      { bucket: "codex-gpt", cardId: "A", windowStart: BigInt(T), attributedShare: 0.3, lastFraction: 0.6 },
      { bucket: "codex-gpt", cardId: "B", windowStart: BigInt(T), attributedShare: 0.1, lastFraction: 0.6 },
      { bucket: "codex-gpt::weekly", cardId: "A", windowStart: BigInt(T), attributedShare: 0.2, lastFraction: 0.7 },
      { bucket: "codex-gpt::weekly", cardId: "B", windowStart: BigInt(T), attributedShare: 0.05, lastFraction: 0.7 },
    ].map((row) => ({
      provider: "codex",
      accountId: 7,
      weightedUsed: 999_999,
      lockedDenominator: 2,
      isParticipant: true,
      share: 0.5,
      isActive: true,
      isExclusive: false,
      ...row,
    }));
    await prisma.fairShareWindow.createMany({ data: legacyRows });

    const repository = new FairShareWindowRepository(prisma, "codex");
    const groups = await repository.loadProvider();
    expect(groups).toHaveLength(1);
    expect(groups[0].result.ok).toBe(true);
    if (!groups[0].result.ok) throw new Error(groups[0].result.reason);
    expect(groups[0].result.needsCheckpoint).toBe(true);
    const migrated = groups[0].result.windows;
    expect(migrated.primary.fraction).toBe(0.6);
    expect(migrated.primary.subjects.A.cumulativeCu).toBe(0);
    expect(migrated.primary.subjects.A.carriedAttributedShare).toBeCloseTo(0.3, 12);
    expect(migrated.primary.subjects.A.attributedShare).toBe(0);
    expect(migrated.primary.unattributedShare).toBe(0);
    expect(migrated.weekly.subjects.A.carriedAttributedShare).toBeCloseTo(0.2, 12);
    expect(migrated.weekly.unattributedShare).toBeCloseTo(0.05, 12);

    await repository.checkpointAccount(7, "codex-gpt", migrated);
    const restarted = await new FairShareWindowRepository(prisma, "codex").loadAccount(7, "codex-gpt");
    expect(restarted).toEqual({ ok: true, windows: migrated });
    const heads = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM FairShareWindowHead");
    const cards = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM FairShareWindow");
    expect(Number(heads[0].count)).toBe(2);
    expect(Number(cards[0].count)).toBe(4);
  });

  it("automatically checkpoints a legacy cutover during tracker flush and restores it unchanged", async () => {
    await prisma.fairShareWindow.createMany({ data: ["codex-gpt", "codex-gpt::weekly"].flatMap((bucket) => [
      {
        provider: "codex", accountId: 7, bucket, cardId: "A", windowStart: BigInt(T),
        weightedUsed: 123, attributedShare: bucket.endsWith("::weekly") ? 0.2 : 0.3,
        lockedDenominator: 2, lastFraction: bucket.endsWith("::weekly") ? 0.7 : 0.6,
        isParticipant: true, share: 0.5, isActive: true, isExclusive: false,
      },
      {
        provider: "codex", accountId: 7, bucket, cardId: "B", windowStart: BigInt(T),
        weightedUsed: 456, attributedShare: bucket.endsWith("::weekly") ? 0.05 : 0.1,
        lockedDenominator: 2, lastFraction: bucket.endsWith("::weekly") ? 0.7 : 0.6,
        isParticipant: true, share: 0.5, isActive: true, isExclusive: false,
      },
    ]) });
    const options = {
      algorithm: "window-cu-v1" as const,
      provider: "codex",
      trackWeekly: true,
      prisma,
      now: () => T + 100,
      getCardWeight: () => 1,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }],
      getSeatCapacity: () => 2,
    };

    const first = new FairShareTracker(options);
    await first.load();
    const beforeRestart = first.getWindowStateForTesting(7, "codex-gpt");
    expect(beforeRestart?.primary.subjects.A.carriedAttributedShare).toBeCloseTo(0.3, 12);
    expect(beforeRestart?.primary.subjects.A.cumulativeCu).toBe(0);
    await first.flush();
    first.destroy();

    const restarted = new FairShareTracker(options);
    await restarted.load();
    expect(restarted.getWindowStateForTesting(7, "codex-gpt")).toEqual(beforeRestart);
    restarted.destroy();
    const heads = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM FairShareWindowHead");
    const cards = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM FairShareWindow");
    expect(Number(heads[0].count)).toBe(2);
    expect(Number(cards[0].count)).toBe(4);
  });

  it("reconciles a member added during downtime and persists it before serving", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    let oldWindows = createQuotaWindows({
      subjects: [{ quotaSubjectId: "A", share: 1 }], primaryWindowMs: FIVE_HOURS, weeklyWindowMs: WEEK,
    });
    oldWindows = reduceQuotaWindows(oldWindows, { scope: "primary", event: snapshot("primary", 0.8, T) });
    oldWindows = reduceQuotaWindows(oldWindows, { scope: "weekly", event: snapshot("weekly", 0.9, T) });
    await repository.checkpointAccount(7, "codex-gpt", oldWindows);

    const options = {
      algorithm: "window-cu-v1" as const,
      provider: "codex",
      trackWeekly: true,
      prisma,
      now: () => T + 100,
      getCardWeight: () => 1,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }],
      getSeatCapacity: () => 2,
    };
    const restored = new FairShareTracker(options);
    await restored.load();
    restored.refreshAllParticipants();
    await restored.flush();
    expect(restored.getWindowStateForTesting(7, "codex-gpt")?.primary.subjects.B).toMatchObject({
      active: true, share: 0.5, cumulativeCu: 0, carriedAttributedShare: 0, attributedShare: 0,
    });
    restored.destroy();

    const restarted = new FairShareTracker(options);
    await restarted.load();
    expect(restarted.getWindowStateForTesting(7, "codex-gpt")?.primary.subjects.B).toMatchObject({
      active: true, share: 0.5,
    });
    restarted.destroy();
  });

  it("rejects an older checkpoint without rolling back heads or per-card summaries", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const older = populatedWindows();
    const newer = reduceQuotaWindows(older, { scope: "both", event: usage("newer", T + 30) });
    await repository.checkpointAccount(7, "codex-gpt", newer);
    const summariesBefore = await prisma.$queryRawUnsafe(
      `SELECT bucket, cardId, weightedUsed, attributedShare, lastFraction, isActive
       FROM FairShareWindow WHERE provider = ? AND accountId = ? ORDER BY bucket, cardId`,
      "codex", 7,
    );

    await expect(repository.checkpointAccount(7, "codex-gpt", older))
      .rejects.toThrow("QUOTA_STALE_REVISION");

    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(newer) });
    await expect(prisma.$queryRawUnsafe(
      `SELECT bucket, cardId, weightedUsed, attributedShare, lastFraction, isActive
       FROM FairShareWindow WHERE provider = ? AND accountId = ? ORDER BY bucket, cardId`,
      "codex", 7,
    )).resolves.toEqual(summariesBefore);
  });

  it("does not acknowledge a report when either scope loses a stale revision race", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const older = populatedWindows();
    const newer = reduceQuotaWindows(older, { scope: "both", event: usage("newer-state", T + 30) });
    await repository.checkpointAccount(7, "codex-gpt", newer);

    await expect(repository.checkpointBatch([{
      accountId: 7, bucket: "codex-gpt", windows: older, reportIds: ["stale-report"],
    }])).rejects.toThrow("QUOTA_STALE_REVISION");

    await expect(repository.hasReport("stale-report")).resolves.toBe(false);
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(newer) });
  });

  // 一个账号 revision 过期不能连坐回滚同批次其它健康账号的 head/回执/计费。
  // 否则灰度期间一行陈旧数据能把整批 checkpoint 拖垮,并每 30s 重试永远失败。
  it("isolates a stale checkpoint so healthy siblings in the same batch still persist", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    // 账号 7 的持久 head 已经领先(模拟旧进程/僵尸写入)。
    const older = populatedWindows();
    const newer = reduceQuotaWindows(older, { scope: "both", event: usage("newer-state", T + 30) });
    await repository.checkpointAccount(7, "codex-gpt", newer);
    // 账号 8 是全新健康的 checkpoint,带自己的回执。
    const healthy = populatedWindows();

    await expect(repository.checkpointBatch([
      { accountId: 7, bucket: "codex-gpt", windows: older, reportIds: ["stale-report"] },
      {
        accountId: 8, bucket: "codex-gpt", windows: healthy, reportIds: ["healthy-report"],
        accountings: [{
          reportId: "healthy-report", at: new Date(T + 1234), accessKeyId: "healthy-card",
          accountEmail: "healthy@x.test", customerId: "healthy-customer", modelKey: "gpt-5.6-luna",
          bucket: "codex-gpt", status: 200, inputTokens: 10, outputTokens: 2,
          cachedInputTokens: 3, cacheCreationTokens: 0, rawTotalTokens: 15, totalTokens: 12,
          reverseProxy: false, serviceTier: "standard",
        }],
      },
    ])).rejects.toMatchObject({ code: "QUOTA_STALE_REVISION", staleKeys: [`7\u0000codex-gpt`] });

    // 陈旧账号 7:head 未被回滚(仍是 newer),回执未确认。
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(newer) });
    await expect(repository.hasReport("stale-report")).resolves.toBe(false);
    // 健康账号 8:head 与回执必须已落库,不被连坐回滚。
    await expect(repository.loadAccount(8, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(healthy) });
    await expect(repository.hasReport("healthy-report")).resolves.toBe(true);
    await expect(prisma.cardUsageHourly.findFirst({ where: { accessKeyId: "healthy-card" } }))
      .resolves.toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  });

  it("keeps row count fixed while revisions grow", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    let windows = populatedWindows();
    for (let i = 0; i < 1_000; i += 1) {
      windows = reduceQuotaWindows(windows, { scope: "both", event: usage(`r-${i}`, T + 100 + i) });
      await repository.checkpointAccount(7, "codex-gpt", windows);
    }

    const heads = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM FairShareWindowHead");
    const cards = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM FairShareWindow");
    expect(Number(heads[0].count)).toBe(2);
    expect(Number(cards[0].count)).toBe(4);
  });

  it("does not change SQLite journal mode", async () => {
    const before = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
    await new FairShareWindowRepository(prisma, "codex").checkpointAccount(7, "codex-gpt", populatedWindows());
    const after = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
    expect(after).toEqual(before);
    expect(after[0].journal_mode.toLowerCase()).not.toBe("wal");
  });

  it("atomically stores a report receipt with the window checkpoint", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const windows = populatedWindows();
    await repository.checkpointBatch([{
      accountId: 7,
      bucket: "codex-gpt",
      windows,
      reportIds: ["report-1"],
    }]);

    await expect(repository.hasReport("report-1")).resolves.toBe(true);
    await expect(repository.hasReport("missing")).resolves.toBe(false);
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(windows) });
  });

  it("atomically aggregates authoritative usage exactly once with its receipt", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const checkpoint = {
      accountId: 7, bucket: "codex-gpt", windows: populatedWindows(), reportIds: ["report-accounting"],
      accountings: [{
        reportId: "report-accounting", at: new Date(T + 1234), accessKeyId: "A", accountEmail: "a@x.com",
        customerId: "c1", modelKey: "gpt-5.6-luna", bucket: "codex-gpt", status: 200,
        inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, cacheCreationTokens: 0,
        rawTotalTokens: 15, totalTokens: 12, reverseProxy: false, serviceTier: "standard",
      }],
    };
    await repository.checkpointBatch([checkpoint]);
    await repository.checkpointBatch([checkpoint]);
    const rows = await prisma.cardUsageHourly.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  });

  it("atomically commits receipt + hourly with compact heads but leaves detail rows to the background flush", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const windows = populatedWindows();
    await repository.checkpointReportAccounting([{
      accountId: 7, bucket: "codex-gpt", windows, reportIds: ["report-min"], createdAt: new Date(T),
      accountings: [{
        reportId: "report-min", at: new Date(T + 1234), accessKeyId: "A", accountEmail: "a@x.com",
        customerId: "c1", modelKey: "gpt-5.6-luna", bucket: "codex-gpt", status: 200,
        inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, cacheCreationTokens: 0,
        rawTotalTokens: 15, totalTokens: 12, reverseProxy: false, serviceTier: "standard",
      }],
    }]);

    await expect(repository.hasReport("report-min")).resolves.toBe(true);
    expect(await prisma.cardUsageHourly.count()).toBe(1);
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(windows) });
    // The hot path writes only the two compact heads. Per-card delete/recreate
    // remains on the coalesced background flush.
    expect(await prisma.fairShareWindow.count()).toBe(0);
  });

  // 热路径同批里一个陈旧 revision 不能连坐回滚兄弟 key 的 head/回执/计费。
  // 否则协调器会把被回滚的兄弟当已提交 resolve → 回执丢失 → 重放重复计费。
  it("isolates a stale report-accounting entry so healthy siblings still persist", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    // 账号 7 的持久 head 已经领先(模拟后台 window flush 抢先推进)。
    const older = populatedWindows();
    const newer = reduceQuotaWindows(older, { scope: "both", event: usage("newer-state", T + 30) });
    await repository.checkpointAccount(7, "codex-gpt", newer);
    // 账号 8 是全新健康的记账条目,带自己的回执。
    const healthy = populatedWindows();

    await expect(repository.checkpointReportAccounting([
      { accountId: 7, bucket: "codex-gpt", windows: older, reportIds: ["stale-report"], createdAt: new Date(T) },
      {
        accountId: 8, bucket: "codex-gpt", windows: healthy, reportIds: ["healthy-report"], createdAt: new Date(T),
        accountings: [{
          reportId: "healthy-report", at: new Date(T + 1234), accessKeyId: "healthy-card",
          accountEmail: "healthy@x.test", customerId: "healthy-customer", modelKey: "gpt-5.6-luna",
          bucket: "codex-gpt", status: 200, inputTokens: 10, outputTokens: 2,
          cachedInputTokens: 3, cacheCreationTokens: 0, rawTotalTokens: 15, totalTokens: 12,
          reverseProxy: false, serviceTier: "standard",
        }],
      },
    ])).rejects.toMatchObject({ code: "QUOTA_STALE_REVISION", staleKeys: [`7\u0000codex-gpt`] });

    // 陈旧账号 7:head 未被回滚(仍是 newer),回执未确认。
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(newer) });
    await expect(repository.hasReport("stale-report")).resolves.toBe(false);
    // 健康账号 8:head + 回执 + 计费必须已落库,不被连坐回滚。
    await expect(repository.loadAccount(8, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(healthy) });
    await expect(repository.hasReport("healthy-report")).resolves.toBe(true);
    await expect(prisma.cardUsageHourly.findFirst({ where: { accessKeyId: "healthy-card" } }))
      .resolves.toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  });

  it("does not re-increment hourly usage when the same receipt is replayed", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const entry = {
      accountId: 7, bucket: "codex-gpt", windows: populatedWindows(), reportIds: ["dup"], createdAt: new Date(T),
      accountings: [{
        reportId: "dup", at: new Date(T + 1234), accessKeyId: "A", accountEmail: "a@x.com",
        customerId: "c1", modelKey: "gpt-5.6-luna", bucket: "codex-gpt", status: 200,
        inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, cacheCreationTokens: 0,
        rawTotalTokens: 15, totalTokens: 12, reverseProxy: false, serviceTier: "standard",
      }],
    };
    await repository.checkpointReportAccounting([entry]);
    await repository.checkpointReportAccounting([entry]);
    const rows = await prisma.cardUsageHourly.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 1, inputTokens: 10, totalTokens: 12 });
  });

  it("prunes only receipts older than three days without touching window state", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const windows = populatedWindows();
    await repository.checkpointBatch([{
      accountId: 7, bucket: "codex-gpt", windows, reportIds: ["old", "fresh"],
    }]);
    await prisma.$executeRawUnsafe(
      "UPDATE QuotaReportReceipt SET createdAt = ? WHERE reportId = 'old'",
      new Date(T - 4 * 24 * HOUR),
    );
    await prisma.$executeRawUnsafe(
      "UPDATE QuotaReportReceipt SET createdAt = ? WHERE reportId = 'fresh'",
      new Date(T - 2 * 24 * HOUR),
    );

    await repository.pruneReceipts(new Date(T - 3 * 24 * HOUR), 100);
    await expect(repository.hasReport("old")).resolves.toBe(false);
    await expect(repository.hasReport("fresh")).resolves.toBe(true);
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows: checkpointed(windows) });
  });

  it("rejects a partially corrupt window group instead of stitching state", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    await repository.checkpointAccount(7, "codex-gpt", populatedWindows());
    await prisma.$executeRawUnsafe("UPDATE FairShareWindowHead SET stateJson = '{bad json' WHERE scope = 'weekly'");
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({
      ok: false,
      reason: "WINDOW_STATE_CORRUPT",
    });
  });

  it("restores window-cu-v1 through the production tracker facade", async () => {
    const now = { value: T };
    const options = {
      algorithm: "window-cu-v1" as const,
      provider: "codex",
      trackWeekly: true,
      prisma,
      now: () => now.value,
      getCardWeight: () => 1,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }],
      getSeatCapacity: () => 2,
    };
    const first = new FairShareTracker(options);
    first.applyAccountQuotaSnapshotAt(7, "codex-gpt", { fraction: 1, resetAt: T + FIVE_HOURS, observedAt: T, snapshotId: "p0" });
    first.applyWeeklyAccountQuotaSnapshotAt(7, "codex-gpt", { fraction: 1, resetAt: T + WEEK, observedAt: T, snapshotId: "w0" });
    now.value = T + 10;
    first.recordUsage(7, "A", "codex-gpt", 1_000_000, 0, 0, "gpt-5.6-luna");
    first.applyAccountQuotaSnapshotAt(7, "codex-gpt", { fraction: 0.8, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });
    const expected = first.getWindowStateForTesting(7, "codex-gpt");
    await first.flush();
    first.destroy();

    const restored = new FairShareTracker(options);
    await restored.load();
    const withoutProcessLocalTail = (state: typeof expected) => state && Object.fromEntries(
      Object.entries(state).map(([scope, window]) => {
        const { retainedEvents: _events, reorderTailBytes: _bytes, ...materialized } = window;
        return [scope, materialized];
      }),
    );
    expect(withoutProcessLocalTail(restored.getWindowStateForTesting(7, "codex-gpt")))
      .toEqual(withoutProcessLocalTail(expected));
    restored.destroy();
  });
});
