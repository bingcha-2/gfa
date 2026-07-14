import { Injectable, Optional, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { LeaseService, LeaseServiceHttpError, type TokenUsageTracker, type AccountQuotaSnapshotRecorder } from "../lease-core/lease-service";
import { FairShareTracker } from "./fair-share-tracker";
import { AntigravityProvider } from "./antigravity.provider";
import { TokenAccount } from "./account-token-provider";
import type { AccessKeyStore } from "./access-key-store";
import { rowToConfig, subscriptionToLimitRecord } from "../subscription/subscription-config";
import { migrateBindSubscriptionToUsd } from "../subscription/subscription-usd-migration";
import type { CatalogConfig } from "../plan-catalog/pricing";

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
  /** PrismaService — persists FairShareWindow (omit in unit tests). */
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
  private subscriptionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly WINDOW_PERSIST_INTERVAL_MS = 60_000;

  constructor(@Optional() options: ServiceOptions = {}) {
    const provider = new AntigravityProvider({
      accountsFilePath: options.accountsFilePath,
      tokenProvider: options.tokenProvider,
    });
    // Auto-create fair-share tracker wired to this service's own accessKeyStore.
    // Uses a deferred pattern: the tracker's callbacks reference `service` which
    // is assigned after super() returns.
    let service: TokenServerService;
    const fairShareTracker = new FairShareTracker({
      getCardWeight: (cardId: string) => {
        const r: any = service.accessKeyStore.findById(cardId);
        // 按产品份额:weights[provider.id] 优先,否则回退卡级 weight。不再 clamp 到容量。
        const w = Math.floor(Number(r?.weights?.[provider.id] || 0) || Number(r?.weight ?? 1));
        return Number.isFinite(w) && w >= 1 ? w : 1;
      },
      getBoundCardWeights: (accountId: number) =>
        service.accessKeyStore.getHardBoundCardWeights(accountId, provider.id),
      getSeatCapacity: (accountId: number) =>
        service.accessKeyStore.getSeatCapacityFor(accountId, provider.id),
      isExclusive: (cardId: string) =>
        service.accessKeyStore.isExclusiveCard(cardId),
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
        errorClass: TokenServerHttpError,
      },
    );
    service = this;
    this.bootPrisma = options.prisma;
    // 启动屏障:本进程负责加载订阅表(有 prisma)时,加载成功前不放行成员对账,
    // 防止 DB 抖动 + 重启把订阅用户全部标成 inactive(持续 429 直到换绑)。
    // 构造函数先于所有 onModuleInit 执行,codex/anthropic 共享同一 store,屏障全局生效。
    if (this.bootPrisma?.subscription?.findMany) {
      this.accessKeyStore.beginSubscriptionBarrier();
    }
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
  async persistSubscriptionWindows(strict = false): Promise<void> {
    const prisma = this.bootPrisma;
    if (!prisma?.subscription?.update) return;
    let snapshots: Array<{ id: string; windowState: string }>;
    try {
      // USD-only Codex/Claude windows commit atomically with each report receipt;
      // a delayed timer snapshot must never overwrite that newer durable head.
      snapshots = this.accessKeyStore.serializeSubscriptionWindows({ includeUsd: strict });
    } catch (err: any) {
      console.error(`[token-server] serialize subscription windows failed: ${err?.message || err}`);
      if (strict) throw err;
      return;
    }
    for (const { id, windowState } of snapshots) {
      try {
        await prisma.subscription.update({ where: { id }, data: { windowState } });
      } catch (err) {
        // Sub may have been deleted/expired between snapshot and write — ignore.
        if (strict) throw err;
      }
    }
  }

  /** Persist windows + stop the timer on shutdown, then run the base teardown. */
  async onModuleDestroy(): Promise<void> {
    if (this.windowPersistTimer) {
      clearInterval(this.windowPersistTimer);
      this.windowPersistTimer = null;
    }
    if (this.subscriptionRetryTimer) {
      clearTimeout(this.subscriptionRetryTimer);
      this.subscriptionRetryTimer = null;
    }
    try { await this.persistSubscriptionWindows(); }
    catch (err: any) { console.error(`[token-server] window persist on shutdown failed: ${err?.message || err}`); }
    await super.onModuleDestroy();
  }

  /**
   * 上线先幂等迁移全部历史 Codex/Claude 绑定订阅；再把生效订阅转成限额 record,
   * 注册进 AccessKeyStore 的内存 subscriptionById。新订阅激活时由 entitlement-sync 增量注册。
   * 失败不阻塞启动,但保持启动屏障:成员对账与放租等到某次重试成功才恢复,
   * 不允许拿「没有订阅」的残缺名单覆盖旧账本。
   */
  private async loadActiveSubscriptions(prisma: any, attempt = 0): Promise<void> {
    if (!prisma?.subscription?.findMany) return;
    try {
      // Only currently usable subscriptions are migrated. Cancelled/revoked or
      // expired rows remain untouched; if one is renewed later, entitlement-sync
      // performs the same migration at activation time using then-current defaults.
      const now = new Date();
      const migrationRows = await prisma.subscription.findMany({
        where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: {
          id: true, productEntitlements: true,
          bucketLimits: true, bindings: true, levels: true, weight: true,
          deviceLimit: true, weeklyTokenLimit: true, windowMs: true, config: true,
        },
      });
      let catalog: Partial<CatalogConfig> | null = null;
      let catalogVersion: number | undefined;
      try {
        const published = await prisma.planCatalog?.findFirst?.({ where: { status: "PUBLISHED" } });
        catalog = published?.config ? JSON.parse(published.config) : null;
        catalogVersion = Number.isFinite(Number(published?.version)) ? Number(published.version) : undefined;
      } catch {
        // Built-in defaults are authoritative fallback when no catalog exists or
        // an old published row is malformed.
        catalog = null;
      }
      let migratedCount = 0;
      const migratedConfigs = new Map<string, string>();
      for (const sub of migrationRows) {
        const migration = migrateBindSubscriptionToUsd(rowToConfig(sub), catalog, { catalogVersion });
        if (!migration.changed) continue;
        const serialized = JSON.stringify(migration.config);
        // Migration is part of the readiness barrier: never serve an in-memory
        // USD config that failed to become durable in Subscription.config.
        await prisma.subscription.update({ where: { id: sub.id }, data: { config: serialized } });
        sub.config = serialized;
        migratedConfigs.set(sub.id, serialized);
        migratedCount++;
      }
      if (migratedCount > 0) {
        console.log(`[token-server] migrated ${migratedCount} Codex/Claude subscription(s) to USD quota defaults`);
      }
      const subs = await prisma.subscription.findMany({
        where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: {
          id: true, customerId: true, priority: true, backingKeyValue: true, status: true, expiresAt: true, productEntitlements: true,
          bucketLimits: true, bindings: true, levels: true, weight: true,
          deviceLimit: true, weeklyTokenLimit: true, windowMs: true, windowState: true, config: true,
        },
      });
      for (const sub of subs) {
        const migratedConfig = migratedConfigs.get(sub.id);
        if (migratedConfig) sub.config = migratedConfig;
      }
      const records = subs.map((s: any) =>
        subscriptionToLimitRecord({ id: s.id, customerId: s.customerId, priority: s.priority, backingKeyValue: s.backingKeyValue, status: s.status, expiresAt: s.expiresAt, config: rowToConfig(s) }),
      );
      this.accessKeyStore.loadSubscriptionRecords(records as any);
      // 从 Subscription.windowState 精准恢复 5h/周窗口；逐请求旧表已退役。
      for (const s of subs) {
        if (s.windowState) this.accessKeyStore.restoreSubscriptionWindow(s.id, s.windowState);
      }
      // Migration may have converted legacy token events into compact USD
      // counters. Make that conversion durable before opening the readiness
      // barrier, so a crash cannot replay the legacy snapshot as fresh quota.
      await this.persistSubscriptionWindows(true);
      await this.accessKeyStore.markSubscriptionsReady();
      if (this.subscriptionRetryTimer) {
        clearTimeout(this.subscriptionRetryTimer);
        this.subscriptionRetryTimer = null;
      }
    } catch (err: any) {
      console.error(`[token-server] subscription load failed (attempt ${attempt + 1}): ${err?.message || err}`);
      // 屏障保持拉起,退避重试直到成功;期间放租返回 503、成员对账被推迟。
      const delayMs = [5_000, 15_000, 60_000][attempt] ?? 60_000;
      if (!this.subscriptionRetryTimer) {
        this.subscriptionRetryTimer = setTimeout(() => {
          this.subscriptionRetryTimer = null;
          void this.loadActiveSubscriptions(prisma, attempt + 1);
        }, delayMs);
        (this.subscriptionRetryTimer as any)?.unref?.();
      }
    }
  }
}
