import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuotaWindows, reduceQuotaWindows, type SnapshotEvent, type UsageCuEvent } from "./fair-share-window";
import { FairShareWindowRepository } from "./fair-share-window-repository";

const T = 1_800_000_000_000;
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

  it("rejects a partially corrupt window group instead of stitching state", async () => {
    const repository = new FairShareWindowRepository(prisma, "codex");
    await repository.checkpointAccount(7, "codex-gpt", populatedWindows());
    await prisma.$executeRawUnsafe("UPDATE FairShareWindowHead SET stateJson = '{bad json' WHERE scope = 'weekly'");
    await expect(repository.loadAccount(7, "codex-gpt")).resolves.toEqual({
      ok: false,
      reason: "WINDOW_STATE_CORRUPT",
    });
  });
});
