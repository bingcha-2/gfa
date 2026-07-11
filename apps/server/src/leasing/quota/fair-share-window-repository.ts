import type { PrismaClient } from "@prisma/client";
import type { FairShareWindowState, QuotaScope, QuotaWindowsState } from "./fair-share-window";

const WEEKLY_SUFFIX = "::weekly";
const ALGORITHM = "window-cu-v1";

export type LoadWindowResult =
  | { ok: true; windows: QuotaWindowsState }
  | { ok: false; reason: "WINDOW_STATE_MISSING" | "WINDOW_STATE_CORRUPT" };

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
    await this.prisma.$transaction(async (tx) => {
      for (const scope of ["primary", "weekly"] as const) {
        const state = windows[scope];
        const bucketKey = storedBucket(bucket, scope);
        await tx.fairShareWindowHead.upsert({
          where: { provider_accountId_bucket_scope: { provider: this.provider, accountId, bucket, scope } },
          create: {
            provider: this.provider,
            accountId,
            bucket,
            scope,
            stateJson: JSON.stringify(state),
            revision: BigInt(state.revision),
            algorithm: ALGORITHM,
          },
          update: {
            stateJson: JSON.stringify(state),
            revision: BigInt(state.revision),
            algorithm: ALGORITHM,
            updatedAt: new Date(),
          },
        });
        await tx.fairShareWindow.deleteMany({
          where: { provider: this.provider, accountId, bucket: bucketKey },
        });
        const rows = Object.values(state.subjects).map((subject) => ({
          provider: this.provider,
          accountId,
          bucket: bucketKey,
          cardId: subject.quotaSubjectId,
          windowStart: BigInt(Math.trunc(state.windowStart)),
          weightedUsed: subject.cumulativeCu,
          attributedShare: subject.attributedShare,
          lockedDenominator: subject.share > 0 ? 1 / subject.share : 0,
          lastFraction: state.fraction,
          isParticipant: subject.active,
          share: subject.share,
          isActive: subject.active,
          isExclusive: subject.exclusive === true,
        }));
        if (rows.length > 0) await tx.fairShareWindow.createMany({ data: rows });
      }
    });
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
}
