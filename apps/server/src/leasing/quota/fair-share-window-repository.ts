import type { PrismaClient } from "@prisma/client";
import {
  compactWindowForCheckpoint,
  createCarriedWindowState,
  createWindowState,
  type FairShareWindowState,
  type QuotaScope,
  type QuotaWindowsState,
  type WindowSubjectConfig,
} from "./fair-share-window";

const WEEKLY_SUFFIX = "::weekly";
const ALGORITHM = "window-cu-v1";
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

export type LoadWindowResult =
  | { ok: true; windows: QuotaWindowsState; needsCheckpoint?: true }
  | { ok: false; reason: "WINDOW_STATE_MISSING" | "WINDOW_STATE_CORRUPT" };

export interface WindowCheckpoint {
  accountId: number;
  bucket: string;
  windows: QuotaWindowsState;
  reportIds?: string[];
  accountings?: HourlyUsageAccounting[];
  createdAt?: Date;
}

export interface HourlyUsageAccounting {
  reportId: string;
  at: Date;
  accessKeyId: string;
  accountEmail: string;
  customerId: string;
  modelKey: string;
  bucket: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  rawTotalTokens: number;
  totalTokens: number;
  reverseProxy: boolean;
  serviceTier: string;
}

export class QuotaStaleRevisionError extends Error {
  readonly code = "QUOTA_STALE_REVISION";

  constructor(provider: string, accountId: number, bucket: string) {
    super(`QUOTA_STALE_REVISION ${provider}/${accountId}/${bucket}`);
    this.name = "QuotaStaleRevisionError";
  }
}

function storedBucket(bucket: string, scope: QuotaScope): string {
  return scope === "weekly" ? `${bucket}${WEEKLY_SUFFIX}` : bucket;
}

function baseBucket(bucket: string): string {
  return bucket.endsWith(WEEKLY_SUFFIX) ? bucket.slice(0, -WEEKLY_SUFFIX.length) : bucket;
}

function validState(value: unknown, scope: QuotaScope): value is FairShareWindowState {
  if (!value || typeof value !== "object") return false;
  const state = value as FairShareWindowState;
  return state.scope === scope
    && Number.isFinite(state.revision)
    && Number.isFinite(state.fraction)
    && state.subjects != null
    && typeof state.subjects === "object"
    && Array.isArray(state.reorderTail)
    && state.base != null;
}

function normalizeState(state: FairShareWindowState): FairShareWindowState {
  const normalizeSubjects = (subjects: FairShareWindowState["subjects"]) => {
    for (const subject of Object.values(subjects)) {
      if (!Number.isFinite(subject.carriedAttributedShare)) subject.carriedAttributedShare = 0;
    }
  };
  normalizeSubjects(state.subjects);
  normalizeSubjects(state.base.subjects);
  if (!Number.isFinite(state.reorderTailBytes)) {
    state.reorderTailBytes = Buffer.byteLength(JSON.stringify(state.reorderTail), "utf8");
  }
  return state;
}

type LegacyRow = {
  bucket: string;
  cardId: string;
  windowStart: bigint | number | string;
  attributedShare: number;
  lastFraction: number;
  share: number;
  lockedDenominator: number;
  isActive: boolean | bigint | number;
  isExclusive: boolean | bigint | number;
  updatedAt: Date | string;
};

function legacySubjects(rows: LegacyRow[]): Array<WindowSubjectConfig & {
  active: boolean;
  carriedAttributedShare: number;
}> {
  return rows.map((row) => ({
    quotaSubjectId: row.cardId,
    // Recent segment rows persist share. Older rows did not; membership sync
    // immediately replaces this conservative fallback after load.
    share: Number(row.share) > 0
      ? Number(row.share)
      : Number(row.lockedDenominator) > 0 ? 1 / Number(row.lockedDenominator) : 0,
    exclusive: Number(row.isExclusive) !== 0,
    active: Number(row.isActive) !== 0,
    carriedAttributedShare: Math.max(0, Number(row.attributedShare) || 0),
  }));
}

function legacyWindow(scope: QuotaScope, rows: LegacyRow[], fallbackSubjects: WindowSubjectConfig[]): FairShareWindowState {
  const windowMs = scope === "primary" ? FIVE_HOURS : WEEK;
  if (rows.length === 0) return createWindowState({ scope, windowMs, subjects: fallbackSubjects });
  const first = rows[0];
  const fraction = Number(first.lastFraction);
  const windowStart = Number(first.windowStart);
  const compactedAt = rows.reduce((latest, row) => {
    const value = new Date(row.updatedAt).getTime();
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, windowStart);
  return createCarriedWindowState({
    scope,
    windowMs,
    windowStart,
    fraction: Number.isFinite(fraction) ? fraction : 1,
    lastSnapshotAt: compactedAt,
    subjects: legacySubjects(rows),
  });
}

export class FairShareWindowRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: string,
  ) {}

  async checkpointAccount(accountId: number, bucket: string, windows: QuotaWindowsState): Promise<void> {
    await this.checkpointBatch([{ accountId, bucket, windows }]);
  }

  /** One short SQLite transaction for up to one coordinator micro-batch. */
  async checkpointBatch(checkpoints: WindowCheckpoint[]): Promise<void> {
    const ordered = [...checkpoints].sort((a, b) => {
      const keyA = `${a.accountId}\u0000${a.bucket}`;
      const keyB = `${b.accountId}\u0000${b.bucket}`;
      if (keyA !== keyB) return keyA.localeCompare(keyB);
      return Math.max(a.windows.primary.revision, a.windows.weekly.revision)
        - Math.max(b.windows.primary.revision, b.windows.weekly.revision);
    });
    await this.prisma.$transaction(async (tx) => {
      for (const checkpoint of ordered) {
        const { accountId, bucket, windows } = checkpoint;
        let fullyAccepted = true;
        for (const scope of ["primary", "weekly"] as const) {
          const state = compactWindowForCheckpoint(windows[scope]);
          const bucketKey = storedBucket(bucket, scope);
          // SQLite is the final stale-write guard.  The in-memory coordinator
          // serializes normal writes, but shutdown/retry/older binaries must not
          // be able to roll a durable head (or its card summary) backwards.
          const accepted = await tx.$executeRawUnsafe(
            `INSERT INTO FairShareWindowHead
              (provider, accountId, bucket, scope, stateJson, revision, algorithm, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, accountId, bucket, scope) DO UPDATE SET
               stateJson = excluded.stateJson,
               revision = excluded.revision,
               algorithm = excluded.algorithm,
               updatedAt = excluded.updatedAt
             WHERE excluded.revision >= FairShareWindowHead.revision`,
            this.provider, accountId, bucket, scope, JSON.stringify(state),
            BigInt(state.revision), ALGORITHM, new Date(),
          );
          if (Number(accepted) === 0) {
            fullyAccepted = false;
            continue;
          }
          await tx.fairShareWindow.deleteMany({ where: { provider: this.provider, accountId, bucket: bucketKey } });
          const rows = Object.values(state.subjects).map((subject) => ({
            provider: this.provider, accountId, bucket: bucketKey, cardId: subject.quotaSubjectId,
            windowStart: BigInt(Math.trunc(state.windowStart)), weightedUsed: subject.cumulativeCu,
            // Keep the fixed per-card summary usable as a disaster/cutover
            // fallback even after a Head is lost: it stores total visible T.
            attributedShare: subject.carriedAttributedShare + subject.attributedShare,
            lockedDenominator: subject.share > 0 ? 1 / subject.share : 0,
            lastFraction: state.fraction, isParticipant: subject.active, share: subject.share,
            isActive: subject.active, isExclusive: subject.exclusive === true,
          }));
          if (rows.length > 0) await tx.fairShareWindow.createMany({ data: rows });
        }
        // A stale scope means this process is not authoritative. Throw inside
        // the transaction so an accepted sibling scope also rolls back and the
        // coordinator/caller cannot acknowledge a state SQLite rejected.
        if (!fullyAccepted) throw new QuotaStaleRevisionError(this.provider, accountId, bucket);
        const revision = BigInt(Math.max(windows.primary.revision, windows.weekly.revision));
        const accountings = new Map((checkpoint.accountings || []).map((value) => [value.reportId, value]));
        for (const reportId of new Set(checkpoint.reportIds || [])) {
          if (!reportId) continue;
          const accounting = accountings.get(reportId);
          if (!accounting) {
            await tx.quotaReportReceipt.upsert({
              where: { provider_reportId: { provider: this.provider, reportId } },
              create: { provider: this.provider, reportId, accountId, bucket, revision, createdAt: checkpoint.createdAt },
              update: {},
            });
            continue;
          }
          // The receipt is the idempotency gate for the aggregate. Both writes
          // live in this same SQLite transaction: either quota + billing exist,
          // or neither does. Retrying a committed report increments nothing.
          const inserted = await tx.$executeRawUnsafe(
            `INSERT OR IGNORE INTO QuotaReportReceipt
              (provider, reportId, accountId, bucket, revision, createdAt)
             VALUES (?, ?, ?, ?, ?, ?)`,
            this.provider, reportId, accountId, bucket, revision, checkpoint.createdAt || accounting.at,
          );
          if (Number(inserted) === 0) continue;
          const hourStart = new Date(Math.floor(accounting.at.getTime() / 3_600_000) * 3_600_000);
          const failed = accounting.status >= 200 && accounting.status < 300 ? 0 : 1;
          const reverseProxyHits = accounting.reverseProxy ? 1 : 0;
          const priorityTokens = accounting.serviceTier === "priority" ? accounting.totalTokens : 0;
          const sums = {
            requests: 1, failedRequests: failed,
            inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens,
            cachedInputTokens: accounting.cachedInputTokens, cacheCreationTokens: accounting.cacheCreationTokens,
            rawTotalTokens: accounting.rawTotalTokens, totalTokens: accounting.totalTokens,
            reverseProxyHits, priorityTokens,
          };
          await tx.cardUsageHourly.upsert({
            where: { hourStart_accessKeyId_accountEmail_customerId_modelKey_bucket: {
              hourStart, accessKeyId: accounting.accessKeyId, accountEmail: accounting.accountEmail,
              customerId: accounting.customerId, modelKey: accounting.modelKey, bucket: accounting.bucket,
            } },
            create: {
              hourStart, accessKeyId: accounting.accessKeyId, accountEmail: accounting.accountEmail,
              customerId: accounting.customerId, modelKey: accounting.modelKey, bucket: accounting.bucket, ...sums,
            },
            update: {
              requests: { increment: sums.requests }, failedRequests: { increment: sums.failedRequests },
              inputTokens: { increment: sums.inputTokens }, outputTokens: { increment: sums.outputTokens },
              cachedInputTokens: { increment: sums.cachedInputTokens }, cacheCreationTokens: { increment: sums.cacheCreationTokens },
              rawTotalTokens: { increment: sums.rawTotalTokens }, totalTokens: { increment: sums.totalTokens },
              reverseProxyHits: { increment: sums.reverseProxyHits }, priorityTokens: { increment: sums.priorityTokens },
            },
          });
        }
      }
    });
  }

  async hasReport(reportId: string): Promise<boolean> {
    if (!reportId) return false;
    return (await this.prisma.quotaReportReceipt.findUnique({
      where: { provider_reportId: { provider: this.provider, reportId } },
      select: { reportId: true },
    })) !== null;
  }

  async pruneReceipts(olderThan: Date, batchSize = 500): Promise<number> {
    const limit = Math.max(1, Math.min(5_000, Math.trunc(batchSize)));
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM QuotaReportReceipt WHERE rowid IN (
        SELECT rowid FROM QuotaReportReceipt
        WHERE provider = ? AND createdAt < ? ORDER BY createdAt LIMIT ?
      )`,
      this.provider,
      olderThan,
      limit,
    );
  }

  async loadAccount(accountId: number, bucket: string): Promise<LoadWindowResult> {
    const heads = await this.prisma.fairShareWindowHead.findMany({
      where: { provider: this.provider, accountId, bucket },
    });
    if (heads.length !== 2) return { ok: false, reason: "WINDOW_STATE_MISSING" };
    try {
      const parsed = new Map<QuotaScope, FairShareWindowState>();
      for (const head of heads) {
        if (head.algorithm !== ALGORITHM || (head.scope !== "primary" && head.scope !== "weekly")) {
          return { ok: false, reason: "WINDOW_STATE_CORRUPT" };
        }
        const state = JSON.parse(head.stateJson) as unknown;
        if (!validState(state, head.scope) || BigInt(state.revision) !== head.revision) {
          return { ok: false, reason: "WINDOW_STATE_CORRUPT" };
        }
        parsed.set(head.scope, normalizeState(state));
      }
      const primary = parsed.get("primary");
      const weekly = parsed.get("weekly");
      if (!primary || !weekly) return { ok: false, reason: "WINDOW_STATE_CORRUPT" };
      return { ok: true, windows: { primary, weekly } };
    } catch {
      return { ok: false, reason: "WINDOW_STATE_CORRUPT" };
    }
  }

  async loadProvider(): Promise<Array<{ accountId: number; bucket: string; result: LoadWindowResult }>> {
    const heads = await this.prisma.fairShareWindowHead.findMany({
      where: { provider: this.provider },
      select: { accountId: true, bucket: true },
    });
    const keys = new Map<string, { accountId: number; bucket: string }>();
    for (const head of heads) keys.set(`${head.accountId}\u0000${head.bucket}`, head);
    // Raw SQLite keeps the epoch-ms INTEGER as int64. Some deployed Prisma
    // clients were generated while this column was still Int and cannot decode
    // values above 2^31 through the model API during the one-time cutover.
    const legacyRows = await this.prisma.$queryRawUnsafe<Array<LegacyRow & { accountId: bigint | number }>>(
      `SELECT accountId, bucket, cardId, CAST(windowStart AS TEXT) AS windowStart, attributedShare, lastFraction,
              share, lockedDenominator, isActive, isExclusive, updatedAt
       FROM FairShareWindow WHERE provider = ?`,
      this.provider,
    );
    const legacy = new Map<string, { accountId: number; bucket: string; rows: LegacyRow[] }>();
    for (const row of legacyRows) {
      const accountId = Number(row.accountId);
      const bucket = baseBucket(row.bucket);
      const key = `${accountId}\u0000${bucket}`;
      let group = legacy.get(key);
      if (!group) legacy.set(key, (group = { accountId, bucket, rows: [] }));
      group.rows.push(row);
      if (!keys.has(key)) keys.set(key, { accountId, bucket });
    }
    const result: Array<{ accountId: number; bucket: string; result: LoadWindowResult }> = [];
    for (const key of keys.values()) {
      const loaded = await this.loadAccount(key.accountId, key.bucket);
      if (loaded.ok || loaded.reason !== "WINDOW_STATE_MISSING") {
        result.push({ ...key, result: loaded });
        continue;
      }
      const group = legacy.get(`${key.accountId}\u0000${key.bucket}`);
      if (!group) {
        result.push({ ...key, result: loaded });
        continue;
      }
      const primaryRows = group.rows.filter((row) => !row.bucket.endsWith(WEEKLY_SUFFIX));
      const weeklyRows = group.rows.filter((row) => row.bucket.endsWith(WEEKLY_SUFFIX));
      const fallbackSubjects = legacySubjects(primaryRows.length > 0 ? primaryRows : weeklyRows);
      result.push({
        ...key,
        result: {
          ok: true,
          needsCheckpoint: true,
          windows: {
            primary: legacyWindow("primary", primaryRows, fallbackSubjects),
            weekly: legacyWindow("weekly", weeklyRows, fallbackSubjects),
          },
        },
      });
    }
    return result;
  }
}
