import type { PrismaClient } from "@prisma/client";
import type { FairShareWindowState, QuotaScope, QuotaWindowsState } from "./fair-share-window";

const WEEKLY_SUFFIX = "::weekly";
const ALGORITHM = "window-cu-v1";

export type LoadWindowResult =
  | { ok: true; windows: QuotaWindowsState }
  | { ok: false; reason: "WINDOW_STATE_MISSING" | "WINDOW_STATE_CORRUPT" };

export interface WindowCheckpoint {
  accountId: number;
  bucket: string;
  windows: QuotaWindowsState;
  reportIds?: string[];
  createdAt?: Date;
}

function storedBucket(bucket: string, scope: QuotaScope): string {
  return scope === "weekly" ? `${bucket}${WEEKLY_SUFFIX}` : bucket;
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
        for (const scope of ["primary", "weekly"] as const) {
          const state = windows[scope];
          const bucketKey = storedBucket(bucket, scope);
          await tx.fairShareWindowHead.upsert({
            where: { provider_accountId_bucket_scope: { provider: this.provider, accountId, bucket, scope } },
            create: {
              provider: this.provider, accountId, bucket, scope,
              stateJson: JSON.stringify(state), revision: BigInt(state.revision), algorithm: ALGORITHM,
            },
            update: {
              stateJson: JSON.stringify(state), revision: BigInt(state.revision),
              algorithm: ALGORITHM, updatedAt: new Date(),
            },
          });
          await tx.fairShareWindow.deleteMany({ where: { provider: this.provider, accountId, bucket: bucketKey } });
          const rows = Object.values(state.subjects).map((subject) => ({
            provider: this.provider, accountId, bucket: bucketKey, cardId: subject.quotaSubjectId,
            windowStart: BigInt(Math.trunc(state.windowStart)), weightedUsed: subject.cumulativeCu,
            attributedShare: subject.attributedShare,
            lockedDenominator: subject.share > 0 ? 1 / subject.share : 0,
            lastFraction: state.fraction, isParticipant: subject.active, share: subject.share,
            isActive: subject.active, isExclusive: subject.exclusive === true,
          }));
          if (rows.length > 0) await tx.fairShareWindow.createMany({ data: rows });
        }
        const revision = BigInt(Math.max(windows.primary.revision, windows.weekly.revision));
        for (const reportId of new Set(checkpoint.reportIds || [])) {
          if (!reportId) continue;
          await tx.quotaReportReceipt.upsert({
            where: { provider_reportId: { provider: this.provider, reportId } },
            create: { provider: this.provider, reportId, accountId, bucket, revision, createdAt: checkpoint.createdAt },
            update: {},
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
        parsed.set(head.scope, state);
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
    const result: Array<{ accountId: number; bucket: string; result: LoadWindowResult }> = [];
    for (const key of keys.values()) {
      result.push({ ...key, result: await this.loadAccount(key.accountId, key.bucket) });
    }
    return result;
  }
}
