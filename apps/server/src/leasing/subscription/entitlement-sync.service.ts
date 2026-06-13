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
import { PrismaService } from "../../shared/prisma/prisma.service";
import { occupiedSharesByAccount } from "./seat";
import { subscriptionToLimitRecord } from "./subscription-config";

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
    const config = parseConfig(sub.config);
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
    const weight = Math.max(1, Math.floor(Number(config.weight) || 1));
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
          const occupied = await this.occupiedSharesFromDb(product, sub.id);
          const accountId = this.rosetta.assignSeatForProductFromShares(product, weight, level, occupied);
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

  /** Occupied shares per account for a product, from all ACTIVE subs' configs (DB), excluding self. */
  private async occupiedSharesFromDb(product: string, excludeId: string): Promise<Map<number, number>> {
    const rows = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, config: true },
    });
    const configs = rows.map((r: { id: string; config: string | null }) => ({ id: r.id, ...parseConfig(r.config) }));
    return occupiedSharesByAccount(configs, product, excludeId);
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

function parseConfig(json: string | null): Record<string, any> {
  try {
    const parsed = JSON.parse(String(json || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
