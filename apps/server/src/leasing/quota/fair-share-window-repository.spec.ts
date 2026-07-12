import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuotaWindows, reduceQuotaWindows, type SnapshotEvent, type UsageCuEvent } from "./fair-share-window";
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

  it("restores both current windows exactly after restart", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    const expected = populatedWindows();
    await repository.checkpointAccount(7, "codex-gpt", expected);

    const restored = await new FairShareWindowRepository(prisma, "codex").loadAccount(7, "codex-gpt");
    expect(restored).toEqual({ ok: true, windows: expected });
  });

  it("keeps row count fixed while revisions grow", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    let windows = populatedWindows();
    for (let i = 0; i < 10_000; i += 1) {
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
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows });
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
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({ ok: true, windows });
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
    expect(restored.getWindowStateForTesting(7, "codex-gpt")).toEqual(expected);
    restored.destroy();
  });
});
