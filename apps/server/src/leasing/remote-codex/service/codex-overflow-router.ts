import { Logger } from "@nestjs/common";

import { oversellCeiling } from "../../plan-catalog/unified-entitlement";
import type { CatalogConfig } from "../../plan-catalog/pricing";
import type {
  BoundAccountOverflowContext,
  BoundAccountOverflowDecision,
  BoundAccountOverflowRouter,
} from "../../lease-core/lease-service";
import type { CodexAccount } from "../auth/codex-token-provider";

const ACTIVE = "ACTIVE";
const MIN_WEEKLY_PERCENT = 0.5;
const HOME_RECOVERY_PERCENT = 5;
const DEFAULT_ROUTE_TTL_MS = 30 * 60_000;
const DEFAULT_SNAPSHOT_FRESH_MS = 30 * 60_000;
const DEFAULT_MAX_COVERAGE = 1;
const RETRYABLE_TRANSACTION_ATTEMPTS = 3;

type RouteRow = {
  subscriptionId: string;
  homeAccountId: number;
  servingAccountId: number;
  reason: string;
  reservedUsd: number;
  sourceResetAt: Date | null;
  servingResetAt: Date | null;
  status: string;
  expiresAt: Date;
};

type SubscriptionDemand = {
  id: string;
  accountId: number;
  planType: string;
  remainingWeeklyUsd: number;
};

type AccountCandidate = {
  account: CodexAccount;
  weeklyRatio: number;
  resetAt: number;
  projectedCoverage: number;
  temporaryBorrowers: number;
  activeLeases: number;
};

export type CodexOverflowRouterOptions = {
  prisma: any;
  getPublishedCatalog: () => Promise<{ config?: Partial<CatalogConfig> } | null>;
  now?: () => number;
};

/**
 * Selects a temporary serving account for a permanently-bound Codex USD
 * subscription. It only persists routing metadata; Subscription is read-only.
 */
export class CodexOverflowRouter implements BoundAccountOverflowRouter<CodexAccount> {
  private readonly logger = new Logger(CodexOverflowRouter.name);
  private readonly now: () => number;

  constructor(private readonly options: CodexOverflowRouterOptions) {
    this.now = options.now || Date.now;
  }

  async resolve(
    context: BoundAccountOverflowContext<CodexAccount>,
  ): Promise<BoundAccountOverflowDecision> {
    const now = this.now();
    const catalog = (await this.options.getPublishedCatalog())?.config || {};
    const accountById = new Map(context.accounts.map((account) => [account.id, account]));
    const home = accountById.get(context.homeAccountId);
    if (!home) return { servingAccountId: context.homeAccountId, overflow: false };

    const sourceSignal = context.overflowSignal;
    const homeWindow = this.weeklyWindow(home, now);
    const homeRecovered = homeWindow.resetElapsed
      || (homeWindow.fresh && homeWindow.percent > HOME_RECOVERY_PERCENT);
    const homeSnapshotExhausted = homeWindow.fresh && homeWindow.percent <= MIN_WEEKLY_PERCENT;

    if (homeRecovered) {
      await this.retireRoute(context.subscriptionId, "HOME_RECOVERED");
      return { servingAccountId: context.homeAccountId, overflow: false };
    }

    const existing = await this.activeRoute(context.subscriptionId, now);
    const hasTrustedTrigger = homeSnapshotExhausted || Boolean(sourceSignal);
    if (!hasTrustedTrigger && !existing) {
      return { servingAccountId: context.homeAccountId, overflow: false };
    }

    const failedAccountId = sourceSignal?.accountId || 0;
    if (existing
      && existing.homeAccountId === context.homeAccountId
      && existing.servingAccountId !== failedAccountId) {
      const current = accountById.get(existing.servingAccountId);
      const currentWindow = current ? this.weeklyWindow(current, now) : null;
      if (current
        && context.eligibleAccountIds.has(current.id)
        && currentWindow?.fresh
        && currentWindow.percent > MIN_WEEKLY_PERCENT
        && !currentWindow.resetElapsed) {
        return {
          servingAccountId: current.id,
          overflow: true,
          reason: existing.reason,
        };
      }
    }

    const decision = await this.withTransactionRetry(async (tx) => {
      const subscriptions = await tx.subscription.findMany({
        where: {
          status: "ACTIVE",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
        },
        select: {
          id: true,
          config: true,
          bindings: true,
          levels: true,
          windowState: true,
        },
      });
      const routes: RouteRow[] = await tx.codexOverflowRoute.findMany({
        where: { status: ACTIVE, expiresAt: { gt: new Date(now) } },
      });
      const demands: SubscriptionDemand[] = subscriptions
        .map((row: any) => this.subscriptionDemand(row))
        .filter((row: SubscriptionDemand | null): row is SubscriptionDemand => row !== null);
      const requested = demands.find((row) => row.id === context.subscriptionId);
      if (!requested || requested.accountId !== context.homeAccountId) {
        await this.markRoute(tx, context.subscriptionId, "BINDING_CHANGED");
        return null;
      }

      const samePlanAccounts = context.accounts.filter((account) =>
        account.id !== context.homeAccountId
        && account.id !== failedAccountId
        && context.eligibleAccountIds.has(account.id)
        && normalizePlan(account.planType) === requested.planType,
      );
      const candidates = this.rankCandidates({
        accounts: samePlanAccounts,
        catalog,
        demands,
        routes: routes.filter((route) => route.subscriptionId !== context.subscriptionId),
        requestedUsd: requested.remainingWeeklyUsd,
        activeLeaseCount: context.activeLeaseCount,
        now,
      });
      const selected = candidates[0];
      if (!selected) {
        await this.markRoute(tx, context.subscriptionId, "NO_CAPACITY");
        return null;
      }

      const expiresAt = this.routeExpiresAt(
        now,
        homeWindow.resetAt,
        selected.resetAt,
      );
      const data = {
        homeAccountId: context.homeAccountId,
        servingAccountId: selected.account.id,
        reason: sourceSignal ? "quota_exhausted" : "weekly_snapshot_exhausted",
        reservedUsd: requested.remainingWeeklyUsd,
        sourceResetAt: dateOrNull(homeWindow.resetAt),
        servingResetAt: dateOrNull(selected.resetAt),
        status: ACTIVE,
        expiresAt: new Date(expiresAt),
      };
      await tx.codexOverflowRoute.upsert({
        where: { subscriptionId: context.subscriptionId },
        create: { subscriptionId: context.subscriptionId, ...data },
        update: data,
      });
      return {
        servingAccountId: selected.account.id,
        overflow: true,
        reason: data.reason,
      } satisfies BoundAccountOverflowDecision;
    });

    if (!decision) {
      return { servingAccountId: context.homeAccountId, overflow: false };
    }
    return decision;
  }

  async cleanup(): Promise<void> {
    const now = new Date(this.now());
    await this.options.prisma.codexOverflowRoute.updateMany({
      where: { status: ACTIVE, expiresAt: { lte: now } },
      data: { status: "EXPIRED" },
    });
  }

  private rankCandidates(input: {
    accounts: CodexAccount[];
    catalog: Partial<CatalogConfig>;
    demands: SubscriptionDemand[];
    routes: RouteRow[];
    requestedUsd: number;
    activeLeaseCount: (accountId: number) => number;
    now: number;
  }): AccountCandidate[] {
    const maxCoverage = positiveNumber(process.env.CODEX_OVERFLOW_MAX_COVERAGE)
      || DEFAULT_MAX_COVERAGE;
    const protectedDemand = new Map<number, number>();
    for (const demand of input.demands) {
      protectedDemand.set(
        demand.accountId,
        (protectedDemand.get(demand.accountId) || 0) + demand.remainingWeeklyUsd,
      );
    }
    const overflowReserved = new Map<number, number>();
    const borrowers = new Map<number, number>();
    for (const route of input.routes) {
      overflowReserved.set(
        route.servingAccountId,
        (overflowReserved.get(route.servingAccountId) || 0) + Math.max(0, route.reservedUsd),
      );
      borrowers.set(route.servingAccountId, (borrowers.get(route.servingAccountId) || 0) + 1);
    }

    return input.accounts
      .map((account): AccountCandidate | null => {
        const window = this.weeklyWindow(account, input.now);
        if (!window.fresh || window.resetElapsed || window.percent <= MIN_WEEKLY_PERCENT) return null;
        const capacityUsd = this.accountWeeklyCapacityUsd(input.catalog, normalizePlan(account.planType));
        if (!(capacityUsd > 0)) return null;
        const upstreamRemainingUsd = capacityUsd * window.percent / 100;
        if (!(upstreamRemainingUsd > 0)) return null;
        const committed = (protectedDemand.get(account.id) || 0)
          + (overflowReserved.get(account.id) || 0)
          + input.requestedUsd;
        const projectedCoverage = committed / upstreamRemainingUsd;
        if (projectedCoverage > maxCoverage) return null;
        return {
          account,
          weeklyRatio: window.percent / 100,
          resetAt: window.resetAt,
          projectedCoverage,
          temporaryBorrowers: borrowers.get(account.id) || 0,
          activeLeases: input.activeLeaseCount(account.id),
        };
      })
      .filter((candidate): candidate is AccountCandidate => candidate !== null)
      .sort((a, b) =>
        a.projectedCoverage - b.projectedCoverage
        || b.weeklyRatio - a.weeklyRatio
        || a.temporaryBorrowers - b.temporaryBorrowers
        || a.activeLeases - b.activeLeases
        || b.resetAt - a.resetAt
        || a.account.id - b.account.id,
      );
  }

  private accountWeeklyCapacityUsd(
    catalog: Partial<CatalogConfig>,
    planType: string,
  ): number {
    const perSeat = positiveNumber(
      catalog.pricing?.bind?.usdQuotaPerSeat?.codex?.[planType]?.weekly,
    );
    if (!(perSeat > 0)) return 0;
    const fallback = positiveNumber(catalog.shareCapacity) || 8;
    return perSeat * oversellCeiling(catalog, fallback);
  }

  private subscriptionDemand(row: any): SubscriptionDemand | null {
    const config = parseObject(row.config);
    const bindings = {
      ...parseObject(config.bindings),
      ...parseObject(row.bindings),
    };
    const levels = {
      ...parseObject(config.levels),
      ...parseObject(row.levels),
    };
    const accountId = Math.floor(Number(bindings.codex || 0));
    const planType = normalizePlan(levels.codex);
    const quota = parseObject(config.usdQuotaByProduct);
    const weeklyLimit = positiveNumber(parseObject(quota.codex).weekly);
    if (!(accountId > 0) || !planType || !(weeklyLimit > 0)) return null;
    const usage = parseObject(parseObject(parseObject(row.windowState).usdUsageByProduct).codex);
    const usedWeekly = Math.max(0, Number(usage.usedWeekly) || 0);
    return {
      id: String(row.id),
      accountId,
      planType,
      remainingWeeklyUsd: Math.max(0, weeklyLimit - usedWeekly),
    };
  }

  private weeklyWindow(account: CodexAccount, now: number) {
    const percent = Number((account as any).codexWeeklyPercent);
    const observedAt = Number((account as any).codexQuotaObservedAt || 0);
    const resetAt = Date.parse(String((account as any).codexWeeklyResetTime || "")) || 0;
    const freshnessMs = positiveNumber(process.env.CODEX_OVERFLOW_SNAPSHOT_FRESH_MS)
      || DEFAULT_SNAPSHOT_FRESH_MS;
    return {
      percent: Number.isFinite(percent) && percent >= 0 ? Math.min(100, percent) : -1,
      resetAt,
      resetElapsed: resetAt > 0 && resetAt <= now,
      fresh: Number.isFinite(percent)
        && percent >= 0
        && observedAt > 0
        && now - observedAt <= freshnessMs,
    };
  }

  private routeExpiresAt(now: number, sourceResetAt: number, servingResetAt: number): number {
    const future = [now + DEFAULT_ROUTE_TTL_MS, sourceResetAt, servingResetAt]
      .filter((value) => value > now);
    return Math.min(...future);
  }

  private async activeRoute(subscriptionId: string, now: number): Promise<RouteRow | null> {
    return this.options.prisma.codexOverflowRoute.findFirst({
      where: { subscriptionId, status: ACTIVE, expiresAt: { gt: new Date(now) } },
    });
  }

  private async retireRoute(subscriptionId: string, status: string): Promise<void> {
    await this.options.prisma.codexOverflowRoute.updateMany({
      where: { subscriptionId, status: ACTIVE },
      data: { status },
    });
  }

  private async markRoute(tx: any, subscriptionId: string, status: string): Promise<void> {
    await tx.codexOverflowRoute.updateMany({
      where: { subscriptionId, status: ACTIVE },
      data: { status },
    });
  }

  private async withTransactionRetry<T>(work: (tx: any) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRYABLE_TRANSACTION_ATTEMPTS; attempt++) {
      try {
        return await this.options.prisma.$transaction(
          (tx: any) => work(tx),
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        lastError = error;
        const code = String((error as any)?.code || "");
        if (code !== "P2034" || attempt === RETRYABLE_TRANSACTION_ATTEMPTS) throw error;
      }
    }
    this.logger.error(`Codex overflow transaction failed: ${String(lastError)}`);
    throw lastError;
  }
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePlan(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function dateOrNull(timestamp: number): Date | null {
  return timestamp > 0 ? new Date(timestamp) : null;
}
