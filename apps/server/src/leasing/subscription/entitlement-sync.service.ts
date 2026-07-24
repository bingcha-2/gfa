/**
 * entitlement-sync.service.ts — 去影子:把 Subscription 的限额配置注册进
 * AccessKeyStore 的内存 subscriptionById,不再写 access-keys.json「影子卡」。
 *
 * 唯一真相源是订阅(数据库),内存只是它的缓存 + 用量计数(spec §6):
 *  - 配置:运行时从内存 record(findById / resolveFromRequest)读,无文件影子。
 *  - 号池 vs 绑定:读 config.line(显式),不靠 bindings 空不空推断。
 *  - 座位占用:从「DB ACTIVE 订阅的 config」按 weight 求和(occupiedSharesByAccount),
 *    NOT 从文件数 —— 停写文件后文件不含订阅 bindings,从文件数会超卖(★陷阱★)。
 *  - 用量:内存窗口 + Subscription.windowState(本就不在文件)。
 *
 * 并发(M13b):绑定线的「读 DB 已占份额 → 选号 → 回写 config.bindings」整段在进程级
 * withAccessKeysWriteLock 内串行 —— 两笔并发购买不会都读到「还剩 N 份」而把同一个号
 * 双占超容量。锁的临界区内不 await DB 之外的东西,使读到的份额与回写之间不被别的写者穿插。
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Subscription } from "@prisma/client";

import { withAccessKeysWriteLock } from "../rosetta/access-key.service";
import { RosettaService } from "../rosetta/rosetta.service";
import { TokenServerService } from "../token-server/token-server.service";
import { RemoteCodexService } from "../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../remote-anthropic/service/remote-anthropic.service";
import { AccessKeyStore } from "../token-server/access-key-store";
import { sharedFairShareRegistry } from "../token-server/fair-share-registry";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";
import type { CatalogConfig } from "../plan-catalog/pricing";
import { oversellCeiling } from "../plan-catalog/unified-entitlement";
import { boundSeatsByAccount, isExclusive, occupiedSharesByAccount, quotaSeatCapacityForProduct, seatWeight } from "./seat";
import { rowToConfig, subscriptionToLimitRecord } from "./subscription-config";
import { migrateBindSubscriptionToUsd } from "./subscription-usd-migration";

export const VALID_ENTITLEMENT_PRODUCTS = ["antigravity", "codex", "anthropic"] as const;
const UPGRADE_SEAT_OPTIONS = [1, 2, 4, 8] as const;

export type UpgradeSubscriptionSeatsResult =
  | {
      ok: true;
      subscription: Subscription;
      previousShareSeats: number;
      shareSeats: number;
      alreadyAtTarget: boolean;
      reboundProducts: Array<{
        product: string;
        previousAccountId: number | null;
        accountId: number;
      }>;
      usageByProduct: Record<string, {
        fiveHour: { used: number; limit: number; resetAt: string } | null;
        weekly: { used: number; limit: number; resetAt: string } | null;
      }>;
    }
  | { ok: false; error: string };

@Injectable()
export class EntitlementSyncService {
  private readonly logger = new Logger(EntitlementSyncService.name);

  constructor(
    private readonly rosetta: RosettaService,
    @Inject("SHARED_ACCESS_KEY_STORE") private readonly accessKeyStore: AccessKeyStore,
    private readonly tokenServer: TokenServerService,
    private readonly remoteCodex: RemoteCodexService,
    private readonly remoteAnthropic: RemoteAnthropicService,
    private readonly prisma: PrismaService,
    private readonly planCatalog: PlanCatalogService,
  ) {}

  /**
   * 解析某产品下绑定号的展示信息(id + 邮箱),供后台订阅详情内联展示绑定的是哪个号。
   * 池中已删/不存在 → 返回 null(调用方降级为仅 id)。
   */
  lookupPoolAccount(product: string, accountId: number): { id: number; email: string | null } | null {
    const acc = this.rosetta.poolAccountById(product, accountId);
    return acc ? { id: acc.id, email: acc.email ?? null } : null;
  }

  /** Runtime USD windows used by the console. This is the same status object
   * used by enforcement and the customer client, not a second accounting path. */
  subscriptionUsdQuotaUsage(subscriptionId: string): Record<string, {
    fiveHour: { used: number; limit: number; resetAt: string } | null;
    weekly: { used: number; limit: number; resetAt: string } | null;
  }> {
    const record = this.accessKeyStore.findById(subscriptionId);
    if (!record) return {};
    return this.accessKeyStore.publicStatus(record)?.usdQuotaByProduct ?? {};
  }

  /** Clear exactly one runtime USD window and persist the new snapshot now, so
   * an immediate process restart cannot restore the pre-reset amount. */
  async resetSubscriptionUsdQuotaUsage(
    subscriptionId: string,
    product: string,
    scope: 'fiveHour' | 'weekly',
  ): Promise<{ previousUsed: number; limit: number; usageByProduct: Record<string, any> } | null> {
    const before = this.accessKeyStore.snapshotSubscriptionUsage(subscriptionId);
    const reset = this.accessKeyStore.resetSubscriptionUsdUsage(subscriptionId, product, scope);
    if (!reset) return null;
    const snapshot = this.accessKeyStore.serializeSubscriptionWindows()
      .find((item) => item.id === subscriptionId)?.windowState ?? null;
    try {
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { windowState: snapshot },
      });
    } catch (error) {
      this.accessKeyStore.restoreSubscriptionUsage(subscriptionId, before);
      throw error;
    }
    return {
      ...reset,
      usageByProduct: this.subscriptionUsdQuotaUsage(subscriptionId),
    };
  }

  /** Reset every active bind-line subscription currently routed to one upstream
   * account. This clears only local customer USD counters; it does not mutate
   * the plan's limits or the upstream account's own quota observations. */
  async resetBoundAccountUsdQuotas(
    product: "codex" | "anthropic",
    accountId: number,
  ): Promise<{ product: "codex" | "anthropic"; accountId: number; matchedSubscriptions: number; resetSubscriptions: number; resetWindows: number; skippedSubscriptions: number }> {
    if (product !== "codex" && product !== "anthropic") throw new Error("Unsupported USD product");
    const normalizedAccountId = Number(accountId);
    if (!(normalizedAccountId > 0)) throw new Error("Invalid accountId");

    return withAccessKeysWriteLock(async () => {
      const rows = await this.prisma.subscription.findMany({ where: { status: "ACTIVE" } });
      const matched = rows.filter((sub: any) => {
        const config = rowToConfig(sub);
        return config.line === "bind" && Number((config.bindings as Record<string, unknown> | undefined)?.[product]) === normalizedAccountId;
      });
      const snapshots = new Map<string, unknown>();
      const updates: Array<{ id: string; windowState: string | null }> = [];
      let resetSubscriptions = 0;
      let resetWindows = 0;

      for (const sub of matched) {
        const before = this.accessKeyStore.snapshotSubscriptionUsage(sub.id);
        snapshots.set(sub.id, before);
        let changed = false;
        for (const scope of ["fiveHour", "weekly"] as const) {
          if (!this.accessKeyStore.resetSubscriptionUsdUsage(sub.id, product, scope)) continue;
          changed = true;
          resetWindows += 1;
        }
        if (!changed) continue;
        resetSubscriptions += 1;
        updates.push({
          id: sub.id,
          windowState: this.accessKeyStore.serializeSubscriptionWindows().find((item) => item.id === sub.id)?.windowState ?? null,
        });
      }

      try {
        if (updates.length) {
          await this.prisma.$transaction(updates.map(({ id, windowState }) =>
            this.prisma.subscription.update({ where: { id }, data: { windowState } }),
          ));
        }
      } catch (error) {
        for (const [subscriptionId, snapshot] of snapshots) {
          this.accessKeyStore.restoreSubscriptionUsage(subscriptionId, snapshot as any);
        }
        throw error;
      }

      return {
        product,
        accountId: normalizedAccountId,
        matchedSubscriptions: matched.length,
        resetSubscriptions,
        resetWindows,
        skippedSubscriptions: matched.length - resetSubscriptions,
      };
    });
  }

  /** Move all active subscriptions bound to an account across one or more
   * eligible accounts of the exact same level. Planning happens before any
   * write, so this is an all-or-nothing operation when their combined capacity
   * is insufficient. */
  async rebindBoundAccountSubscriptions(
    product: "codex" | "anthropic",
    sourceAccountId: number,
  ): Promise<{ ok: true; product: "codex" | "anthropic"; sourceAccountId: number; movedSubscriptions: number; targets: Array<{ accountId: number; email: string | null; count: number }> } | { ok: false; error: string }> {
    if (product !== "codex" && product !== "anthropic") return { ok: false, error: "Unsupported USD product" };
    const sourceId = Number(sourceAccountId);
    if (!(sourceId > 0)) return { ok: false, error: "Invalid accountId" };

    return withAccessKeysWriteLock(async () => {
      const rows = await this.prisma.subscription.findMany({ where: { status: "ACTIVE" } });
      const configs = rows.map((sub: any) => ({ sub, config: rowToConfig(sub) }));
      const sourceRows = configs.filter(({ config }) =>
        config.line === "bind" && Number((config.bindings as Record<string, unknown> | undefined)?.[product]) === sourceId,
      );
      if (!sourceRows.length) {
        return { ok: true, product, sourceAccountId: sourceId, movedSubscriptions: 0, targets: [] };
      }

      const accountingConfigs = configs.map(({ sub, config }) => ({ id: sub.id, ...config }));
      const shares = occupiedSharesByAccount(accountingConfigs, product);
      const counts = boundSeatsByAccount(accountingConfigs, product);
      for (const { config } of sourceRows) {
        const weight = seatWeight(config);
        shares.set(sourceId, Math.max(0, (shares.get(sourceId) || 0) - weight));
        counts.set(sourceId, Math.max(0, (counts.get(sourceId) || 0) - 1));
      }

      // Rebinding is an operational move performed under the CURRENT supply
      // policy. Historical quotaSeatCapacity snapshots must keep protecting a
      // customer's purchased quota, but must not make an old subscription see
      // less pool capacity than the currently published oversell ceiling.
      const published = await this.planCatalog.getPublished();
      const currentCatalog = (published?.config ?? {}) as Partial<CatalogConfig>;
      const runtimeBaseCapacity = Number(currentCatalog.shareCapacity) || ACCOUNT_SHARE_CAPACITY;
      const currentOversellCeiling = oversellCeiling(currentCatalog, runtimeBaseCapacity);

      const plan: Array<{ sub: any; config: Record<string, any>; targetId: number }> = [];
      const excluded = new Set([sourceId]);
      // Place larger subscriptions first. The allocator updates the simulated
      // occupancy after every choice, so later subscriptions can spill into a
      // second/third account instead of requiring one account to fit the whole
      // source batch. Largest-first also avoids rejecting a valid combined-
      // capacity plan merely because smaller subscriptions fragmented it.
      const planningRows = [...sourceRows].sort((a, b) =>
        seatWeight(b.config) - seatWeight(a.config) || String(a.sub.id).localeCompare(String(b.sub.id)),
      );
      for (const { sub, config } of planningRows) {
        const level = String((config.levels as Record<string, unknown> | undefined)?.[product] || "").trim();
        if (!level) return { ok: false, error: `Subscription ${sub.id} has no ${product} level and cannot be safely rebound` };
        const weight = seatWeight(config);
        const targetId = this.rosetta.assignSeatForProductFromShares(
          product,
          weight,
          level,
          shares,
          counts,
          currentOversellCeiling,
          { oversellCeiling: currentOversellCeiling, excludeAccountIds: excluded },
        );
        if (!targetId) {
          return { ok: false, error: `Enabled ${product} accounts do not have enough combined same-level capacity for all subscriptions (${level}; blocked at ${sub.id})` };
        }
        shares.set(targetId, (shares.get(targetId) || 0) + weight);
        counts.set(targetId, (counts.get(targetId) || 0) + 1);
        plan.push({ sub, config, targetId });
      }

      try {
        await this.prisma.$transaction(plan.map(({ sub, config, targetId }) => {
          const bindings = { ...(config.bindings as Record<string, number> | undefined), [product]: targetId };
          const nextConfig = { ...config, line: "bind", bindings };
          return this.prisma.subscription.update({
            where: { id: sub.id },
            data: { config: JSON.stringify(nextConfig), bindings: JSON.stringify(bindings) },
          });
        }));
      } catch (error) {
        this.logger.error(`[account-rebind] failed to persist ${product} account #${sourceId}: ${String(error)}`);
        throw error;
      }

      for (const item of plan) {
        item.config.bindings = { ...(item.config.bindings as Record<string, number> | undefined), [product]: item.targetId };
        item.config.line = "bind";
        this.registerRecord(item.sub, item.config);
      }
      await Promise.all([
        this.tokenServer.reloadAccessKeys(),
        this.remoteCodex.reloadAccessKeys(),
        this.remoteAnthropic.reloadAccessKeys(),
      ]);

      const targets = new Map<number, number>();
      for (const { targetId } of plan) targets.set(targetId, (targets.get(targetId) || 0) + 1);
      return {
        ok: true,
        product,
        sourceAccountId: sourceId,
        movedSubscriptions: plan.length,
        targets: [...targets].map(([accountId, count]) => ({
          accountId,
          email: this.rosetta.poolAccountById(product, accountId)?.email ?? null,
          count,
        })),
      };
    });
  }

  /**
   * Increase a bind subscription's purchased shares without creating a new
   * subscription or a new quota window. Limits grow in the same proportion,
   * while AccessKeyStore keeps the existing used amounts and reset epochs.
   *
   * Capacity is planned against the currently published oversell ceiling. A
   * product stays on its current mother account when the larger subscription
   * still fits; otherwise only that product is moved to an enabled, same-level
   * account that can hold the complete upgraded subscription.
   */
  async upgradeSubscriptionSeats(
    subscriptionId: string,
    requestedShareSeats: number,
  ): Promise<UpgradeSubscriptionSeatsResult> {
    const targetShareSeats = Math.floor(Number(requestedShareSeats));
    if (!UPGRADE_SEAT_OPTIONS.includes(targetShareSeats as (typeof UPGRADE_SEAT_OPTIONS)[number])) {
      return { ok: false, error: "Seats must be one of 1, 2, 4, or 8" };
    }

    return withAccessKeysWriteLock(async () => {
      const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
      if (!sub) return { ok: false, error: "Subscription not found" };
      if (sub.status !== "ACTIVE" || (sub.expiresAt && sub.expiresAt.getTime() <= Date.now())) {
        return { ok: false, error: "Only an unexpired ACTIVE subscription can be upgraded" };
      }

      const config = rowToConfig(sub as any);
      if (config.line !== "bind") {
        return { ok: false, error: "Only a bound-account subscription supports seat upgrades" };
      }
      const previousShareSeats = seatWeight(config);
      if (targetShareSeats < previousShareSeats) {
        return { ok: false, error: "Seat upgrades cannot reduce the current seat count" };
      }
      if (targetShareSeats === previousShareSeats) {
        return {
          ok: true,
          subscription: sub,
          previousShareSeats,
          shareSeats: targetShareSeats,
          alreadyAtTarget: true,
          reboundProducts: [],
          usageByProduct: this.subscriptionUsdQuotaUsage(sub.id),
        };
      }

      const published = await this.planCatalog.getPublished();
      const currentCatalog = (published?.config ?? {}) as Partial<CatalogConfig>;
      const runtimeBaseCapacity = Number(currentCatalog.shareCapacity) || ACCOUNT_SHARE_CAPACITY;
      const currentOversellCeiling = oversellCeiling(currentCatalog, runtimeBaseCapacity);
      const purchasedShareCapacity = Math.max(
        1,
        Math.floor(Number(config.shareCapacity) || runtimeBaseCapacity),
      );
      if (targetShareSeats > purchasedShareCapacity) {
        return {
          ok: false,
          error: `Target seats ${targetShareSeats} exceed this subscription's share capacity ${purchasedShareCapacity}`,
        };
      }

      const rows = await this.prisma.subscription.findMany({ where: { status: "ACTIVE" } });
      const accountingConfigs = rows.map((row: any) => ({ id: row.id, ...rowToConfig(row) }));
      const products = Array.isArray(config.products) ? config.products.map(String) : [];
      const levels = config.levels && typeof config.levels === "object"
        ? config.levels as Record<string, unknown>
        : {};
      const currentBindings = config.bindings && typeof config.bindings === "object"
        ? config.bindings as Record<string, number>
        : {};
      const nextBindings = { ...currentBindings };
      const reboundProducts: Array<{
        product: string;
        previousAccountId: number | null;
        accountId: number;
      }> = [];

      for (const product of products) {
        const level = String(levels[product] || "").trim();
        if (!level) {
          return { ok: false, error: `Subscription ${sub.id} has no ${product} level` };
        }
        const shares = occupiedSharesByAccount(accountingConfigs, product, sub.id);
        const counts = boundSeatsByAccount(accountingConfigs, product, sub.id);
        const previousAccountId = Number(currentBindings[product]) > 0
          ? Number(currentBindings[product])
          : null;
        const previousAccount = previousAccountId
          ? this.rosetta.poolAccountById(product, previousAccountId)
          : null;
        const currentStillFits = Boolean(
          previousAccount
          && previousAccount.enabled !== false
          && (shares.get(previousAccountId!) || 0) + targetShareSeats <= currentOversellCeiling,
        );

        let accountId = currentStillFits ? previousAccountId! : 0;
        if (!accountId) {
          accountId = this.rosetta.assignSeatForProductFromShares(
            product,
            targetShareSeats,
            level,
            shares,
            counts,
            currentOversellCeiling,
            {
              exclusive: config.exclusive === true || targetShareSeats >= purchasedShareCapacity,
              oversellCeiling: currentOversellCeiling,
              ...(previousAccountId ? { excludeAccountIds: new Set([previousAccountId]) } : {}),
            },
          ) ?? 0;
        }
        if (!(accountId > 0)) {
          return {
            ok: false,
            error: `No enabled ${product} ${level} account can hold ${targetShareSeats} seats under the current published limit ${currentOversellCeiling}`,
          };
        }

        nextBindings[product] = accountId;
        if (accountId !== previousAccountId) {
          reboundProducts.push({ product, previousAccountId, accountId });
        }
      }

      const ratio = targetShareSeats / previousShareSeats;
      const nextConfig: Record<string, any> = {
        ...config,
        bindings: nextBindings,
        shareSeats: targetShareSeats,
        weight: targetShareSeats,
        shareCapacity: purchasedShareCapacity,
        exclusive: config.exclusive === true || targetShareSeats >= purchasedShareCapacity,
      };
      if (config.usdQuotaByProduct && typeof config.usdQuotaByProduct === "object") {
        nextConfig.usdQuotaByProduct = scaleQuotaByProduct(config.usdQuotaByProduct, ratio);
        nextConfig.quotaSeatCapacity = currentOversellCeiling;
      }
      if (config.bucketLimits && typeof config.bucketLimits === "object") {
        nextConfig.bucketLimits = scaleNumericMap(config.bucketLimits, ratio);
      }
      if (config.weeklyBucketLimits && typeof config.weeklyBucketLimits === "object") {
        nextConfig.weeklyBucketLimits = scaleNumericMap(config.weeklyBucketLimits, ratio);
      }
      if (Number(config.weeklyTokenLimit) > 0) {
        nextConfig.weeklyTokenLimit = Math.round(Number(config.weeklyTokenLimit) * ratio);
      }

      const updated = await this.prisma.$transaction([
        this.prisma.subscription.update({
          where: { id: sub.id },
          data: {
            config: JSON.stringify(nextConfig),
            bindings: Object.keys(nextBindings).length ? JSON.stringify(nextBindings) : null,
            weight: targetShareSeats,
            bucketLimits: nextConfig.bucketLimits ? JSON.stringify(nextConfig.bucketLimits) : sub.bucketLimits,
            weeklyTokenLimit: Number(nextConfig.weeklyTokenLimit) > 0
              ? Number(nextConfig.weeklyTokenLimit)
              : sub.weeklyTokenLimit,
          },
        }),
      ]).then(([row]) => row);

      // loadSubscriptionRecords refreshes only configuration fields. It
      // deliberately retains usdUsageByProduct, including usedWeekly and both
      // reset epochs, so an upgrade cannot become an early quota reset.
      this.registerRecord(updated, nextConfig);
      await Promise.all([
        this.tokenServer.reloadAccessKeys(),
        this.remoteCodex.reloadAccessKeys(),
        this.remoteAnthropic.reloadAccessKeys(),
      ]);

      this.logger.log(
        `[seat-upgrade] subscription ${sub.id}: ${previousShareSeats} -> ${targetShareSeats}`
        + (reboundProducts.length
          ? `; rebound ${reboundProducts.map((item) => `${item.product}:${item.previousAccountId ?? "none"}->${item.accountId}`).join(",")}`
          : ""),
      );
      return {
        ok: true,
        subscription: updated,
        previousShareSeats,
        shareSeats: targetShareSeats,
        alreadyAtTarget: false,
        reboundProducts,
        usageByProduct: this.subscriptionUsdQuotaUsage(sub.id),
      };
    });
  }

  /**
   * Register/refresh a subscription's runtime limit record from its config
   * (single source of truth). On first sync of a BIND-line sub, auto-assigns an
   * upstream seat per still-unbound product and persists the bindings back into
   * Subscription.config. POOL-line subs skip seats entirely. Usage counters /
   * in-memory windows are preserved across resync (loadSubscriptionRecords).
   */
  async syncSubscription(sub: Subscription, _opts: { customerEmail?: string } = {}): Promise<void> {
    // rowToConfig(非 parseConfig):卡迁移订阅的 config 列为空、绑定在 legacy `bindings` 列。
    // 只读 config 会把它当 line="" → 落进号池分支、丢掉对原账号的绑定;回退 legacy 后它
    // 正确呈现为 line=bind + 原 bindings,syncBind 见其已绑 → 不重新分配 → 保住原账号。
    let config = rowToConfig(sub as any);
    let catalog: Partial<CatalogConfig> | null = null;
    let catalogVersion: number | undefined;
    try {
      const published = await this.planCatalog.getPublished();
      catalog = published?.config as Partial<CatalogConfig> | null;
      catalogVersion = Number.isFinite(Number(published?.version)) ? Number(published?.version) : undefined;
    } catch {
      catalog = null;
    }
    const migration = migrateBindSubscriptionToUsd(config, catalog, { catalogVersion });
    if (migration.changed) {
      config = migration.config;
      // A later renewal/reactivation of an old row gets the same one-way upgrade
      // as boot-active subscriptions. Fail closed: do not register a migrated
      // in-memory record unless its source-of-truth config is durable.
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { config: JSON.stringify(config) },
      });
    }
    const line = String(config.line || "");

    if (line === "bind") {
      // Keep legacy/test constructors compatible: older callers may not yet
      // provide PlanCatalogService. Missing relay settings must mean the normal
      // mother-account path, never break seat assignment for existing plans.
      const resolveRelay = (this.planCatalog as any)?.resolveCodexRelaySettings;
      const codexRelayEnabled = typeof resolveRelay === "function"
        ? (await resolveRelay.call(this.planCatalog)).enabled === true
        : false;
      await this.syncBind(sub, config, catalog, codexRelayEnabled);
    } else {
      // 号池(及任何非 bind):不占座位,直接注册限额 record。
      this.registerRecord(sub, config);
    }
  }

  /**
   * 绑定线:在写锁内按 DB 已占份额选号、回写 config.bindings,再注册 record。
   * 已绑(config.bindings 已有真实 accountId)的产品不重复分配 —— resync(续期)
   * 直接复用,不再写 DB、不再占新份额。
   */
  private async syncBind(
    sub: Subscription,
    config: Record<string, any>,
    catalog: Partial<CatalogConfig> | null,
    codexRelayEnabled = false,
  ): Promise<void> {
    const products: string[] = Array.isArray(config.products) ? config.products : [];
    const weight = seatWeight(config);
    const levels: Record<string, string> = (config.levels && typeof config.levels === "object") ? config.levels : {};
    // 绑定线 config 必带 bindings 键(单一真相源恒含显式占座位结果,缺则视为「待分配」)。
    const hadBindingsKey = config.bindings && typeof config.bindings === "object";
    const existingBindings: Record<string, number> = hadBindingsKey ? { ...config.bindings } : {};

    // Products that still need a seat (no real accountId bound yet).
    const unbound = products.filter((p) =>
      !(codexRelayEnabled && p === "codex") && !(Number(existingBindings[p]) > 0));

    if (unbound.length > 0) {
      const exclusive = isExclusive(config);
      // Read DB shares → assign → persist, serialized so two concurrent purchases
      // can't both read "free" and double-book past capacity.
      await withAccessKeysWriteLock(async () => {
        // 每个产品独立计已占份额(座位是 per-product 的),排除本订阅自身。
        for (const product of unbound) {
          const level = String(levels[product] || "").trim();
          if (!level) {
            this.logger.error(
              `[entitlement-sync] subscription ${sub.id}: no membership level for product "${product}" — leaving it UNBOUND`,
            );
            continue;
          }
          const { shares, counts } = await this.seatOccupancyFromDb(product, sub.id);
          const salesCapacity = quotaSeatCapacityForProduct(config, product, ACCOUNT_SHARE_CAPACITY);
          const accountId = this.rosetta.assignSeatForProductFromShares(
            product, weight, level, shares, counts, salesCapacity,
            { exclusive, oversellCeiling: salesCapacity },
          );
          if (!accountId) {
            this.logger.error(
              `[entitlement-sync] subscription ${sub.id}: seat assignment FAILED for product "${product}" level "${level}" weight ${weight} exclusive=${exclusive} — no eligible account (等级不匹配 / 停用 / 配额耗尽);leaving it UNBOUND`,
            );
            continue;
          }
          existingBindings[product] = accountId;
        }

        // Persist the (possibly-empty) bindings into Subscription.config INSIDE the
        // lock, so the next waiter's DB read sees consumed shares immediately, and
        // a bind sub's config always carries an explicit bindings key. First sync
        // always writes (key was absent); resync-with-all-bound short-circuits above.
        config.bindings = existingBindings;
        await this.persistConfig(sub.id, config);
      });
    }

    config.bindings = existingBindings;
    this.registerRecord(sub, config);

    // 中途加超卖人即时生效:本次新绑的产品,把新成员当窗口升为 participant(满号超卖号当窗口即享
    // 保底份额,不必等下个窗口 reset)。registerRecord 后内存绑定已含本卡,getBoundCardWeights 可见。
    for (const product of unbound) {
      const accountId = Number(existingBindings[product]);
      const tracker = accountId > 0 ? sharedFairShareRegistry.get(product) : undefined;
      if (!tracker) continue;
      tracker.refreshParticipants(accountId);
      await tracker.flush();
    }
  }

  /**
   * 管理后台「换绑/加绑」:把某订阅在某产品上的绑定切到指定上游号。
   * 用途:修「已开通某产品却没绑它」(409 此卡未开通该服务),或迁移后挪座位。
   * 卡迁移订阅 config 空 → rowToConfig 回退识别其线路/已有绑定。
   * force=true 跳过容量/停用校验(管理员强制),但号必须真实存在(避免绑到空号把订阅打死)。
   */
  async rebindProduct(
    subscriptionId: string,
    product: string,
    accountId: number,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: true; product: string; accountId: number } | { ok: false; error: string }> {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) return { ok: false, error: "订阅不存在" };
    if (product !== "antigravity" && product !== "codex" && product !== "anthropic") {
      return { ok: false, error: "未知产品" };
    }
    const acctId = Number(accountId);
    if (!(acctId > 0)) return { ok: false, error: "accountId 非法" };
    const force = opts.force === true;

    return withAccessKeysWriteLock(async () => {
      const config = rowToConfig(sub as any);
      const products: string[] = Array.isArray(config.products) ? config.products.map(String) : [];
      if (!products.includes(product)) {
        return { ok: false, error: `该订阅未开通产品「${product}」,不能绑定` };
      }
      const weight = seatWeight(config);

      // 目标号必须真实存在(force 也校验,绑到不存在的号 = 把订阅打死)。
      const acc = this.rosetta.poolAccountById(product, acctId);
      if (!acc) return { ok: false, error: `「${product}」池中不存在账号 #${acctId}` };
      if (!force && acc.enabled === false) return { ok: false, error: `账号 #${acctId} 已停用(可加 force 强制)` };

      // 自动绑定和手工换绑共用同一最大可售份数。只有管理员显式 force 才能突破。
      {
        const { shares } = await this.seatOccupancyFromDb(product, subscriptionId);
        const salesCapacity = quotaSeatCapacityForProduct(config, product, ACCOUNT_SHARE_CAPACITY);
        const free = salesCapacity - (shares.get(acctId) || 0);
        if (free < weight) {
          if (!force) {
            return { ok: false, error: `账号 #${acctId} 已达到最大可售份数 ${salesCapacity}` };
          }
          this.logger.warn(
            `[rebind] sub ${subscriptionId} product ${product} → account #${acctId} 超过最大可售份数 ${salesCapacity}(force)`,
          );
        }
      }

      const bindings: Record<string, number> =
        config.bindings && typeof config.bindings === "object" ? { ...config.bindings } : {};
      bindings[product] = acctId;
      config.bindings = bindings;
      config.line = "bind";
      // config + 镜像 legacy bindings 列一起写(两边一致;读取侧 config 优先)。
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { config: JSON.stringify(config), bindings: JSON.stringify(bindings) },
      });
      // 重新注册内存 record + reload 各池 → 运行时立刻按新绑定路由。
      this.registerRecord(sub, config);
      await Promise.all([
        this.tokenServer.reloadAccessKeys(),
        this.remoteCodex.reloadAccessKeys(),
        this.remoteAnthropic.reloadAccessKeys(),
      ]);
      // reloadAccessKeys 内部已在刷新后的绑定表上执行 refreshAllParticipants + flush；
      // 不要在 checkpoint 之后再发一次未等待持久化的重复 membership 事件。
      this.logger.log(`[rebind] sub ${subscriptionId} product ${product} → account #${acctId}${force ? " (force)" : ""}`);
      return { ok: true, product, accountId: acctId };
    });
  }

  /** Build the limit record from config and register it in the in-memory store (no file). */
  private registerRecord(sub: Subscription, config: Record<string, any>): void {
    const record = subscriptionToLimitRecord({
      id: sub.id,
      customerId: sub.customerId,
      priority: sub.priority,
      backingKeyValue: sub.backingKeyValue,
      status: sub.status,
      expiresAt: sub.expiresAt,
      config,
    });
    this.accessKeyStore.loadSubscriptionRecords([record as any]);
  }

  /**
   * 某产品在所有 ACTIVE 订阅里的座位占用(排除本订阅),一次读出两张表:
   * shares = Σweight(容量口径,判余量);counts = 绑定张数(人数口径,选号「人数最多」用)。
   */
  private async seatOccupancyFromDb(
    product: string,
    excludeId: string,
  ): Promise<{ shares: Map<number, number>; counts: Map<number, number> }> {
    const rows = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      // config 空(卡迁移订阅)时要从 legacy 列回退,否则漏数其占用 → 选号超分。
      select: {
        id: true, config: true,
        productEntitlements: true, bucketLimits: true, bindings: true, levels: true,
        weight: true, deviceLimit: true, weeklyTokenLimit: true, windowMs: true,
      },
    });
    const configs = rows.map((r: any) => ({ id: r.id, ...rowToConfig(r) }));
    return {
      shares: occupiedSharesByAccount(configs, product, excludeId),
      counts: boundSeatsByAccount(configs, product, excludeId),
    };
  }

  /** Persist a config object back onto the subscription row. */
  private async persistConfig(subscriptionId: string, config: Record<string, any>): Promise<void> {
    try {
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { config: JSON.stringify(config) },
      });
    } catch (err: any) {
      this.logger.error(`[entitlement-sync] subscription ${subscriptionId}: persisting config failed: ${err?.message || err}`);
    }
  }

  /**
   * 去影子:把订阅 record 标记 expired(限额引擎拒绝非 active record)。用量/绑定历史保留 —— 座位
   * 由份额会计释放(occupiedSharesByAccount 只数 ACTIVE 订阅;调用方已把 status 翻成终态)。
   * 内存即时生效,调用方(expire/cancel)返回后该 record 立刻不可租。
   */
  expireShadowRecord(subscriptionId: string): void {
    this.accessKeyStore.loadSubscriptionRecords([{ id: subscriptionId, status: "expired" } as any]);
  }
}

function scaleQuotaByProduct(
  value: Record<string, any>,
  ratio: number,
): Record<string, { fiveHour: number; weekly: number }> {
  return Object.fromEntries(Object.entries(value).map(([product, quota]) => [
    product,
    {
      fiveHour: scaleQuotaAmount(quota?.fiveHour, ratio),
      weekly: scaleQuotaAmount(quota?.weekly, ratio),
    },
  ]));
}

function scaleNumericMap(value: Record<string, any>, ratio: number): Record<string, number> {
  return Object.fromEntries(Object.entries(value)
    .map(([key, amount]): [string, number] => [key, Math.round(Number(amount) * ratio)])
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0));
}

function scaleQuotaAmount(value: unknown, ratio: number): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * ratio * 1_000_000) / 1_000_000;
}
