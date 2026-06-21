/**
 * fair-share-tracker.ts — Fraction-share quota for bound cards (重构版,见 QUOTA-REDESIGN.md)。
 *
 * 核心模型(不再反推/学习上游 token 预算,只信上游剩余百分比 fraction):
 *   - 每个绑定主人 i 的保证份额 e_i = w_i / D,D = max(N, Σw),窗口开始锁定。
 *     N = 该号保底席位数(salesSeatCapacity,默认 8);Σw = 真实卖出份额。
 *     卖 ≤ N → D=N → 保底 1/N + 预留;卖 > N(超卖)→ D=Σw → 每席切薄到 1/Σw。
 *     因 D≥Σw → Σe = Σw/D ≤ 1 恒成立 → 账号永远够分、永不撞墙、永烧不爆。
 *   - 归因 T_i(累计已烧账号比例,只增不减):每次 fraction 快照刷新时,把这一段账号
 *     消耗 Δ账号 = max(0, 低水位 − fraction) 按本段各人加权用量比例分摊进各人 T_i。
 *     lastFraction 是窗口内单调不增的「低水位」,只随真实下降前进 → fraction 噪声/乱序
 *     回升不重复计数(QUOTA-REDESIGN §15.1)。
 *   - 拦人:T_i ≥ e_i;血条:clamp((e_i − T_i)/e_i, 0, 1),e_i≤0 → 0(空且拦)。
 *   - reset 只认上游 resetAt 前移(对齐上游窗口),清零 T_i/u_i 并重算锁定 D。
 *
 * Weighted tokens(只当「同号主人间的分账比例」与账单,绝不进「账号还剩多少」判断):
 *   weightedCost = netInput × W_input + output × W_output + cache × W_cache
 *   权重派生自单一定价源 packages/shared/src/pricing.json。
 */

import { QUOTA_WEIGHTS } from "@gfa/shared";

import { bucketFamily, claudeModelTier, quotaWeightFor } from "../lease-core/product-bucket";
import { sharedFairShareRegistry } from "./fair-share-registry";

// quotaWeightFor 已迁至 product-bucket(供 token-billing 静态封顶复用,避免循环依赖)。
export { quotaWeightFor };
// 权重派生自 @gfa/shared 单一定价源(pricing.json),改价只改那里。
export { QUOTA_WEIGHTS };
// 保留 bucketFamily re-export 供既有引用点(历史兼容)。
export { bucketFamily };

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 小时
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const WEEKLY_SUFFIX = "::weekly";

/** 默认保底席位数 N(无 salesSeatCapacity 时回退)。 */
const DEFAULT_SEAT_CAPACITY = 8;

/** reset 对齐容差:windowStart 前移超过此值才认作上游窗口 reset。 */
const RESET_DRIFT_MS = 60_000;

/**
 * 低水位回升确认:上游可能「刷额度不动 resetAt」(重置额度 ≠ 重置时间)或周窗口老用量滑出而
 * 自然回升,此时 resetAt 不前移、forward-reset 不触发,低水位会停在旧低点把所有人份额缩小。
 * 故允许低水位回升——但要「持续够久 + 至少 2 次读数 + 涨幅超容差」才抬,滤掉 seven_day 偶发漏返
 * 的瞬时虚高(否则虚高被采纳、随后真值回落会把同一段消耗二次归因)。
 * 为什么按时间而非纯次数:纯次数与上报频率挂钩——高频号几秒就能「凑够」次数,等于没护栏;按
 * 「持续够久仍高」与流量快慢无关,瞬时坏值满足不了。单次/乱序回升仍不抬(见 #32/#34)。
 * 不要求读数相同:任何高于低水位 >EPS 的读数都算一次确认,采纳这段的最低高值(保守棘轮)。
 */
const REBOUND_CONFIRM_MS = 5 * 60 * 1000; // 回升需持续此时长才采纳
const REBOUND_MIN_CONFIRMATIONS = 2; // 且至少 2 次读数(防时间窗内仅 1 个孤值)
const REBOUND_EPS = 0.02;

/** 定时批量持久化间隔。 */
const FLUSH_INTERVAL_MS = 30_000;

/** 某桶对应的周窗口 key。 */
export function weeklyBucketKey(bucket: string): string {
  return `${bucket}${WEEKLY_SUFFIX}`;
}
/** 该 key 是否是周窗口(求和/血条时排除,避免与 5h 双算)。 */
export function isWeeklyBucketKey(bucket: string): boolean {
  return bucket.endsWith(WEEKLY_SUFFIX);
}
/** 去掉周后缀,取回基础桶名。 */
function baseBucketOf(bucket: string): string {
  return isWeeklyBucketKey(bucket) ? bucket.slice(0, -WEEKLY_SUFFIX.length) : bucket;
}

// ── Types ───────────────────────────────────────────────────────────────────

/** 窗口开始锁定的份额态(per account × bucket × window)。 */
interface LockedShare {
  /** 分母 D = max(N, Σw@reset),窗口内不变。 */
  D: number;
  /** reset 时刻在册的硬绑定卡集合(参与卡)。 */
  participants: Set<string>;
  /** 可领预留(R0 = max(0, 1 − Σw/D);窗口内新绑卡按序领取后递减)。 */
  reserveAvail: number;
  /** 窗口内新绑卡(不在 participants)已领到的预留份额。 */
  grantedReserve: Map<string, number>;
}

interface BucketTracker {
  windowMs: number;
  windowStart: number;
  /** u_i:自上次归并以来各卡新增加权用量(归并后清零)。 */
  perCard: Map<string, number>;
  /** T_i:本窗口累计已烧账号比例 [0,1],只增不减。 */
  attributed: Map<string, number>;
  /** 低水位:窗口内单调不增的上游剩余 fraction(reset 时设为 fresh,默认 1)。 */
  lastFraction: number;
  /**
   * 基线是否已确立。冷建 tracker(getOrCreate)时 lastFraction=1.0 只是占位,window 中途
   * 冷启动(如迁移清空 FairShareWindow 后重启)首个上游快照若直接按 max(0,1−fraction) 归并,
   * 会把「冷启动前别人已烧掉的账号额」整段砸给当前活跃卡(周窗口尤甚:账号常已烧到个位数 →
   * 首个活跃卡被砸 ~94% → 血条秒归零)。故首个有效快照应「采纳」其 fraction 为低水位、不归因
   * (QUOTA-REDESIGN §9/§344:冷启动短暂从宽,reset 自愈)。reset/load 恢复出的基线是真值 → true。
   */
  primed: boolean;
  /** 锁定份额态;reset 时算定,null 表示尚未算(懒算兜底)。 */
  locked: LockedShare | null;
  /**
   * 回升待确认态(仅内存,不持久化):观察到 fraction 持续高于低水位时,记起始时刻 since + 读数次数
   * count + 这段的保守(最低)高值 fraction;持续够久且够多次才抬低水位。真跌 / 回落到低水位附近 →
   * 清零。重启后从 null 起算(重新确认即可),无需入库。
   */
  pendingRise?: { fraction: number; since: number; count: number } | null;
}

export interface FairShareCheck {
  allowed: boolean;
  reason?: string;
  /** Per-card 自份额剩余 (0~1),供血条。 */
  remainingFraction?: number;
  window?: "5h" | "7d";
  bucket?: string;
  resetAt?: number;
  resetMs?: number;
  retryAfterMs?: number;
}

export interface FairShareTrackerOptions {
  /** 单卡份额权重 w_i(按会员等级;独占号给 w=N)。不再 clamp。 */
  getCardWeight: (cardId: string) => number;
  /** 某号所有硬绑定主人 + 各自权重(算 Σw / participants / D)。 */
  getBoundCardWeights: (accountId: number) => Array<{ cardId: string; weight: number }>;
  /** 某号保底席位数 N(salesSeatCapacity,默认 8)。 */
  getSeatCapacity?: (accountId: number) => number;
  /** 是否启用「周公平份额」第二层窗口。codex/anthropic=true;antigravity 仅 5h=false。 */
  trackWeekly?: boolean;
  /** PrismaService for FairShareWindow persistence. 省略则禁用持久化。 */
  prisma?: any;
  /** Provider id(antigravity | codex | anthropic)— 分区持久化行。 */
  provider?: string;
  /** 可注入时钟(默认 Date.now),保持窗口测试确定性。 */
  now?: () => number;
}

// ── Core class ──────────────────────────────────────────────────────────────

export class FairShareTracker {
  // accountId → bucket → tracker
  private readonly trackers = new Map<number, Map<string, BucketTracker>>();
  private readonly opts: FairShareTrackerOptions;
  private readonly prisma: any;
  private readonly providerId: string;
  private readonly nowFn: () => number;
  private readonly trackWeekly: boolean;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(opts: FairShareTrackerOptions) {
    this.opts = opts;
    this.prisma = opts.prisma ?? null;
    this.providerId = opts.provider || "";
    this.nowFn = opts.now || Date.now;
    this.trackWeekly = opts.trackWeekly === true;
    if (this.prisma && this.providerId) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
    // Self-register so the heartbeat (app-auth) can read this provider's live
    // 我的份额 without a cross-module DI path. See fair-share-registry.ts.
    if (this.providerId) sharedFairShareRegistry.register(this.providerId, this);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** 单次请求的加权 token 成本。modelOrBucket 优先传真实 modelKey(按 Claude 档位计价)。 */
  static weightedCost(
    modelOrBucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): number {
    const w = quotaWeightFor(modelOrBucket);
    // input 为 gross(含 cached),取 netInput 去重,避免缓存被 input+cache 双算。
    const netInput = Math.max(0, inputTokens - cachedInputTokens);
    return netInput * w.input + outputTokens * w.output + cachedInputTokens * w.cache;
  }

  /** 记录一次完成请求的加权用量(累加进段内增量 u_i)。仅硬绑定主人(门控在 lease-service)。 */
  recordUsage(
    accountId: number,
    cardId: string,
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
    modelKey?: string,
  ): void {
    // 自动补全(tab_*/flash_lite)不消耗额度:不计入任何窗口。
    if (modelKey && claudeModelTier(modelKey) === "autocomplete") return;
    const cost = FairShareTracker.weightedCost(modelKey || bucket, inputTokens, outputTokens, cachedInputTokens);
    if (cost <= 0) return;
    const now = this.nowFn();
    const keys = this.trackWeekly ? [bucket, weeklyBucketKey(bucket)] : [bucket];
    for (const key of keys) {
      const tracker = this.getOrCreate(accountId, key);
      this.ensureWindow(accountId, tracker, now);
      tracker.perCard.set(cardId, (tracker.perCard.get(cardId) || 0) + cost);
    }
    this.dirty = true;
  }

  /**
   * 上游 5h 快照刷新:归并这一段账号消耗进各人 T_i,并对齐窗口 reset(QUOTA-REDESIGN §4.2a)。
   * @param fraction  上游剩余 fraction(-1 = 未知,不归并只累积 u_i)。
   * @param resetAtMs 上游窗口 reset 时间(epoch ms,0/缺省 = 不喂入)。
   */
  applyAccountQuotaSnapshot(accountId: number, bucket: string, fraction: number, resetAtMs = 0): void {
    this.applySnapshot(accountId, bucket, fraction, resetAtMs);
  }

  /** 上游周快照刷新(no-op unless trackWeekly)。 */
  applyWeeklyAccountQuotaSnapshot(accountId: number, bucket: string, fraction: number, resetAtMs = 0): void {
    if (!this.trackWeekly) return;
    this.applySnapshot(accountId, weeklyBucketKey(bucket), fraction, resetAtMs);
  }

  /** 校验某卡是否在公平份额内(5h + 周,任一超额即拦)。 */
  checkFairShare(accountId: number, cardId: string, bucket: string): FairShareCheck {
    const short = this.checkWindow(accountId, cardId, bucket);
    if (!this.trackWeekly) return short;
    const weekly = this.checkWindow(accountId, cardId, weeklyBucketKey(bucket));
    const blocking = !short.allowed ? short : !weekly.allowed ? weekly : null;
    if (blocking) {
      return {
        allowed: false,
        reason: blocking.reason,
        remainingFraction: 0,
        window: blocking.window,
        bucket: blocking.bucket,
        resetAt: blocking.resetAt,
        resetMs: blocking.resetMs,
        retryAfterMs: blocking.retryAfterMs,
      };
    }
    const chosen = (short.remainingFraction ?? 1) <= (weekly.remainingFraction ?? 1) ? short : weekly;
    return {
      allowed: true,
      remainingFraction: Math.min(short.remainingFraction ?? 1, weekly.remainingFraction ?? 1),
      window: chosen.window,
      bucket: chosen.bucket,
      resetAt: chosen.resetAt,
      resetMs: chosen.resetMs,
    };
  }

  /** 5h 每卡自份额剩余(供血条),键为基础桶名。share=e_i(我的份额占整号比例,供双层血条)。 */
  getCardQuotaFractions(accountId: number, cardId: string): Record<string, { fraction: number; resetAt: number; share: number }> {
    return this.collectFractions(accountId, cardId, false);
  }

  /** 周每卡自份额剩余(供周血条);仅 trackWeekly 有数据。 */
  getCardWeeklyQuotaFractions(accountId: number, cardId: string): Record<string, { fraction: number; resetAt: number; share: number }> {
    if (!this.trackWeekly) return {};
    return this.collectFractions(accountId, cardId, true);
  }

  /** 是否启用周窗口(codex/anthropic=true)。 */
  isWeeklyTracked(): boolean {
    return this.trackWeekly;
  }

  /**
   * 中途加绑即时生效:把该号当前在册硬绑定全部升格为「本窗口 participant」,按 D=max(N,Σw) 重算锁定态,
   * 不重置窗口(保留 T_i/u_i/低水位/windowStart)。用于满号超卖新成员当窗口即享保底份额 —— 与默认
   * 「reset 才锁定 participants(加人下个窗口才生效)」相对。代价:稀释已有成员本窗口已锁定的份额
   * (D 变大 → 各人 e_i=w_i/D 变小);因 D≥Σw → Σe≤1 恒成立,账号仍永不撞墙。
   *
   * 仅刷新已存在的 tracker:尚无 tracker 的号首次用量时 ensureLocked 已按当前绑定算定,无需预建。
   * 绑定写库 + reloadAccessKeys 之后调用,使 getBoundCardWeights 已含新成员。
   */
  refreshParticipants(accountId: number): void {
    const bucketMap = this.trackers.get(accountId);
    if (!bucketMap) return;
    for (const tracker of bucketMap.values()) {
      tracker.locked = this.computeLocked(accountId);
    }
    this.dirty = true;
  }

  /** 一张卡本 5h 窗口的段内加权用量(跨该号所有 5h bucket 求和)。 */
  getCardWindowUsed(accountId: number, cardId: string): number {
    const bucketMap = this.trackers.get(accountId);
    if (!bucketMap) return 0;
    const now = this.nowFn();
    let total = 0;
    for (const [key, tracker] of bucketMap) {
      if (isWeeklyBucketKey(key)) continue;
      this.ensureWindow(accountId, tracker, now);
      total += tracker.perCard.get(cardId) || 0;
    }
    return total;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private collectFractions(
    accountId: number,
    cardId: string,
    weekly: boolean,
  ): Record<string, { fraction: number; resetAt: number; share: number }> {
    const bucketTrackers = this.trackers.get(accountId);
    if (!bucketTrackers) return {};
    const now = this.nowFn();
    const out: Record<string, { fraction: number; resetAt: number; share: number }> = {};
    for (const [key, tracker] of bucketTrackers) {
      if (isWeeklyBucketKey(key) !== weekly) continue;
      this.ensureWindow(accountId, tracker, now);
      const resetAt = tracker.windowStart + tracker.windowMs;
      // fraction = 我份额的剩余(血条);share = e_i 我份额占整号比例(双层血条外层几何)。
      out[baseBucketOf(key)] = {
        fraction: this.bloodBar(accountId, tracker, cardId),
        resetAt,
        share: this.shareFor(accountId, tracker, cardId),
      };
    }
    return out;
  }

  /**
   * 本窗口所有「持份卡」(participants ∪ 已领预留新卡)的剩余之和 Σ(e_j − T_j)。
   * 供 bloodBar 等比例缩放——只读,绝不领预留。
   */
  private sumRemaining(accountId: number, tracker: BucketTracker): number {
    const locked = this.ensureLocked(accountId, tracker);
    const sharers = new Set<string>([...locked.participants, ...locked.grantedReserve.keys()]);
    let sum = 0;
    for (const card of sharers) {
      const e = this.shareFor(accountId, tracker, card);
      const t = tracker.attributed.get(card) || 0;
      if (e > t) sum += e - t;
    }
    return sum;
  }

  /**
   * 自份额剩余血条:(e_i − T_i)/e_i,再按账号余量【等比例】缩放,使各人「我的总剩余」之和不超账号。
   * 未认领消耗(冷启动前消耗 / 轮换·preferred-dynamic 等不进分账的用量 / 未认领段)会把账号烧低而不抬 T_i,
   * 此时 Σ(e_j−T_j) > 账号实际余量。各人若都按裸 (e−T) 报,就会出现「我的 > 账号」或「各人加总 > 账号」
   * 的不可能态(超卖号尤甚:10 份卖 10 人、账号剩 6% 时,裸值各人 10%、加总 100% ≫ 6%)。
   * 缩放系数 scale = min(1, 账号余量 / Σ所有人剩余):
   *   我的总剩余 = e_i × bloodBar = (e_i−T_i)×scale ≤ 账号,且 Σ = min(Σ, 账号) ≤ 账号 —— 谁都不超分。
   * 账号够分(Σ ≤ 账号)→ scale=1,血条照旧;只有 1 人有剩时退化成 min(e_i−T_i, 账号)。
   * e_i≤0 → 0(空且拦)。
   */
  private bloodBar(accountId: number, tracker: BucketTracker, cardId: string): number {
    const e = this.shareFor(accountId, tracker, cardId);
    if (e <= 0) return 0;
    const t = tracker.attributed.get(cardId) || 0;
    const mine = Math.max(0, e - t);
    const sumRem = this.sumRemaining(accountId, tracker);
    const scale = sumRem > tracker.lastFraction ? tracker.lastFraction / sumRem : 1;
    return clamp01((mine * scale) / e);
  }

  /** 单窗口(5h 或周)份额判定。 */
  private checkWindow(accountId: number, cardId: string, key: string): FairShareCheck {
    const tracker = this.trackers.get(accountId)?.get(key);
    const window = isWeeklyBucketKey(key) ? "7d" : "5h";
    const bucket = baseBucketOf(key);
    if (!tracker) {
      return { allowed: true, remainingFraction: 1.0, window, bucket };
    }
    const now = this.nowFn();
    this.ensureWindow(accountId, tracker, now);
    const resetAt = tracker.windowStart + tracker.windowMs;
    const resetMs = Math.max(0, resetAt - now);

    // 取号闸:这是真正发卡的判定点,窗口内新卡在此「先到先得」领预留(唯一提交点)。
    const e = this.claimShare(accountId, tracker, cardId);
    const t = tracker.attributed.get(cardId) || 0;
    // e≤0(无份额/满号新卡)或 T_i 已达份额 → 拦。
    if (e <= 0 || t >= e) {
      const label = isWeeklyBucketKey(key) ? "本周公平限额" : "公平限额";
      return {
        allowed: false,
        reason: `${label}已用完(账号份额 ${(t * 100).toFixed(1)}% ≥ 我的 ${(e * 100).toFixed(1)}%)`,
        remainingFraction: 0,
        window,
        bucket,
        resetAt,
        resetMs,
        retryAfterMs: resetMs,
      };
    }
    return { allowed: true, remainingFraction: clamp01((e - t) / e), window, bucket, resetAt, resetMs, retryAfterMs: resetMs };
  }

  /**
   * 该卡在本窗口的保证份额 e_i —— 只读,不改预留态(供血条/展示)。
   * participant → w/D;已领预留的新卡 → 已领值;未领新卡 → min(w/D, 当前可领预留)的「预估值」。
   */
  private shareFor(accountId: number, tracker: BucketTracker, cardId: string): number {
    const locked = this.ensureLocked(accountId, tracker);
    const w = Math.max(0, this.opts.getCardWeight(cardId));
    if (locked.participants.has(cardId)) return clamp01(w / locked.D);
    if (locked.grantedReserve.has(cardId)) return locked.grantedReserve.get(cardId)!;
    return Math.min(clamp01(w / locked.D), Math.max(0, locked.reserveAvail));
  }

  /**
   * 同 shareFor,但对窗口内新绑卡会「提交」一次预留领取(递减 reserveAvail、固定 grantedReserve)。
   * 仅在取号闸(checkWindow)调用 —— 先到先得按真实发卡时机,而非血条展示时机(避免只读路径抢预留)。
   */
  private claimShare(accountId: number, tracker: BucketTracker, cardId: string): number {
    const locked = this.ensureLocked(accountId, tracker);
    const w = Math.max(0, this.opts.getCardWeight(cardId));
    if (locked.participants.has(cardId)) return clamp01(w / locked.D);
    if (locked.grantedReserve.has(cardId)) return locked.grantedReserve.get(cardId)!;
    const g = Math.min(clamp01(w / locked.D), Math.max(0, locked.reserveAvail));
    locked.reserveAvail = Math.max(0, locked.reserveAvail - g);
    locked.grantedReserve.set(cardId, g);
    this.dirty = true;
    return g;
  }

  /** 核心:归并 + reset 对齐(applyAccountQuotaSnapshot 实体)。 */
  private applySnapshot(accountId: number, key: string, fraction: number, resetAtMs: number): void {
    const tracker = this.getOrCreate(accountId, key);
    const now = this.nowFn();
    // 1) 自计时过期 reset(离线跨过窗口边界时)。
    this.ensureWindow(accountId, tracker, now);
    // 2) 上游 resetAt 驱动 reset:只认 windowStart 前移(>容差),忽略 stale/乱序(后移)。
    if (Number.isFinite(resetAtMs) && resetAtMs > 0) {
      const newStart = resetAtMs - tracker.windowMs;
      if (newStart > tracker.windowStart + RESET_DRIFT_MS) {
        this.resetWindow(accountId, tracker, newStart, fraction >= 0 ? fraction : 1.0);
        return;
      }
      if (tracker.primed && newStart < tracker.windowStart - RESET_DRIFT_MS) {
        return;
      }
    }
    // 3) fraction 未知(-1)→ 不归并,继续累积 u_i(等有效 fraction 回来一次性归并)。
    if (!(fraction >= 0)) return;
    // 首个快照:确保 locked 已算(用当前在册绑定 = 本窗口 participants)。
    this.ensureLocked(accountId, tracker);
    // 3a) 冷启动采纳基线:tracker 是冷建的、还没见过任何真实快照(primed=false)→ 把当前 fraction
    //     直接当作低水位,不把「冷启动前」的账号消耗(1−fraction)归因给当前活跃卡(见 BucketTracker.primed)。
    if (!tracker.primed) {
      tracker.primed = true;
      tracker.lastFraction = clamp01(fraction);
      // 冷启动对齐上游窗口:首个快照带上游 resetAt 时,采纳真实窗口起点(即便在过去)。
      // 冷窗口的 windowStart 只是 getOrCreate/自计时的猜测(now);下方 forward-only reset 规则
      // 只认前移,会拒绝把它后移到真实起点 → 周窗口要等下个上游 reset(最多 7 天)才对齐,
      // 倒计时错显成 now+7d 而非真实剩余(5h 因每 5h 自对齐看不出,周窗口暴露)。
      if (Number.isFinite(resetAtMs) && resetAtMs > 0) {
        tracker.windowStart = resetAtMs - tracker.windowMs;
      }
      this.dirty = true;
      return;
    }
    // 4) 同窗口归并:Δ账号 = max(0, 低水位 − fraction);回升 → 0(不重复计数)。
    const delta = Math.max(0, tracker.lastFraction - fraction);
    if (delta > 0) {
      let sumU = 0;
      for (const v of tracker.perCard.values()) sumU += v;
      if (sumU > 0) {
        for (const [card, u] of tracker.perCard) {
          if (u <= 0) continue;
          tracker.attributed.set(card, (tracker.attributed.get(card) || 0) + delta * (u / sumU));
        }
      }
      // 已归并(或无人认领)→ 清段内增量;无人认领的 Δ账号 留作未认领消耗,不进任何 T_i。
      tracker.perCard.clear();
    }
    // 低水位:真跌立即降并清空回升确认;明显回升(超容差)需连续 N 次确认才抬(不靠 resetAt,
    // 上游可能刷额度不动时间);介于两者之间(≈低水位)视为未回升,清确认 → 要求确认必须连续。
    if (fraction < tracker.lastFraction) {
      tracker.lastFraction = fraction;
      tracker.pendingRise = null;
    } else if (fraction > tracker.lastFraction + REBOUND_EPS) {
      const pending = tracker.pendingRise;
      tracker.pendingRise = pending
        ? { fraction: Math.min(pending.fraction, fraction), since: pending.since, count: pending.count + 1 }
        : { fraction, since: now, count: 1 };
      // 持续 ≥REBOUND_CONFIRM_MS(抗高频凑次数)且 ≥2 次读数(抗孤值)才抬,采纳保守(最低)高值。
      if (
        now - tracker.pendingRise.since >= REBOUND_CONFIRM_MS &&
        tracker.pendingRise.count >= REBOUND_MIN_CONFIRMATIONS
      ) {
        tracker.lastFraction = tracker.pendingRise.fraction;
        tracker.pendingRise = null;
      }
    } else {
      tracker.pendingRise = null;
    }
    this.dirty = true;
  }

  /** 窗口 reset:清零 T_i/u_i,重算锁定 D + participants + 预留,设低水位为 fresh。 */
  private resetWindow(accountId: number, tracker: BucketTracker, windowStart: number, freshFraction: number): void {
    tracker.windowStart = windowStart;
    tracker.perCard.clear();
    tracker.attributed.clear();
    tracker.lastFraction = clamp01(freshFraction);
    tracker.primed = true; // reset 出来的基线是真值(账号刚刷新 ≈1 或自计时归 1),非占位。
    tracker.pendingRise = null; // 新窗口重新累计回升确认。
    tracker.locked = this.computeLocked(accountId);
    this.dirty = true;
  }

  /** 自计时过期检测:跨过窗口长度 → reset(离线/无快照路径,fresh=1)。 */
  private ensureWindow(accountId: number, tracker: BucketTracker, now: number): void {
    if (now - tracker.windowStart >= tracker.windowMs) {
      this.resetWindow(accountId, tracker, now, 1.0);
    }
  }

  /** 锁定份额态;reset 时算定,缺失时懒算(重启/首快照兜底,用当前在册绑定近似)。 */
  private ensureLocked(accountId: number, tracker: BucketTracker): LockedShare {
    if (!tracker.locked) tracker.locked = this.computeLocked(accountId);
    return tracker.locked;
  }

  /** 由 Σw + participants 算定锁定态(D=max(N,Σw) 或 forcedD,预留 R0=max(0,1−Σw/D))。 */
  private lockedFrom(accountId: number, sumW: number, participants: Set<string>, forcedD?: number): LockedShare {
    // 独享超卖改造:不再区分 exclusive,统一 D=max(N,Σw)。
    const N = Math.max(1, Math.floor(this.opts.getSeatCapacity?.(accountId) ?? DEFAULT_SEAT_CAPACITY));
    const D = forcedD && forcedD > 0 ? forcedD : Math.max(N, sumW);
    const reserve0 = Math.max(0, 1 - (D > 0 ? sumW / D : 0));
    return { D, participants, reserveAvail: reserve0, grantedReserve: new Map() };
  }

  /** 用当前在册硬绑定计算 D = max(N, Σw)、participants、预留 R0。 */
  private computeLocked(accountId: number, forcedD?: number): LockedShare {
    const bound = this.opts.getBoundCardWeights(accountId) || [];
    let sumW = 0;
    const participants = new Set<string>();
    for (const b of bound) {
      sumW += Math.max(0, Number(b.weight) || 0);
      participants.add(b.cardId);
    }
    return this.lockedFrom(accountId, sumW, participants, forcedD);
  }

  /** 由持久化的 participant 集合重建锁定态(重启恢复:不把窗口内新绑卡误升为 participant)。 */
  private lockedFromParticipants(accountId: number, ids: Set<string>, forcedD?: number): LockedShare {
    let sumW = 0;
    for (const id of ids) sumW += Math.max(0, this.opts.getCardWeight(id));
    return this.lockedFrom(accountId, sumW, new Set(ids), forcedD);
  }

  private getOrCreate(accountId: number, bucket: string): BucketTracker {
    let bucketMap = this.trackers.get(accountId);
    if (!bucketMap) {
      bucketMap = new Map();
      this.trackers.set(accountId, bucketMap);
    }
    let tracker = bucketMap.get(bucket);
    if (!tracker) {
      tracker = {
        windowMs: isWeeklyBucketKey(bucket) ? WEEKLY_WINDOW_MS : WINDOW_MS,
        windowStart: this.nowFn(),
        perCard: new Map(),
        attributed: new Map(),
        lastFraction: 1.0, // 占位:基线由首个有效快照采纳(primed=false,见 applySnapshot 3a)。
        primed: false,
        locked: null,
        pendingRise: null,
      };
      bucketMap.set(bucket, tracker);
    }
    return tracker;
  }

  // ── Persistence (FairShareWindow) ─────────────────────────────────────────

  /** 启动时把持久化的每卡状态读回内存。 */
  async load(): Promise<void> {
    if (!this.prisma || !this.providerId) return;
    let rows: any[];
    try {
      rows = await this.prisma.fairShareWindow.findMany({ where: { provider: this.providerId } });
    } catch (err) {
      console.error("[fair-share-tracker] load failed:", err);
      return;
    }
    const now = this.nowFn();
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.accountId}\u0000${r.bucket}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(r);
    }
    for (const groupRows of groups.values()) {
      const first = groupRows[0];
      const accountId = Number(first.accountId);
      const bucket = String(first.bucket);
      const windowMs = isWeeklyBucketKey(bucket) ? WEEKLY_WINDOW_MS : WINDOW_MS;
      const windowStart = Number(first.windowStart);
      const expired = now - windowStart >= windowMs;
      const storedFraction = Number(first.lastFraction);
      const lf = Number.isFinite(storedFraction) ? clamp01(storedFraction) : 1.0;
      const perCard = new Map<string, number>();
      const attributed = new Map<string, number>();
      const flagged = new Set<string>();
      let storedD = 0;
      if (!expired) {
        // 是否「新格式」行:看 lockedDenominator(>0 即锁定过 D)。不用 attributedShare>0 ——
        // 合法新行也可能 T_i 全 0(那一段无人认领),误判成老行会触发 backfill 把未认领消耗
        // 错栽给某主人。而 lastFraction<1 ⟹ 必已 ensureLocked ⟹ D>0 落库,故此判据对有害场景可靠。
        const hasNewSchema = groupRows.some((r) => Number(r.lockedDenominator) > 0);
        if (hasNewSchema) {
          for (const r of groupRows) {
            const card = String(r.cardId);
            const u = Number(r.weightedUsed) || 0;
            if (u > 0) perCard.set(card, u);
            const t = Number(r.attributedShare) || 0;
            if (t > 0) attributed.set(card, t);
            const d = Number(r.lockedDenominator) || 0;
            if (d > storedD) storedD = d;
            if (r.isParticipant) flagged.add(card);
          }
        } else {
          // QUOTA-REDESIGN §10.2 历史 backfill:用存档 fraction 把旧「本窗口累计用量」按比例
          // 落进累计账 T_i ← (1−lastFraction)×weightedUsed/Σold,再把段内增量从零开始。
          // 偏保守(回填的是「已用」,不会少算),且下个 reset 即清零自愈。
          let sumOld = 0;
          for (const r of groupRows) sumOld += Number(r.weightedUsed) || 0;
          if (sumOld > 0) {
            for (const r of groupRows) {
              const u = Number(r.weightedUsed) || 0;
              if (u <= 0) continue;
              attributed.set(String(r.cardId), clamp01((1 - lf) * (u / sumOld)));
            }
          }
          // perCard 留空(段内增量归零);lockedDenominator 老行没有 → storedD=0 → 下方重算 D。
        }
      }
      let bucketMap = this.trackers.get(accountId);
      if (!bucketMap) this.trackers.set(accountId, (bucketMap = new Map()));
      // 重启恢复:优先用持久化的 participant 集合重建锁定态(防窗口内新绑卡被误升为 participant
      // → 满号超卖撞墙);无 participant 标记的老行回退到「当前在册绑定」近似(下个 reset 自愈)。
      const locked = expired
        ? null
        : flagged.size > 0
          ? this.lockedFromParticipants(accountId, flagged, storedD)
          : this.computeLocked(accountId, storedD);
      bucketMap.set(bucket, {
        windowMs,
        windowStart: expired ? now : windowStart,
        perCard,
        attributed,
        lastFraction: expired ? 1.0 : lf,
        // 恢复出的基线是真值:未过期 → 持久化的低水位;过期 → 真·reset 归 1。均非冷建占位。
        primed: true,
        locked,
      });
    }
  }

  /** 持久化当前内存态(整池替换,dirty 门控)。 */
  async flush(): Promise<void> {
    if (!this.prisma || !this.providerId || !this.dirty) return;
    this.dirty = false;
    const rows = this.serializeRows();
    try {
      await this.prisma.$transaction([
        this.prisma.fairShareWindow.deleteMany({ where: { provider: this.providerId } }),
        ...(rows.length ? [this.prisma.fairShareWindow.createMany({ data: rows })] : []),
      ]);
    } catch (err) {
      console.error("[fair-share-tracker] flush failed:", err);
      this.dirty = true; // retry on next tick
    }
  }

  /** 停止定时 flush。 */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private serializeRows(): Array<{
    provider: string;
    accountId: number;
    bucket: string;
    cardId: string;
    windowStart: bigint;
    weightedUsed: number;
    attributedShare: number;
    lockedDenominator: number;
    lastFraction: number;
    isParticipant: boolean;
  }> {
    const rows: ReturnType<FairShareTracker["serializeRows"]> = [];
    for (const [accountId, bucketMap] of this.trackers) {
      for (const [bucket, tracker] of bucketMap) {
        const D = tracker.locked?.D ?? 0;
        const participants = tracker.locked?.participants ?? new Set<string>();
        // 取 u_i ∪ T_i ∪ participants 的并集卡;participant 即便 idle 也要落库,
        // 否则重启后该卡不在 flagged 集合 → 被当窗口内新卡(满号 e=0 → 误拦)。
        const cards = new Set<string>([...tracker.perCard.keys(), ...tracker.attributed.keys(), ...participants]);
        for (const cardId of cards) {
          const weightedUsed = tracker.perCard.get(cardId) || 0;
          const attributedShare = tracker.attributed.get(cardId) || 0;
          const isParticipant = participants.has(cardId);
          if (weightedUsed <= 0 && attributedShare <= 0 && !isParticipant) continue;
          rows.push({
            provider: this.providerId,
            accountId,
            bucket,
            cardId,
            windowStart: BigInt(Math.trunc(tracker.windowStart)),
            weightedUsed,
            attributedShare,
            lockedDenominator: D,
            lastFraction: tracker.lastFraction,
            isParticipant,
          });
        }
      }
    }
    return rows;
  }

  // ── Test-only introspection ───────────────────────────────────────────────

  /** Snapshot one bucket's tracker state. Test-only. */
  getBucketStateForTesting(accountId: number, bucket: string): {
    windowStart: number;
    lastFraction: number;
    D: number;
    participants: string[];
    reserveAvail: number;
    perCard: Record<string, number>;
    attributed: Record<string, number>;
    totalUsed: number;
    totalAttributed: number;
  } | null {
    const tracker = this.trackers.get(accountId)?.get(bucket);
    if (!tracker) return null;
    const locked = tracker.locked;
    let totalUsed = 0;
    for (const v of tracker.perCard.values()) totalUsed += v;
    let totalAttributed = 0;
    for (const v of tracker.attributed.values()) totalAttributed += v;
    return {
      windowStart: tracker.windowStart,
      lastFraction: tracker.lastFraction,
      D: locked?.D ?? 0,
      participants: locked ? [...locked.participants] : [],
      reserveAvail: locked?.reserveAvail ?? 0,
      perCard: Object.fromEntries(tracker.perCard),
      attributed: Object.fromEntries(tracker.attributed),
      totalUsed,
      totalAttributed,
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
