import { Injectable, Optional, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { LeaseService, LeaseServiceHttpError, type TokenUsageTracker, type AccountQuotaSnapshotRecorder } from "../lease-core/lease-service";
import { QuotaProfileTracker } from "../lease-core/quota-profile-tracker";
import { bucketFamily } from "../lease-core/product-bucket";
import { FairShareTracker } from "./fair-share-tracker";
import { AntigravityProvider } from "./antigravity.provider";
import { TokenAccount } from "./account-token-provider";
import { ACCOUNT_SHARE_CAPACITY } from "./token-billing";
import type { AccessKeyStore } from "./access-key-store";
import { legacyColumnsToConfig, subscriptionToLimitRecord } from "../subscription/subscription-config";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: TokenAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
  accountQuotaSnapshotTracker?: AccountQuotaSnapshotRecorder;
  /** Shared AccessKeyStore so all product pools share one usage cache. */
  accessKeyStore?: AccessKeyStore;
  /** PrismaService — persists QuotaProfile/FairShareWindow (omit in unit tests). */
  prisma?: any;
};

/** HTTP error thrown by the antigravity token server. Subclass of the generic
 * lease error so TokenServerController can route on `instanceof`. */
export class TokenServerHttpError extends LeaseServiceHttpError {}

/**
 * Antigravity (Gemini + Claude/Opus) token server. A thin wrapper over the
 * generic LeaseService wired with the AntigravityProvider — all behavior lives
 * in LeaseService and is shared with the codex provider.
 */
@Injectable()
export class TokenServerService extends LeaseService<TokenAccount> implements OnModuleDestroy, OnModuleInit {
  /** Prisma handle kept for the boot-time window replay (see onModuleInit). */
  private readonly bootPrisma: any;

  constructor(@Optional() options: ServiceOptions = {}) {
    const provider = new AntigravityProvider({
      accountsFilePath: options.accountsFilePath,
      tokenProvider: options.tokenProvider,
    });
    // Quota profile tracker: learns real upstream budgets from 429 events.
    const quotaProfileTracker = new QuotaProfileTracker(options.prisma, { now: options.now });
    // Auto-create fair-share tracker wired to this service's own accessKeyStore.
    // Uses a deferred pattern: the tracker's callbacks reference `service` which
    // is assigned after super() returns.
    let service: TokenServerService;
    const fairShareTracker = new FairShareTracker({
      getAccountPlanType: (accountId: number) => {
        try {
          const status = service.getStatus();
          const acct = status.quota?.accounts?.find((a: any) => a.id === accountId);
          return acct?.planType || 'free';
        } catch { return 'free'; }
      },
      getBoundCardIds: (accountId: number) => {
        try {
          return service.accessKeyStore.cardsBoundToAccount(accountId, provider.id);
        } catch { return []; }
      },
      getCardWeight: (cardId: string) => {
        try {
          const record = service.accessKeyStore.findById(cardId);
          const w = Math.floor(Number((record as any)?.weight ?? 1));
          return (Number.isFinite(w) && w >= 1) ? Math.min(w, ACCOUNT_SHARE_CAPACITY) : 1;
        } catch { return 1; }
      },
      accountShareCapacity: ACCOUNT_SHARE_CAPACITY,
      getLearnedBudget: (planType: string, bucket: string) => {
        return quotaProfileTracker.getLearnedBudget5h(
          provider.id, planType, bucketFamily(bucket),
        );
      },
      prisma: options.prisma,
      provider: provider.id,
      now: options.now,
    });
    super(
      provider,
      {
        accessKeysFilePath: options.accessKeysFilePath,
        accessKeyStore: options.accessKeyStore,
        now: options.now,
        randomId: options.randomId,
        minClientVersion: options.minClientVersion,
        leaseTtlMs: options.leaseTtlMs,
        affinityTtlMs: options.affinityTtlMs,
        tokenUsageTracker: options.tokenUsageTracker,
        accountQuotaSnapshotTracker: options.accountQuotaSnapshotTracker,
        fairShareTracker,
        quotaProfileTracker,
        errorClass: TokenServerHttpError,
      },
    );
    service = this;
    this.bootPrisma = options.prisma;
  }

  /**
   * On boot, rebuild each card's in-memory rate-limit window from the durable
   * CardTokenUsage log. Window events are not persisted to access-keys.json
   * (they live in memory only), so without this a restart would reset every
   * card's usage window and hand out fresh quota. Runs once: this service owns
   * the shared AccessKeyStore; the codex/anthropic pools reuse the same instance
   * and must NOT replay again (hydrate appends — a second pass would double-count).
   * Best-effort: a failure just means cold windows, it never blocks startup.
   */
  async onModuleInit(): Promise<void> {
    const prisma = this.bootPrisma;
    if (!prisma) return;
    // 去影子:先把所有 ACTIVE 订阅从 DB 加载进内存(subscriptionById),再 hydrate 用量。
    // 顺序关键 —— 用量只会挂到已存在的 record 上(见 hydrateWindowsFromUsageLog)。
    await this.loadActiveSubscriptions(prisma);
    if (!prisma?.cardTokenUsage?.findMany) return;
    try {
      // The weekly window is the widest (≤7d); 5h windows are a subset. Pull the
      // last 7 days once; each card's window read filters to its own period.
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await prisma.cardTokenUsage.findMany({
        where: { timestamp: { gte: since } },
        select: {
          accessKeyId: true, modelKey: true, bucket: true, status: true,
          inputTokens: true, outputTokens: true, cachedInputTokens: true,
          rawTotalTokens: true, totalTokens: true, timestamp: true,
        },
      });
      this.accessKeyStore.hydrateWindowsFromUsageLog(
        rows.map((r: any) => ({ ...r, at: new Date(r.timestamp).getTime() })),
      );
    } catch (err: any) {
      console.error(`[token-server] window replay from CardTokenUsage failed: ${err?.message || err}`);
    }
  }

  /**
   * 去影子:把所有生效订阅(老列)转成限额 record,注册进 AccessKeyStore 的内存
   * subscriptionById。boot 跑一次;新订阅激活时由 entitlement-sync 增量注册。
   * Best-effort:失败只是该订阅冷启动,不阻塞启动。
   */
  private async loadActiveSubscriptions(prisma: any): Promise<void> {
    if (!prisma?.subscription?.findMany) return;
    try {
      const now = new Date();
      const subs = await prisma.subscription.findMany({
        where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: {
          id: true, customerId: true, status: true, expiresAt: true, productEntitlements: true,
          bucketLimits: true, bindings: true, levels: true, weight: true,
          deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
        },
      });
      const records = subs.map((s: any) =>
        subscriptionToLimitRecord({ id: s.id, customerId: s.customerId, status: s.status, expiresAt: s.expiresAt, config: legacyColumnsToConfig(s) }),
      );
      this.accessKeyStore.loadSubscriptionRecords(records as any);
    } catch (err: any) {
      console.error(`[token-server] subscription load failed: ${err?.message || err}`);
    }
  }
}
