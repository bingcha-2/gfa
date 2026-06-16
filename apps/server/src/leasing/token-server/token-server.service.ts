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
  /** Periodic persister for subscription 5h/weekly window snapshots → Subscription.windowState. */
  private windowPersistTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly WINDOW_PERSIST_INTERVAL_MS = 60_000;

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
      getCardWeight: (cardId: string) => {
        try {
          const r = service.accessKeyStore.findById(cardId) as any;
          // 按产品份额:weights[provider.id] 优先,否则回退卡级 weight。
          const w = Math.floor(Number(r?.weights?.[provider.id] || 0) || Number(r?.weight ?? 1));
          return (Number.isFinite(w) && w >= 1) ? Math.min(w, ACCOUNT_SHARE_CAPACITY) : 1;
        } catch { return 1; }
      },
      accountShareCapacity: ACCOUNT_SHARE_CAPACITY,
      getLearnedBudget: (planType: string, bucket: string) => {
        return quotaProfileTracker.getLearnedBudget5h(
          provider.id, planType, bucketFamily(bucket),
        );
      },
      getWeeklyRatio: (planType: string, bucket: string) => {
        return quotaProfileTracker.getWeeklyToShortRatio(
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
   * On boot, load ACTIVE subscriptions into memory and restore each one's 5h/weekly
   * rate-limit window from its persisted snapshot (Subscription.windowState) — done
   * inside loadActiveSubscriptions. No per-call replay: windows are durable now, so
   * a restart resumes the exact windows instead of handing out fresh quota.
   * Runs once: this service owns the shared AccessKeyStore (codex/anthropic pools
   * reuse the same instance). Best-effort: never blocks startup.
   */
  async onModuleInit(): Promise<void> {
    const prisma = this.bootPrisma;
    if (!prisma) return;
    await this.loadActiveSubscriptions(prisma);

    // Start periodic persistence of subscription window snapshots so a restart
    // restores the exact 5h/weekly windows (no replay, no quota over-handout).
    if (prisma?.subscription?.update && !this.windowPersistTimer) {
      this.windowPersistTimer = setInterval(
        () => { void this.persistSubscriptionWindows(); },
        TokenServerService.WINDOW_PERSIST_INTERVAL_MS,
      );
      // Don't keep the event loop alive for this background timer.
      (this.windowPersistTimer as any)?.unref?.();
    }
  }

  /**
   * Persist every subscription's live 5h/weekly window snapshot to
   * Subscription.windowState. Runs on an interval + once on shutdown. Best-effort:
   * a failed write just means that sub falls back to a cold(er) window next boot.
   */
  async persistSubscriptionWindows(): Promise<void> {
    const prisma = this.bootPrisma;
    if (!prisma?.subscription?.update) return;
    let snapshots: Array<{ id: string; windowState: string }>;
    try {
      snapshots = this.accessKeyStore.serializeSubscriptionWindows();
    } catch (err: any) {
      console.error(`[token-server] serialize subscription windows failed: ${err?.message || err}`);
      return;
    }
    for (const { id, windowState } of snapshots) {
      try {
        await prisma.subscription.update({ where: { id }, data: { windowState } });
      } catch {
        // Sub may have been deleted/expired between snapshot and write — ignore.
      }
    }
  }

  /** Persist windows + stop the timer on shutdown, then run the base teardown. */
  async onModuleDestroy(): Promise<void> {
    if (this.windowPersistTimer) {
      clearInterval(this.windowPersistTimer);
      this.windowPersistTimer = null;
    }
    try { await this.persistSubscriptionWindows(); }
    catch (err: any) { console.error(`[token-server] window persist on shutdown failed: ${err?.message || err}`); }
    await super.onModuleDestroy();
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
          id: true, customerId: true, priority: true, backingKeyValue: true, status: true, expiresAt: true, productEntitlements: true,
          bucketLimits: true, bindings: true, levels: true, weight: true,
          deviceLimit: true, weeklyTokenLimit: true, windowMs: true, windowState: true,
        },
      });
      const records = subs.map((s: any) =>
        subscriptionToLimitRecord({ id: s.id, customerId: s.customerId, priority: s.priority, backingKeyValue: s.backingKeyValue, status: s.status, expiresAt: s.expiresAt, config: legacyColumnsToConfig(s) }),
      );
      this.accessKeyStore.loadSubscriptionRecords(records as any);
      // 精准恢复 5h/周窗口快照(优先于从 CardTokenUsage 回放;恢复过的订阅 hydrate 会跳过)。
      for (const s of subs) {
        if (s.windowState) this.accessKeyStore.restoreSubscriptionWindow(s.id, s.windowState);
      }
    } catch (err: any) {
      console.error(`[token-server] subscription load failed: ${err?.message || err}`);
    }
  }
}
