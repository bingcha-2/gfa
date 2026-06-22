// Access-key (卡密) domain — TRIMMED after the 激活码 redesign.
//
// 后台发卡 / 改卡 / 绑卡 / 删卡 / 批量清理 + access-keys.json 卡持久化已全部删除:
// 开通服务只剩「账户下单订阅」与「激活码兑换」两条路,均走 DB 订阅,不再手动发卡。
//
// 本文件现在只保留订阅/激活码运行时仍依赖的载荷代码:
//   • withAccessKeysWriteLock —— 座位分配临界区串行(EntitlementSync 用);
//   • assignSeatForProductFromShares / hasAvailableSeatFromShares —— 去影子座位分配与下单预检
//     (occupancy 由调用方按 DB ACTIVE 订阅 config 算好传入,NOT 读文件);
//   • poolAccountById —— 换绑校验查号;
//   • boundCardCounts / boundSharesByAccount / clearBindingsForAccount / usedShares ——
//     账号池服务(codex / claude / antigravity)删号/统计时仍调用(文件无卡时返回空,无害)。

import * as path from "path";

import { getModelQuotaFraction, getModelQuotaResetAt } from "../token-server/lease-scheduler";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import { cardWeight, cardWeightFor } from "./lib/access-key-util";
import type { RosettaContext } from "./lib/context";
import { nowIso, readJson, writeJson } from "./lib/store";

// ── access-keys.json write lock ──────────────────────────────────────────────
// Process-wide promise-chain mutex serializing every COMPOUND read→mutate→write
// critical section. Node's single thread already makes each individual sync
// mutation atomic; the lock exists for callers whose critical section spans
// `await`s or composes several calls — most importantly
// EntitlementSyncService.syncSubscription, whose free-share computation and the
// upsert that consumes those shares must be atomic, or two concurrent purchases
// double-book the same upstream account past capacity.
// IN-PROCESS ONLY: the deployment is single-instance.
let accessKeysWriteChain: Promise<unknown> = Promise.resolve();

export function withAccessKeysWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = accessKeysWriteChain.then(fn);
  // Keep the chain alive when fn rejects — the CALLER sees the rejection via
  // `run`; the next queued section must still get its turn.
  accessKeysWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeSalesCapacity(value: unknown): number {
  const capacity = Math.floor(Number(value));
  return Number.isFinite(capacity) && capacity > 0 ? capacity : ACCOUNT_SHARE_CAPACITY;
}

export class AccessKeyService {
  constructor(private readonly ctx: RosettaContext) {}

  private writeAccessKeys(filePath: string, value: unknown): void {
    writeJson(filePath, value);
    this.ctx.accessKeysFile?.invalidate?.();
  }

  /**
   * 去影子座位分配:按 DB ACTIVE 订阅 config 算好的占用份额(occupiedShares:accountId→已用份)
   * 与人数(boundCounts:accountId→绑定张数)选号,NOT 从 access-keys.json 文件数 —— 停写文件后
   * 文件不再含订阅 bindings,从文件数会超卖(★陷阱★)。选号优先级(高→低):
   *   ① 没占满(余量 ≥ 本单 weight)—— 硬过滤
   *   ② 立刻能用(usableNow:此刻有量 / 已过重置)—— 让买家能马上用,压过「人多」
   *   ③ 其中人数最多(把拼车塞满、空号留给独享)
   *   ④ 回血最快(soonestReset 最早)
   *   ⑤ id 兜底(确定性)
   * 返回选中的 accountId,或 null(该等级**无任何可绑号** —— 等级不匹配 / 停用 / 配额永久耗尽,
   * 即候选集为空)。boundCounts 缺省为空 —— 预检(hasAvailableSeatFromShares)只问「有没有」,
   * 与排序无关。
   *
   * QUOTA-REDESIGN §7 / 决策7:**不再硬禁超卖(Σw>N)。** `N`(salesCapacity)退化为「保底席位数」,
   * 不是硬上限 —— 使用层按 `D=max(N,Σw)` 自动切薄,超卖只让每席变薄、永不撞墙。故选号策略:
   *   优先「没占满(free≥need)」的号按原优先级填满(②③④⑤);
   *   若全部占满 → 回退到「最闲」的号(occupied 最小 = free 最大,可为负数),让绑定仍成功(超卖),
   *   同样闲时再走原优先级兜底。只有候选集为空(无任何可绑号)才返回 null。
   */
  assignSeatForProductFromShares(
    product: string,
    weight: number,
    level: string,
    occupiedShares: Map<number, number>,
    boundCounts: Map<number, number> = new Map(),
    salesCapacity = ACCOUNT_SHARE_CAPACITY,
    opts: { exclusive?: boolean; exclusiveLocked?: Set<number>; oversellCeiling?: number } = {},
  ): number | null {
    if (product !== "codex" && product !== "antigravity" && product !== "anthropic") return null;
    const lvl = String(level || "").trim();
    if (!lvl) return null;
    const need = cardWeight({ weight });
    const capacity = normalizeSalesCapacity(salesCapacity);
    // 独享超卖改造:exclusive 不再享有特权,走和拼车完全一样的路径。exclusiveLocked 废弃。
    const ceiling = Number.isFinite(opts.oversellCeiling as number) ? (opts.oversellCeiling as number) : Infinity;
    const pool = readJson(this.poolFileFor(product), { accounts: [] });
    const candidates = (Array.isArray(pool.accounts) ? pool.accounts : [])
      .filter((a: any) => this.isAccountBindable(product, a, lvl))
      .map((a: any) => {
        const id = Number(a.id);
        const occupied = occupiedShares.get(id) || 0;
        const q = this.bindQuotaInfo(product, a);
        return {
          id,
          occupied,
          free: capacity - occupied,
          count: boundCounts.get(id) || 0,
          usableNow: q.usableNow,
          soonestReset: q.soonestReset,
        };
      });
    if (candidates.length === 0) return null;

    const seatSort = (a: any, b: any) =>
      Number(b.usableNow) - Number(a.usableNow) ||
      b.count - a.count ||
      (a.soonestReset || Infinity) - (b.soonestReset || Infinity) ||
      a.id - b.id;

    // ① 优先没占满(free≥need)—— 先填满再超卖。
    const withRoom = candidates.filter((r: any) => r.free >= need);
    if (withRoom.length > 0) return withRoom.sort(seatSort)[0].id;

    // ② 超卖:仅限「占用+本单 ≤ 封顶线」的号,选最闲(free 最大),同闲走原优先级。
    const oversellable = candidates.filter((r: any) => r.occupied + need <= ceiling);
    if (oversellable.length === 0) return null;
    return oversellable.sort((a: any, b: any) => b.free - a.free || seatSort(a, b))[0].id;
  }

  /**
   * 下单前座位预检(spec §10):该 product+level 是否有**任一可绑上游号**(等级匹配、可绑、配额未
   * 耗尽)。占用份额由调用方按 DB ACTIVE 订阅 config 算好传入(NOT 从文件数 —— 停写文件后会漏数)。
   * 只回答「有没有」:不实际分配、不写文件,纯读 —— 避免用户付钱后才发现没有可绑号。
   *
   * QUOTA-REDESIGN §7 / 决策7:既然超卖(Σw>N)已放开,「号满了」不再阻断下单 —— 只要该等级
   * 存在任一可绑号即返回 true(满号也能超卖)。委托 assignSeatForProductFromShares:它仅在候选集
   * 为空时返回 null,故本预检自然等价于「有没有可绑号」。
   */
  hasAvailableSeatFromShares(
    product: string,
    weight: number,
    level: string,
    occupiedShares: Map<number, number>,
    salesCapacity = ACCOUNT_SHARE_CAPACITY,
    opts: { exclusive?: boolean; exclusiveLocked?: Set<number>; oversellCeiling?: number } = {},
  ): boolean {
    return this.assignSeatForProductFromShares(product, weight, level, occupiedShares, new Map(), salesCapacity, opts) !== null;
  }

  // ── Static card → account binding 的份额会计(账号池服务删号/统计仍调用)──────────
  // access-keys.json 卡已退役 → 文件通常不含卡,这些方法返回空映射(无害);占用真相源是
  // DB ACTIVE 订阅(seat.ts / EntitlementSync)。保留是因为 codex/claude/antigravity 账号
  // 服务在删号、统计绑定数时仍调用它们。

  /**
   * Live-record predicate for share accounting — status unset or "active".
   * A terminal record keeps its bindings as HISTORY but its shares no longer
   * occupy capacity.
   */
  private isLiveKey(key: any): boolean {
    return !key?.status || key.status === "active";
  }

  /** Resolve a card's bound account in a pool: bindings map first, legacy fallback. */
  private keyBoundAccount(key: any, provider: string): number {
    const fromMap = Number(key?.bindings?.[provider] || 0);
    if (fromMap > 0) return fromMap;
    return String(key?.provider || "") === provider ? Number(key?.boundAccountId || 0) : 0;
  }

  /** Count cards bound to each account id within a pool. */
  boundCardCounts(provider: string): Map<number, number> {
    const data = readJson(path.join(this.ctx.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const counts = new Map<number, number>();
    for (const key of keys) {
      const accountId = this.keyBoundAccount(key, provider);
      if (accountId > 0) counts.set(accountId, (counts.get(accountId) || 0) + 1);
    }
    return counts;
  }

  /** Clear bindings that point at a deleted account, so no card is orphaned. */
  clearBindingsForAccount(provider: string, accountId: number) {
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let changed = false;
    for (const key of keys) {
      if (this.keyBoundAccount(key, provider) === accountId) {
        if (key.bindings) delete key.bindings[provider];
        if (String(key.provider || "") === provider) {
          key.provider = "";
          key.boundAccountId = 0;
        }
        changed = true;
      }
    }
    if (changed) this.writeAccessKeys(filePath, { ...data, keys, updatedAt: nowIso() });
  }

  /** Account-pool file for a provider. */
  private poolFileFor(provider: string): string {
    const fileName =
      provider === "codex" ? "codex-accounts.json" : provider === "anthropic" ? "anthropic-accounts.json" : "accounts.json";
    return path.join(this.ctx.dataDir, fileName);
  }

  /** 某产品池里按 id 找账号(供换绑校验:号必须真实存在)。找不到返回 null。 */
  poolAccountById(product: string, accountId: number): { id: number; email?: string; enabled?: boolean; planType?: string } | null {
    if (product !== "codex" && product !== "antigravity" && product !== "anthropic") return null;
    const pool = readJson(this.poolFileFor(product), { accounts: [] });
    const accounts = Array.isArray(pool.accounts) ? pool.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === Number(accountId));
    return acc ? { id: Number(acc.id), email: acc.email, enabled: acc.enabled !== false, planType: acc.planType } : null;
  }

  /**
   * Shares consumed per account in a pool (sum of LIVE bound cards' weights).
   * Non-active records don't count (see isLiveKey).
   */
  boundSharesByAccount(provider: string): Map<number, number> {
    const data = readJson(path.join(this.ctx.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const m = new Map<number, number>();
    for (const key of keys) {
      if (!this.isLiveKey(key)) continue;
      const acc = this.keyBoundAccount(key, provider);
      if (acc > 0) m.set(acc, (m.get(acc) || 0) + cardWeightFor(key, provider));
    }
    return m;
  }

  /**
   * 绑定选号用的配额视图:此刻是否可用(usableNow)+ 若没量、最近一次回血的时间
   * (soonestReset, epoch ms;0 = 无已知重置)。usableNow 含三种:有量、已过重置点
   * (getModelQuotaFraction 对过期窗口直接返回满血)、以及全无快照的新号。codex/anthropic 是
   * 账号级单窗(codex 存 "codex"、anthropic 的 claude 模型存 "claude");antigravity 按模型,
   * 取各已知模型里最早回血的时间。
   */
  private bindQuotaInfo(provider: string, account: any): { usableNow: boolean; soonestReset: number } {
    const keys =
      provider === "antigravity"
        ? Object.keys(account?.modelQuotaFractions || {})
        : [provider === "anthropic" ? "claude" : provider];
    // 全无快照的新号(antigravity 无任何模型键)→ 视为可用。
    if (provider === "antigravity" && keys.length === 0) return { usableNow: true, soonestReset: 0 };
    let usableNow = false;
    let soonestReset = 0;
    for (const key of keys) {
      const f = getModelQuotaFraction(account, key);
      if (f === null || f > 0) {
        usableNow = true;
        continue;
      }
      const reset = getModelQuotaResetAt(account, key); // 此刻没量:记下该窗口何时回血
      if (reset > 0) soonestReset = soonestReset === 0 ? reset : Math.min(soonestReset, reset);
    }
    return { usableNow, soonestReset };
  }

  /**
   * 能不能绑(座位预检的配额闸门)。绑定卡按时长卖、跨多个配额窗口,所以「此刻没量但有已知回血
   * 时间」的号也算活号、可绑 —— 否则会因瞬时 0% 把一个马上回血的号判死、白白拒单(★旧实现的坑★)。
   * 只有真·没量且无任何回血时间(永久耗尽 / 仅剩其它模型的「暂无」)才排除;全无快照的新号
   * usableNow=true,照旧可绑。
   */
  private accountHasQuota(provider: string, account: any): boolean {
    const { usableNow, soonestReset } = this.bindQuotaInfo(provider, account);
    return usableNow || soonestReset > 0;
  }

  /**
   * Can a card be auto-bound to this account? Mirrors the lease-time eligibility
   * for a BOUND card (enabled + token + provider-specific eligibility) AND the
   * mint-time policy: exact membership-level (planType) match + quota not
   * exhausted.
   *
   * 注意:这里是「绑定卡」的自动分配,故意 NOT 看 poolEnabled —— 入池/出池只决定一个号要不要
   * 参与「池子卡」的租号轮换,与「能不能被绑定」无关。
   */
  private isAccountBindable(provider: string, account: any, level: string): boolean {
    if (account?.enabled === false) return false;
    if (!(account?.refreshToken || account?.accessToken)) return false;
    if (provider === "antigravity" && !String(account?.projectId || "").trim()) return false;
    if (String(account?.planType || "") !== level) return false;
    return this.accountHasQuota(provider, account);
  }
}
