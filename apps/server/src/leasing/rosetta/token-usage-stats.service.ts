import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { beijingDayKey, beijingDayKeysSince, beijingDayStart, beijingHourOfDay } from "../../shared/common/beijing-time";
import { productOfBucket } from "../lease-core/product-bucket";
import { isPermanentDeathReason } from "../token-server/token-billing";

/** 母号在池中的运行状态(来自 LeaseService.getStatus().quota.accounts)。 */
export interface AccountStatusInput {
  found?: boolean;        // 是否仍在账号池里(false = 已删/不在册)
  enabled?: boolean;
  quotaStatus?: string;   // ok / cooling / exhausted / error
  quotaStatusReason?: string;
}
export type AccountHealthTone = "ok" | "amber" | "destructive" | "muted";
export interface AccountHealth { label: string; tone: AccountHealthTone; reason: string }

/**
 * 把母号运行状态压成一个给风险榜显示的小标签 + 配色。优先级:不在池 < 禁用 <
 * Token 失效 / 永久死亡 < 配额异常/用尽/冷却 < 正常。invalid_grant = refresh token
 * 失效(过期/被吊销),单独标「Token失效」。
 */
/** 订阅状态汇总:一个买家在某母号下可能持多张卡(多订阅),状态可能混杂。
 *  优先级 CANCELLED > EXPIRED > ACTIVE > ""(无订阅/文件卡)—— 取最该告警的那个。
 *  目的:抓"订阅已取消却仍在发请求"的买家。 */
export function summarizeSubStatus(statuses: Array<string | undefined>): "ACTIVE" | "EXPIRED" | "CANCELLED" | "" {
  const set = new Set(statuses.filter(Boolean));
  if (set.has("CANCELLED")) return "CANCELLED";
  if (set.has("EXPIRED") && !set.has("ACTIVE")) return "EXPIRED";
  if (set.has("ACTIVE")) return "ACTIVE";
  return "";
}

export function deriveAccountHealth(s: AccountStatusInput): AccountHealth {
  const reason = String(s.quotaStatusReason || "");
  // 不在池(母号已删/不在册):不展示标签(只关心在池母号的真实状态)。
  if (!s.found) return { label: "", tone: "muted", reason };
  if (s.enabled === false) return { label: "已禁用", tone: "muted", reason };
  if (/invalid_grant|revoked|token.*(dead|not found)/i.test(reason)) {
    return { label: "Token失效", tone: "destructive", reason };
  }
  if (isPermanentDeathReason(reason)) return { label: "已死", tone: "destructive", reason };
  const q = String(s.quotaStatus || "ok");
  if (q === "error") return { label: "异常", tone: "amber", reason };
  if (q === "exhausted") return { label: "已用尽", tone: "amber", reason };
  if (q === "cooling") return { label: "冷却中", tone: "amber", reason };
  return { label: "正常", tone: "ok", reason };
}

/** Product a usage row's bucket belongs to. Composite `<product>-<family>` →
 *  product; legacy bare buckets (gemini/opus/codex) map to their old provider. */
function bucketProduct(bucket: string): "antigravity" | "codex" | "anthropic" {
  if (bucket && bucket.includes("-")) {
    const p = productOfBucket(bucket);
    if (p === "codex" || p === "anthropic") return p;
    return "antigravity";
  }
  return bucket === "codex" ? "codex" : "antigravity"; // legacy bare: opus/gemini → antigravity
}

/**
 * CardUsageHourly account-scope WHERE fragment. The hourly table is keyed by the
 * stable accountEmail (no volatile accountId column, no legacy null rows), so
 * scoping a card to one provider-binding is just an accountEmail match when given.
 */
function hourlyAccountScope(opts: { accountEmail?: string }): Record<string, unknown> {
  const email = (opts.accountEmail || "").trim();
  return email ? { accountEmail: email } : {};
}

/** 每个客户(买家)的 RequestLog 派生统计:不同来源 IP + 按分钟分桶(算峰值 req/min)
 *  + 接管面计数(cli / desktop / ide)+ 每分钟 distinct session 集合(算峰值 session/min)。 */
type CustomerLogStat = { sources: Set<string>; minutes: Map<number, number>; cli: number; desktop: number; ide: number; sessionMinutes: Map<number, Set<string>> };
/** RequestLog 派生的每母号统计:不同来源/出口 IP、桌面占比、按分钟分桶(算峰值 req/min)、
 *  每分钟 distinct session(算峰值 session/min),外加该母号下每个客户的同口径明细。 */
type AccountLogStat = { sources: Set<string>; exits: Set<string>; users: Set<string>; cli: number; desktop: number; ide: number; total: number; minutes: Map<number, number>; sessionMinutes: Map<number, Set<string>>; customers: Map<string, CustomerLogStat> };
type RequestLogStats = Map<string, AccountLogStat>;

/** 峰值 req/min:在窗口内某 60s 分桶里的最大请求数。无数据 → 0。 */
function peakReqPerMin(s?: { minutes: Map<number, number> }): number {
  return s && s.minutes.size ? Math.max(...s.minutes.values()) : 0;
}

/** 峰值 session/min:某 60s 分桶里 distinct session-id 的最大数。无数据 → 0。 */
function peakSessionsPerMin(s?: { sessionMinutes: Map<number, Set<string>> }): number {
  if (!s || s.sessionMinutes.size === 0) return 0;
  let max = 0;
  for (const set of s.sessionMinutes.values()) if (set.size > max) max = set.size;
  return max;
}

/** 转发给上游的改写后 user_id:SHA256("gfa-uid-{accountId}") hex,与 Go 端 canonicalUserID 一致。
 *  同一母号恒定 → 上游只看到"一个号 = 一个用户"。accountId<=0(异常)不改写 → 返回 ""。 */
export function canonicalUserId(accountId: number): string {
  if (!accountId || accountId <= 0) return "";
  return createHash("sha256").update("gfa-uid-" + accountId).digest("hex");
}

/** 往"分钟 → distinct session 集合"里记一条。 */
function addSessionToMinute(m: Map<number, Set<string>>, min: number, sessionId: string): void {
  let set = m.get(min);
  if (!set) { set = new Set(); m.set(min, set); }
  set.add(sessionId);
}

/**
 * Query + maintenance side of the per-card token usage log (CardTokenUsage).
 * The write side lives in token-server/token-usage-tracker.ts. Mirrors
 * CreditStatsService: paginated records, day/model aggregation, retention cron.
 */
@Injectable()
export class TokenUsageStatsService {
  private readonly logger = new Logger(TokenUsageStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Aggregated view for one card: by day + by model ─────────────────────

  async getCardUsageSummary(opts: { accessKeyId: string; accountId?: number; accountEmail?: string; days?: number }) {
    const accessKeyId = String(opts.accessKeyId || "").trim();
    const days = Math.max(1, opts.days || 30);
    if (!accessKeyId) {
      return { totals: emptyTotals(), daily: [], byModel: [] };
    }

    const since = beijingDayStart(days);

    // Read the hourly aggregate (rows already carry summed tokens + requests).
    // Scope to one provider-binding via the stable accountEmail when provided.
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { accessKeyId, ...hourlyAccountScope(opts), hourStart: { gte: since } },
      select: {
        modelKey: true,
        bucket: true,
        requests: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        rawTotalTokens: true,
        totalTokens: true,
        hourStart: true,
      },
      orderBy: { hourStart: "asc" },
    });

    const totals = emptyTotals();
    const dailyMap = new Map<string, { totalTokens: number; requests: number }>();
    const modelMap = new Map<
      string,
      { modelKey: string; bucket: string; totalTokens: number; inputTokens: number; outputTokens: number; requests: number }
    >();

    for (const r of rows) {
      totals.requests += r.requests;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cachedInputTokens += r.cachedInputTokens;
      totals.rawTotalTokens += r.rawTotalTokens;
      totals.totalTokens += r.totalTokens;

      const dateKey = beijingDayKey(r.hourStart);
      const d = dailyMap.get(dateKey) || { totalTokens: 0, requests: 0 };
      d.totalTokens += r.totalTokens;
      d.requests += r.requests;
      dailyMap.set(dateKey, d);

      const m = modelMap.get(r.modelKey) || {
        modelKey: r.modelKey,
        bucket: r.bucket,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      };
      m.totalTokens += r.totalTokens;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.requests += r.requests;
      modelMap.set(r.modelKey, m);
    }

    // Fill all Beijing days (including zeros) for a continuous chart.
    const daily = beijingDayKeysSince(days).map((dateKey) => {
      const d = dailyMap.get(dateKey) || { totalTokens: 0, requests: 0 };
      return { date: dateKey, totalTokens: d.totalTokens, requests: d.requests };
    });

    const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

    return { totals, daily, byModel };
  }

  // ── Today's total token consumption (persisted, Beijing day) ────────────

  /**
   * Sum of billable tokens consumed so far today (Beijing calendar day) across
   * all cards, broken down by provider. Persisted + restart-safe — replaces the
   * in-memory daily counter on the usage dashboard. Codex bucket → codex
   * provider; gemini/opus (and anything else) → antigravity.
   */
  async getTodayUsage() {
    const start = beijingDayStart(0);
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { hourStart: { gte: start } },
      select: {
        bucket: true,
        requests: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
        rawTotalTokens: true,
        totalTokens: true,
      },
    });

    // `tokens` 是计费口径(billable,缓存读已 1/10 折);拆分出净输入 / 输出 /
    // 缓存写入(cache_creation,单独列) / 缓存读,让前端能解释"为什么计费 token 比净对话大"。
    // stored inputTokens 是 gross(含缓存读+写),净输入 = gross − 缓存读 − 缓存写。
    const empty = () => ({
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    const totals = empty();
    const byProvider = {
      antigravity: empty(),
      codex: empty(),
      anthropic: empty(),
    };
    for (const r of rows) {
      const cacheWrite = Number(r.cacheCreationTokens) || 0;
      const cacheRead = r.cachedInputTokens;
      // stored inputTokens 是 gross,净输入 = gross − 缓存读 − 缓存写(clamp ≥0)。
      const netInput = Math.max(0, r.inputTokens - cacheRead - cacheWrite);
      for (const t of [totals, byProvider[bucketProduct(r.bucket)]]) {
        t.tokens += r.totalTokens;
        t.requests += r.requests;
        t.inputTokens += netInput;
        t.outputTokens += r.outputTokens;
        t.cacheWriteTokens += cacheWrite;
        t.cacheReadTokens += cacheRead;
      }
    }

    return {
      date: beijingDayKey(new Date()),
      totalTokens: totals.tokens,
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      cacheReadTokens: totals.cacheReadTokens,
      byProvider,
    };
  }

  // ── Global token usage trend (all cards, Beijing days, by provider) ─────

  /**
   * Daily billable-token trend across all cards for the last N Beijing days,
   * split by provider (codex bucket → codex; gemini/opus/other → antigravity).
   * Powers the 用量剩余 dashboard's 7/30-day chart. Persisted + restart-safe.
   */
  async getUsageTrend(opts: { days?: number }) {
    const days = Math.max(1, Math.min(90, opts.days || 7));
    const since = beijingDayStart(days);

    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { hourStart: { gte: since } },
      select: { bucket: true, totalTokens: true, requests: true, hourStart: true },
    });

    const map = new Map<
      string,
      { antigravity: number; codex: number; anthropic: number; totalTokens: number; requests: number }
    >();
    for (const r of rows) {
      const key = beijingDayKey(r.hourStart);
      const d = map.get(key) || { antigravity: 0, codex: 0, anthropic: 0, totalTokens: 0, requests: 0 };
      d.totalTokens += r.totalTokens;
      d.requests += r.requests;
      d[bucketProduct(r.bucket)] += r.totalTokens;
      map.set(key, d);
    }

    const daily = beijingDayKeysSince(days).map((date) => {
      const d = map.get(date) || { antigravity: 0, codex: 0, anthropic: 0, totalTokens: 0, requests: 0 };
      return { date, ...d };
    });

    const totals = daily.reduce(
      (a, d) => ({ totalTokens: a.totalTokens + d.totalTokens, requests: a.requests + d.requests }),
      { totalTokens: 0, requests: 0 },
    );

    return { days, daily, totals };
  }

  // ── Per-card call frequency by Beijing hour-of-day ──────────────────────

  /**
   * How often a card is called across the 24 Beijing hours of the day, over the
   * last N days. Powers a per-card "调用频率" mini-histogram on the dashboard.
   * Always returns 24 buckets (zero-filled) so the chart axis is stable.
   */
  async getHourlyFrequency(opts: { accessKeyId: string; accountId?: number; accountEmail?: string; days?: number }) {
    const accessKeyId = String(opts.accessKeyId || "").trim();
    if (!accessKeyId) return { days: 0, byHour: [], totalRequests: 0 };

    const days = Math.max(1, Math.min(90, opts.days || 7));
    const since = beijingDayStart(days);

    // Scope to one provider-binding (see getCardUsageSummary).
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { accessKeyId, ...hourlyAccountScope(opts), hourStart: { gte: since } },
      select: { requests: true, totalTokens: true, hourStart: true },
    });

    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, totalTokens: 0 }));
    let totalRequests = 0;
    for (const r of rows) {
      const h = beijingHourOfDay(r.hourStart);
      byHour[h].requests += r.requests;
      byHour[h].totalTokens += r.totalTokens;
      totalRequests += r.requests;
    }

    return { days, byHour, totalRequests };
  }

  // ── 母号封号分析:按母号(account)聚合用量/反代/扇出 ────────────────────

  // RequestLog 是逐请求热表(保留 5 天,行数上限 300 万)。把整窗口全捞进内存会 OOM /
  // 阻塞事件循环 → 拖停服务。这里硬封顶扫描行数,并按 at 倒序只取最近 N 条:低量时即全量
  // (精确),高量时退化为"最近 N 条请求"的近似(峰值/IP/用户仍足够指示),且绝不爆内存。
  static readonly REQUEST_LOG_SCAN_CAP = 200_000;

  /**
   * 一次扫描 RequestLog(封顶 REQUEST_LOG_SCAN_CAP 行),按 母号(provider+email)聚合:
   * 不同来源/出口 IP、桌面占比、按分钟分桶(算峰值 req/min)+ 每客户同口径。
   * 风险榜 / 事件流 / 对比共用,避免多次全表扫描。
   */
  private async requestLogStatsByAccount(since: Date): Promise<RequestLogStats> {
    const cap = TokenUsageStatsService.REQUEST_LOG_SCAN_CAP;
    const logs = await this.prisma.requestLog.findMany({
      where: { at: { gte: since }, provider: { in: ["codex", "anthropic"] } },
      select: { provider: true, accountEmail: true, accessKeyId: true, customerId: true, surface: true, sourceIp: true, exitIp: true, userId: true, sessionId: true, at: true },
      orderBy: { at: "desc" }, // 命中上限时保留最近的行(走 @@index([at]) 倒序,无需 filesort)
      take: cap,
    });
    if (logs.length >= cap) {
      this.logger.warn(`requestLogStatsByAccount hit scan cap (${cap}); 峰值/IP/用户 仅按最近 ${cap} 条请求计算`);
    }
    const m: RequestLogStats = new Map();
    for (const r of logs) {
      const key = `${r.provider} ${r.accountEmail}`;
      let s = m.get(key);
      if (!s) { s = { sources: new Set(), exits: new Set(), users: new Set(), cli: 0, desktop: 0, ide: 0, total: 0, minutes: new Map(), sessionMinutes: new Map(), customers: new Map() }; m.set(key, s); }
      const min = Math.floor(new Date(r.at).getTime() / 60000);
      if (r.sourceIp) s.sources.add(r.sourceIp);
      if (r.exitIp) s.exits.add(r.exitIp);
      if (r.userId) s.users.add(r.userId);
      if (r.surface === "desktop") s.desktop += 1;
      else if (r.surface === "cli") s.cli += 1;
      else if (r.surface === "ide") s.ide += 1;
      s.total += 1;
      s.minutes.set(min, (s.minutes.get(min) || 0) + 1);
      if (r.sessionId) addSessionToMinute(s.sessionMinutes, min, r.sessionId);
      // 同一次扫描里顺手按客户聚合(点开母号看哪个买家在突发/多来源 IP)。custKey 与上面一致。
      const custKey = r.customerId || r.accessKeyId;
      if (custKey) {
        let c = s.customers.get(custKey);
        if (!c) { c = { sources: new Set(), minutes: new Map(), cli: 0, desktop: 0, ide: 0, sessionMinutes: new Map() }; s.customers.set(custKey, c); }
        if (r.sourceIp) c.sources.add(r.sourceIp);
        c.minutes.set(min, (c.minutes.get(min) || 0) + 1);
        if (r.surface === "desktop") c.desktop += 1;
        else if (r.surface === "cli") c.cli += 1;
        else if (r.surface === "ide") c.ide += 1;
        if (r.sessionId) addSessionToMinute(c.sessionMinutes, min, r.sessionId);
      }
    }
    return m;
  }

  /**
   * Per-母号 risk dashboard (codex + anthropic), aggregated from CardUsageHourly
   * over the last N days — the data the 封号分析 console page reads.
   *
   * For each account it surfaces the signals that distinguish "a human subscriber"
   * from "a resold/reverse-proxied API":
   *   - requests / failedRequests / failRate   —— 量与错误率
   *   - reverseProxyHits / reverseProxyRate     —— 非真客户端占比(反代)
   *   - distinctCards                            —— 共享扇出(几张卡在用这个母号)
   *   - totalTokens                              —— 饱和度
   * Plus a per-customer breakdown so you can see WHICH buyer shares/drives this account.
   * Keyed by (product, accountEmail); sorted by reverseProxyHits desc.
   */
  async getAccountBanAnalysis(opts: { days?: number; logStats?: RequestLogStats } = {}) {
    const days = Math.max(1, Math.min(30, opts.days || 7));
    const since = beijingDayStart(days);
    const logStats = opts.logStats ?? (await this.requestLogStatsByAccount(since));

    const rows = await this.prisma.cardUsageHourly.findMany({
      where: {
        hourStart: { gte: since },
        OR: [{ bucket: { startsWith: "anthropic" } }, { bucket: { startsWith: "codex" } }],
      },
      select: {
        accountEmail: true, accessKeyId: true, customerId: true, bucket: true,
        requests: true, failedRequests: true, reverseProxyHits: true, totalTokens: true,
      },
    });

    type CustomerAgg = { customerId: string; requests: number; reverseProxyHits: number; cardIds: Set<string> };
    type Acct = {
      product: string; accountEmail: string; requests: number; failedRequests: number;
      reverseProxyHits: number; totalTokens: number; cardIds: Set<string>; customers: Map<string, CustomerAgg>;
    };
    const byAccount = new Map<string, Acct>();
    for (const r of rows) {
      const product = bucketProduct(r.bucket);
      if (product !== "codex" && product !== "anthropic") continue; // 只看 codex/claude
      const email = r.accountEmail; if (!r.accountEmail) continue;
      const key = `${product} ${email}`;
      let a = byAccount.get(key);
      if (!a) {
        a = { product, accountEmail: email, requests: 0, failedRequests: 0, reverseProxyHits: 0, totalTokens: 0, cardIds: new Set(), customers: new Map() };
        byAccount.set(key, a);
      }
      a.requests += r.requests;
      a.failedRequests += r.failedRequests;
      a.reverseProxyHits += r.reverseProxyHits;
      a.totalTokens += r.totalTokens;
      a.cardIds.add(r.accessKeyId);
      const custKey = r.customerId || r.accessKeyId;
      let cu = a.customers.get(custKey);
      if (!cu) { cu = { customerId: custKey, requests: 0, reverseProxyHits: 0, cardIds: new Set() }; a.customers.set(custKey, cu); }
      cu.requests += r.requests;
      cu.reverseProxyHits += r.reverseProxyHits;
      cu.cardIds.add(r.accessKeyId);
    }

    // 订阅状态:订阅卡的 accessKeyId 就是 Subscription.id(影子记录 id = 订阅 id)。
    // 据此把每张卡映射到 ACTIVE/EXPIRED/CANCELLED —— 标出"订阅已取消却还在发请求"的泄漏/盗用。
    // 文件卡(card_ 前缀,无订阅)不在表里 → 无状态。整个 getBanAnalysis 已缓存,此查询开销摊薄。
    const allCardIds = [...new Set([...byAccount.values()].flatMap((a) => [...a.cardIds]))];
    const subStatusById = await this.subscriptionStatusByCardId(allCardIds);

    // 客户 id → 邮箱(展示用,代替不可读的 cuid)。文件卡的 custKey 是 accessKeyId,不在 Customer 表 → 无邮箱。
    const allCustKeys = [...new Set([...byAccount.values()].flatMap((a) => [...a.customers.keys()]))];
    const emailByCustomerId = await this.customerEmailById(allCustKeys);

    const ratio = (hit: number, total: number) => (total > 0 ? hit / total : 0);
    const accounts = [...byAccount.values()]
      .map((a) => {
        const logStat = logStats.get(`${a.product} ${a.accountEmail}`);
        // 下钻:每个客户(买家)一行,带其请求/反代/持卡数,以及从 RequestLog 派生的峰值/来源IP。
        const customers = [...a.customers.values()]
          .map((cu) => {
            const cl = logStat?.customers.get(cu.customerId);
            return {
              customerId: cu.customerId,
              customerEmail: emailByCustomerId.get(cu.customerId) ?? "",
              requests: cu.requests,
              reverseProxyHits: cu.reverseProxyHits,
              reverseProxyRate: ratio(cu.reverseProxyHits, cu.requests),
              distinctCards: cu.cardIds.size,
              peakReqPerMin: peakReqPerMin(cl),
              peakSessionsPerMin: peakSessionsPerMin(cl),
              distinctSourceIps: cl?.sources.size ?? 0,
              // 接管面计数(来自 RequestLog;老客户端不报 surface 时全 0)。
              cliReqs: cl?.cli ?? 0,
              desktopReqs: cl?.desktop ?? 0,
              ideReqs: cl?.ide ?? 0,
              subStatus: summarizeSubStatus([...cu.cardIds].map((id) => subStatusById.get(id))),
            };
          })
          .sort((x, y) => y.reverseProxyHits - x.reverseProxyHits || y.requests - x.requests);
        return {
        product: a.product,
        accountEmail: a.accountEmail,
        requests: a.requests,
        failedRequests: a.failedRequests,
        failRate: ratio(a.failedRequests, a.requests),
        reverseProxyHits: a.reverseProxyHits,
        reverseProxyRate: ratio(a.reverseProxyHits, a.requests),
        distinctCards: a.cardIds.size,
        distinctCustomers: a.customers.size,
        totalTokens: a.totalTokens,
        // 峰值 req/min + 峰值 session/min + 不同来源 IP + 真实用户数 —— 判"不像一个人"。
        peakReqPerMin: peakReqPerMin(logStat),
        peakSessionsPerMin: peakSessionsPerMin(logStat),
        distinctSourceIps: logStat?.sources.size ?? 0,
        distinctUsers: logStat?.users.size ?? 0,
        customers,
        };
      })
      .sort((x, y) => y.reverseProxyHits - x.reverseProxyHits || y.requests - x.requests);

    return { days, accounts };
  }

  /** 客户 id → 邮箱(展示用)。文件卡的 custKey 不是 customerId → 不在表里,Map 不含其键。 */
  private async customerEmailById(customerIds: string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    if (customerIds.length === 0 || typeof this.prisma?.customer?.findMany !== "function") return m;
    try {
      const rows = await this.prisma.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, email: true },
      });
      for (const c of rows) if (c.email) m.set(c.id, String(c.email));
    } catch (err) {
      this.logger.error(`customerEmailById failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return m;
  }

  /** 订阅卡 accessKeyId(=Subscription.id)→ 状态。文件卡不在表里,返回的 Map 不含其键。 */
  private async subscriptionStatusByCardId(cardIds: string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    if (cardIds.length === 0 || typeof this.prisma?.subscription?.findMany !== "function") return m;
    try {
      const subs = await this.prisma.subscription.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, status: true },
      });
      for (const s of subs) m.set(s.id, String(s.status || ""));
    } catch (err) {
      this.logger.error(`subscriptionStatusByCardId failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return m;
  }

  /**
   * 封号事件流(codex + anthropic):每次母号被永久封禁一行,最近 N 天、倒序。
   * 列表只带"封号前请求条数"(requestCount),时间线明细按需经 getBanEventRequests 拉。
   */
  async getBanEvents(opts: { days?: number; limit?: number } = {}) {
    const days = Math.max(1, Math.min(30, opts.days || 7));
    const limit = Math.max(1, Math.min(500, opts.limit || 200));
    const since = beijingDayStart(days);

    const rows = await this.prisma.accountBanEvent.findMany({
      where: { createdAt: { gte: since }, provider: { in: ["codex", "anthropic"] } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { requests: { select: { at: true } } }, // 封号前时间线的时间戳 → 算封号前峰值 req/min
    });
    const events = rows.map((e: any) => {
      // 封号前峰值 req/min:把这次封号 dump 的请求按分钟分桶取最大 —— 断气前的突发强度。
      const minutes = new Map<number, number>();
      for (const r of e.requests as { at: Date }[]) {
        const min = Math.floor(new Date(r.at).getTime() / 60000);
        minutes.set(min, (minutes.get(min) || 0) + 1);
      }
      const peakReqPerMin = minutes.size ? Math.max(...minutes.values()) : 0;
      return {
        id: e.id,
        createdAt: e.createdAt,
        provider: e.provider,
        accountId: e.accountId,
        accountEmail: e.accountEmail,
        reason: e.reason,
        upstreamStatus: e.upstreamStatus,
        upstreamBody: e.upstreamBody,
        modelKey: e.modelKey,
        deathStrikes: e.deathStrikes,
        requestCount: (e.requests as unknown[]).length,
        peakReqPerMin,
      };
    });
    return { days, events };
  }

  /**
   * 单条封号事件下钻:封号前请求时间线(BanEventRequest)+ 该母号【封号前 3 天】的聚合
   * (从 RequestLog 取 [封号时刻-72h, 封号时刻]):请求数、反代率、不同来源 IP / 设备数
   * (≈ 多少端/会话在用)、峰值 req/min、token 量。供页面"封之前 3 天计算"。
   */
  async getBanEventRequests(banEventId: string) {
    const id = String(banEventId || "").trim();
    if (!id) return { banEventId: id, requests: [], window3d: null };

    const event = await this.prisma.accountBanEvent.findUnique({
      where: { id },
      select: { provider: true, accountEmail: true, createdAt: true },
    });
    const requests = await this.prisma.banEventRequest.findMany({
      where: { banEventId: id },
      orderBy: { seq: "asc" },
    });
    if (!event) return { banEventId: id, requests, window3d: null };

    const banAt = new Date(event.createdAt);
    const since = new Date(banAt.getTime() - 72 * 60 * 60 * 1000);
    const logs = await this.prisma.requestLog.findMany({
      where: { provider: event.provider, accountEmail: event.accountEmail, at: { gte: since, lte: banAt } },
      select: { reverseProxy: true, sourceIp: true, deviceId: true, userId: true, totalTokens: true, at: true },
    });
    const ips = new Set<string>();
    const devices = new Set<string>();
    const users = new Set<string>();
    const minutes = new Map<number, number>();
    let reverseProxyHits = 0;
    let totalTokens = 0;
    for (const r of logs) {
      if (r.reverseProxy) reverseProxyHits += 1;
      totalTokens += r.totalTokens;
      if (r.sourceIp) ips.add(r.sourceIp);
      if (r.deviceId) devices.add(r.deviceId);
      if (r.userId) users.add(r.userId);
      const m = Math.floor(new Date(r.at).getTime() / 60000);
      minutes.set(m, (minutes.get(m) || 0) + 1);
    }
    const window3d = {
      requests: logs.length,
      reverseProxyHits,
      reverseProxyRate: logs.length ? reverseProxyHits / logs.length : 0,
      distinctSourceIps: ips.size,
      distinctDevices: devices.size,
      distinctUsers: users.size,
      peakReqPerMin: minutes.size ? Math.max(...minutes.values()) : 0,
      totalTokens,
    };
    return { banEventId: id, requests, window3d };
  }

  /**
   * per-request 热表浏览(近 ≤72h):按 母号/卡/surface/是否反代 过滤,倒序。
   * 行来自 RequestLog(短保留),含来源 IP / 出口 IP / surface / 过滤后的请求头。
   */
  async getRequestLogs(opts: {
    accountEmail?: string; accessKeyId?: string; surface?: string;
    reverseProxyOnly?: boolean; hours?: number; limit?: number;
  } = {}) {
    const hours = Math.max(1, Math.min(120, opts.hours || 120)); // ≤5 天(对齐 RequestLog 保留期)
    const limit = Math.max(1, Math.min(500, opts.limit || 200));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const where: any = { at: { gte: since }, provider: { in: ["codex", "anthropic"] } };
    if (opts.accountEmail) where.accountEmail = opts.accountEmail.trim();
    if (opts.accessKeyId) where.accessKeyId = opts.accessKeyId.trim();
    if (opts.surface) where.surface = opts.surface.trim();
    if (opts.reverseProxyOnly) where.reverseProxy = true;

    const logs = await this.prisma.requestLog.findMany({ where, orderBy: { at: "desc" }, take: limit });
    // 富集客户邮箱:逐请求展示买家邮箱而非不可读的 customerId(行数 ≤500,id 集合小)。
    // 并附改写后 user_id(canonicalUserId),与 userId(原始)对照看"上游看到的 vs 真实的"。
    const emailById = await this.customerEmailById([...new Set(logs.map((l: any) => String(l.customerId || "")).filter(Boolean))]);
    const enriched = logs.map((l: any) => ({
      ...l,
      customerEmail: emailById.get(l.customerId) ?? "",
      canonicalUserId: canonicalUserId(Number(l.accountId || 0)),
    }));
    return { hours, logs: enriched };
  }

  /**
   * 定因对比:把母号分成「已封/曾封」vs「健康」两组,在每个信号上算两组均值 + 差异倍数,
   * 按差异降序 —— 置顶的就是封号主因候选。这才是"抽象分析",而非罗列。
   *
   * 信号来源:风险面(反代率/扇出/失败率/量,来自 CardUsageHourly)+ RequestLog 派生
   * (不同来源 IP / 出口 IP 数、桌面端占比、峰值 req/min<按分钟分桶取最大>)。
   * 已封集合来自 AccountBanEvent(provider+email)。
   */
  async getBanComparison(opts: {
    days?: number;
    accounts?: Awaited<ReturnType<TokenUsageStatsService["getAccountBanAnalysis"]>>["accounts"];
    logStats?: RequestLogStats;
  } = {}) {
    const days = Math.max(1, Math.min(30, opts.days || 7));
    const since = beijingDayStart(days);
    const byAcct = opts.logStats ?? (await this.requestLogStatsByAccount(since));
    const accounts = opts.accounts ?? (await this.getAccountBanAnalysis({ days, logStats: byAcct })).accounts;

    const banRows = await this.prisma.accountBanEvent.findMany({
      where: { createdAt: { gte: since }, provider: { in: ["codex", "anthropic"] } },
      select: { provider: true, accountEmail: true },
    });
    const bannedSet = new Set(banRows.map((b: any) => `${b.provider} ${b.accountEmail}`));

    const rows = accounts.map((a) => {
      const l = byAcct.get(`${a.product} ${a.accountEmail}`);
      return {
        banned: bannedSet.has(`${a.product} ${a.accountEmail}`),
        // 有没有 RequestLog 遥测(上报了的客户端才有)。RequestLog 类指标只在这些母号里求均值,
        // 否则被一堆"老客户端没上报 → 0"的母号稀释(用户/IP/峰值/session/桌面占比全偏低)。
        hasLog: l ? l.total > 0 : false,
        reverseProxyRate: a.reverseProxyRate,
        distinctCards: a.distinctCards,
        distinctCustomers: a.distinctCustomers,
        failRate: a.failRate,
        totalTokens: a.totalTokens,
        requests: a.requests,
        distinctSourceIps: l ? l.sources.size : 0,
        distinctExitIps: l ? l.exits.size : 0,
        distinctUsers: l ? l.users.size : 0,
        // 分母只取"已上报 surface 的请求"(cli+desktop+ide),否则被老客户端的空 surface 稀释。
        desktopRatio: (() => { const surfaced = l ? l.cli + l.desktop + l.ide : 0; return surfaced ? (l!.desktop / surfaced) : 0; })(),
        peakReqPerMin: peakReqPerMin(l),
        peakSessionsPerMin: peakSessionsPerMin(l),
      };
    });
    const banned = rows.filter((r) => r.banned);
    const healthy = rows.filter((r) => !r.banned);
    const avg = (arr: typeof rows, sel: (r: (typeof rows)[number]) => number) =>
      arr.length ? arr.reduce((s, x) => s + sel(x), 0) / arr.length : 0;

    // log:true = 该指标来自 RequestLog(客户端上报),均值只在"有上报的母号"里求,避免被 0 稀释。
    // 其余来自 CardUsageHourly,所有母号都有,正常全量求均值。
    const defs: { key: string; label: string; pct?: boolean; log?: boolean; sel: (r: (typeof rows)[number]) => number }[] = [
      { key: "reverseProxyRate", label: "反代率", pct: true, sel: (r) => r.reverseProxyRate },
      { key: "distinctUsers", label: "真实用户数", log: true, sel: (r) => r.distinctUsers },
      { key: "peakReqPerMin", label: "峰值 req/min", log: true, sel: (r) => r.peakReqPerMin },
      { key: "peakSessionsPerMin", label: "峰值 session/min", log: true, sel: (r) => r.peakSessionsPerMin },
      { key: "distinctSourceIps", label: "不同来源 IP 数", log: true, sel: (r) => r.distinctSourceIps },
      { key: "distinctCards", label: "扇出卡数", sel: (r) => r.distinctCards },
      { key: "distinctCustomers", label: "扇出客户数", sel: (r) => r.distinctCustomers },
      { key: "distinctExitIps", label: "出口 IP 数(应=1)", log: true, sel: (r) => r.distinctExitIps },
      { key: "desktopRatio", label: "桌面端占比(已报接管面中)", pct: true, log: true, sel: (r) => r.desktopRatio },
      { key: "failRate", label: "失败率", pct: true, sel: (r) => r.failRate },
      { key: "totalTokens", label: "Token 量", sel: (r) => r.totalTokens },
      { key: "requests", label: "请求数", sel: (r) => r.requests },
    ];
    const metrics = defs
      .map((d) => {
        // RequestLog 类指标只在"有上报的母号"里求均值。
        const b = d.log ? banned.filter((r) => r.hasLog) : banned;
        const h = d.log ? healthy.filter((r) => r.hasLog) : healthy;
        const bannedAvg = avg(b, d.sel);
        const healthyAvg = avg(h, d.sel);
        // 差异倍数(已封/健康)。健康为 0 时:已封>0 给一个大值(999)标"突出",否则 1。
        const ratio = healthyAvg > 0 ? bannedAvg / healthyAvg : bannedAvg > 0 ? 999 : 1;
        return { key: d.key, label: d.label, pct: Boolean(d.pct), bannedAvg, healthyAvg, ratio };
      })
      .sort((x, y) => y.ratio - x.ratio);

    return { days, bannedCount: banned.length, healthyCount: healthy.length, metrics };
  }

  // 看板缓存:getBanAnalysis 的重活是全量扫 RequestLog(逐请求,几万行)。这是取证看板,
  // 不需要实时 → 按 days 缓存结果 ~90s,冷算一次后秒回。母号运行状态(启用/Token失效)是
  // 内存里的,留在控制器每次实时 join,所以"重的缓存、状态仍新鲜"。
  static readonly BAN_ANALYSIS_TTL_MS = 90_000;
  private readonly banAnalysisCache = new Map<number, { at: number; data: Awaited<ReturnType<TokenUsageStatsService["computeBanAnalysis"]>> }>();

  /** 封号分析页一次取齐:定因对比 + 母号风险榜 + 封号事件流(带 TTL 缓存)。 */
  async getBanAnalysis(opts: { days?: number } = {}): Promise<Awaited<ReturnType<TokenUsageStatsService["computeBanAnalysis"]>>> {
    const days = Math.max(1, Math.min(30, opts.days || 7));
    const cached = this.banAnalysisCache.get(days);
    const now = this.nowMs();
    if (cached && now - cached.at < TokenUsageStatsService.BAN_ANALYSIS_TTL_MS) return cached.data;
    const data = await this.computeBanAnalysis(days);
    this.banAnalysisCache.set(days, { at: now, data });
    return data;
  }

  /** 注入点:测试可覆盖时钟。默认用真实时间。 */
  protected nowMs(): number {
    return Date.now();
  }

  /** RequestLog 只扫一次,三处共用。 */
  private async computeBanAnalysis(days: number) {
    const logStats = await this.requestLogStatsByAccount(beijingDayStart(days));
    const [risk, events] = await Promise.all([
      this.getAccountBanAnalysis({ days, logStats }),
      this.getBanEvents({ days }),
    ]);
    const comparison = await this.getBanComparison({ days: risk.days, accounts: risk.accounts, logStats });
    return { days: risk.days, comparison, accounts: risk.accounts, banEvents: events.events };
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /** Hourly aggregate retention — covers the 30-day dashboards + refund "used since
   *  paid" checks (subscriptions ≤30d) with buffer. Tiny (rows track cards×hours). */
  static readonly HOURLY_RETENTION_DAYS = 60;

  @Cron("25 3 * * *") // 3:25 AM daily — prune hourly aggregate
  async cleanupHourly() {
    const cutoff = beijingDayStart(TokenUsageStatsService.HOURLY_RETENTION_DAYS);
    try {
      const deleted = await this.prisma.cardUsageHourly.deleteMany({
        where: { hourStart: { lt: cutoff } },
      });
      if (deleted.count > 0) {
        this.logger.log(`Pruned ${deleted.count} hourly usage rows older than ${TokenUsageStatsService.HOURLY_RETENTION_DAYS} days`);
      }
    } catch (err) {
      this.logger.error(
        `Hourly usage cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    rawTotalTokens: 0,
    totalTokens: 0,
  };
}
