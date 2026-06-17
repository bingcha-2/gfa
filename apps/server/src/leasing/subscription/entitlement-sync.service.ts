/**
 * entitlement-sync.service.ts — 去影子:把 Subscription 的限额配置注册进
 * AccessKeyStore 的内存 subscriptionById,不再写 access-keys.json「影子卡」。
 *
 * 唯一真相源是订阅(数据库),内存只是它的缓存 + 用量计数(spec §6):
 *  - 配置:运行时从内存 record(findById / resolveFromRequest)读,无文件影子。
 *  - 号池 vs 绑定:读 config.line(显式),不靠 bindings 空不空推断。
 *  - 座位占用:从「DB ACTIVE 订阅的 config」按 weight 求和(occupiedSharesByAccount),
 *    NOT 从文件数 —— 停写文件后文件不含订阅 bindings,从文件数会超卖(★陷阱★)。
 *  - 用量:内存窗口 + CardTokenUsage(本就不在文件)。
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
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { boundSeatsByAccount, occupiedSharesByAccount, salesSeatCapacityForProduct, seatWeight } from "./seat";
import { rowToConfig, subscriptionToLimitRecord } from "./subscription-config";

export const VALID_ENTITLEMENT_PRODUCTS = ["antigravity", "codex", "anthropic"] as const;

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
  ) {}

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
    const config = rowToConfig(sub as any);
    const line = String(config.line || "");

    if (line === "bind") {
      await this.syncBind(sub, config);
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
  private async syncBind(sub: Subscription, config: Record<string, any>): Promise<void> {
    const products: string[] = Array.isArray(config.products) ? config.products : [];
    const weight = seatWeight(config);
    const levels: Record<string, string> = (config.levels && typeof config.levels === "object") ? config.levels : {};
    // 绑定线 config 必带 bindings 键(单一真相源恒含显式占座位结果,缺则视为「待分配」)。
    const hadBindingsKey = config.bindings && typeof config.bindings === "object";
    const existingBindings: Record<string, number> = hadBindingsKey ? { ...config.bindings } : {};

    // Products that still need a seat (no real accountId bound yet).
    const unbound = products.filter((p) => !(Number(existingBindings[p]) > 0));

    if (unbound.length > 0) {
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
          const salesCapacity = salesSeatCapacityForProduct(config, product, ACCOUNT_SHARE_CAPACITY);
          const accountId = this.rosetta.assignSeatForProductFromShares(product, weight, level, shares, counts, salesCapacity);
          if (!accountId) {
            this.logger.error(
              `[entitlement-sync] subscription ${sub.id}: seat assignment FAILED for product "${product}" level "${level}" weight ${weight} — no account with ${weight} free shares; leaving it UNBOUND`,
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

      // 容量校验(排除本订阅自身);不足且非 force → 拒,避免超分。
      if (!force) {
        const { shares } = await this.seatOccupancyFromDb(product, subscriptionId);
        const salesCapacity = salesSeatCapacityForProduct(config, product, ACCOUNT_SHARE_CAPACITY);
        const free = salesCapacity - (shares.get(acctId) || 0);
        if (free < weight) {
          return { ok: false, error: `账号 #${acctId} 在「${product}」剩余份额 ${free} < 需要 ${weight}(可加 force 强制)` };
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
      this.tokenServer.reloadAccessKeys();
      this.remoteCodex.reloadAccessKeys();
      this.remoteAnthropic.reloadAccessKeys();
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
