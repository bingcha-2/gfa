import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { requireApiValue, apiPriceRegistryAt, hasApiPrice, type ApiPricingMode } from "@gfa/shared";
import { createHash, randomBytes } from "node:crypto";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { decryptKey, encryptKey } from "./key-vault";
import { GatewayPoolService } from "./gateway-pool.service";
import { upstreamWindows, quotaRange, personalWindow, type Period } from "./quota-windows";
import { rowToConfig } from "../subscription/subscription-config";


const STATE_TTL_MS = 60_000;
const SETTING_SHARE_USD = "gateway_share_usd";
const SETTING_DEFAULT_USER_SHARES = "gateway_default_user_shares";
const SETTING_DEFAULT_TOTAL_SHARES = "gateway_default_total_shares";

export type UsageTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/** 转发使用的网关额度缓存；订阅资格独立实时校验。 */
export type UserState = {
  id: string;
  customerId: string;
  motherId: string;
  shares: number;
  enabled: boolean;
  usedUsd: number;
  periodStartedAt: number;
  loadedAt: number;
  inflight: number;
};

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** 使用请求发生时的统一价格快照折算；不代表上游实付账单。 */
export function costUsd(model: string, t: UsageTokens, occurredAt = Date.now(), pricingMode: ApiPricingMode = "standard"): number {
  return requireApiValue({
    provider: "anthropic",
    modelId: model,
    pricingMode,
    inputTokens: t.input,
    cachedInputTokens: t.cacheRead,
    cacheWrite5mTokens: t.cacheWrite5m,
    cacheWrite1hTokens: t.cacheWrite1h,
    outputTokens: t.output,
    contextTokens: t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h,
    occurredAt,
  }).usd;
}

@Injectable()
export class GatewayUserService implements OnModuleInit {
  private readonly cache = new Map<string, UserState>(); // keyHash → state
  private settings: { at: number; shareUsd: number; defaultUserShares: number; defaultTotalShares: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pool: GatewayPoolService,
  ) {}

  onModuleInit() {
    // 上游窗口重置:库里已清零,这里丢掉内存状态,下次请求重新加载。
    this.pool.onUsersReset(() => this.cache.clear());
  }

  // ── 配置(后台可改) ─────────────────────────────────────────────
  async getPoolSettings() {
    if (this.settings && Date.now() - this.settings.at < STATE_TTL_MS) return this.settings;
    const rows = await this.prisma.siteSetting.findMany({
      where: { key: { in: [SETTING_SHARE_USD, SETTING_DEFAULT_USER_SHARES, SETTING_DEFAULT_TOTAL_SHARES] } },
    });
    const m = new Map<string, string>(rows.map((r: any) => [r.key, r.value]));
    const num = (k: string, d: number) => {
      const n = Number(m.get(k));
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    this.settings = {
      at: Date.now(),
      shareUsd: num(SETTING_SHARE_USD, 165),
      defaultUserShares: Math.floor(num(SETTING_DEFAULT_USER_SHARES, 1)),
      defaultTotalShares: Math.floor(num(SETTING_DEFAULT_TOTAL_SHARES, 6)),
    };
    return this.settings;
  }

  async savePoolSettings(input: { shareUsd?: number; defaultUserShares?: number; defaultTotalShares?: number }) {
    const put = async (key: string, v: unknown, min: number, integer: boolean) => {
      if (v === undefined) return;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
        throw new BadRequestException(`${key} 不合法`);
      }
      await this.prisma.siteSetting.upsert({ where: { key }, update: { value: String(n) }, create: { key, value: String(n) } });
    };
    await put(SETTING_SHARE_USD, input.shareUsd, 0.01, false);
    await put(SETTING_DEFAULT_USER_SHARES, input.defaultUserShares, 1, true);
    await put(SETTING_DEFAULT_TOTAL_SHARES, input.defaultTotalShares, 1, true);
    this.settings = null;
    return this.getPoolSettings();
  }

  limitUsd(shares: number, shareUsd: number) {
    return Math.round(shares * shareUsd * 1e6) / 1e6;
  }

  /** 用户自己的网关账单；不返回母号身份、密钥或其他用户用量。 */
  async summary(customerId: string) {
    const [row, subscriptions] = await Promise.all([
      this.prisma.gatewayUser.findUnique({ where: { customerId }, include: { motherAccount: true } }),
      this.activeClaudeSubscriptions(customerId),
    ]);
    const subscriptionValid = subscriptions.length > 0;
    if (!row) return { configured: false, subscriptionValid };
    row.motherAccount = await this.pool.quotaSnapshot(row.motherAccountId) ?? row.motherAccount;
    const quota = await this.quotaStatus({ id: row.id, customerId, motherId: row.motherAccountId, shares: row.shares }, row, subscriptions);
    const models = await this.prisma.gatewayUsage.groupBy({
      by: ["model"], where: { gatewayUserId: row.id },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWrite5m: true, cacheWrite1h: true, costUsd: true },
      _count: { _all: true },
    });
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - 29);
    const recent = await this.prisma.gatewayUsage.findMany({
      where: { gatewayUserId: row.id, createdAt: { gte: since } },
      select: { createdAt: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWrite5m: true, cacheWrite1h: true, costUsd: true },
    });
    const daily = new Map<string, { date: string; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; requests: number; costUsd: number }>();
    for (let day = 0; day < 30; day++) {
      const date = new Date(since.getTime() + day * 86400000).toISOString().slice(0, 10);
      daily.set(date, { date, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, requests: 0, costUsd: 0 });
    }
    for (const usage of recent) {
      const bucket = daily.get(usage.createdAt.toISOString().slice(0, 10));
      if (!bucket) continue;
      bucket.inputTokens += usage.inputTokens; bucket.outputTokens += usage.outputTokens;
      bucket.cachedTokens += usage.cacheReadTokens; bucket.cacheWriteTokens += usage.cacheWrite5m + usage.cacheWrite1h;
      bucket.requests++; bucket.costUsd += usage.costUsd;
    }
    return { configured: true, subscriptionValid, enabled: row.enabled,
      upstreamEnabled: row.motherAccount.enabled && row.motherAccount.status === "ready",
      limitUsd: quota.limitUsd, usedUsd: quota.usedUsd, remainingUsd: quota.remainingUsd,
      totalUsedUsd: row.totalUsedUsd, totalRequests: row.totalRequests,
      periodStartedAt: row.periodStartedAt, windows: quota.windows, dailyHistory: [...daily.values()].reverse(),
      models: models.map(m => ({ model: m.model, requests: m._count._all, ...m._sum })) };
  }

  // ── 后台管理 ─────────────────────────────────────────────────────
  async listUsers() {
    const { shareUsd } = await this.getPoolSettings();
    const rows = await this.prisma.gatewayUser.findMany({
      orderBy: { createdAt: "asc" },
      include: { motherAccount: { select: { id: true, accountName: true } } },
    });
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: rows.map((r: any) => r.customerId) } },
      select: { id: true, email: true },
    });
    const email = new Map<string, string>(customers.map((c: any) => [c.id, c.email]));
    return Promise.all(rows.map(async (r: any) => {
      const subscriptionValid = await this.hasActiveSubscription(r.customerId);
      const limit = this.limitUsd(r.shares, shareUsd);
      return {
        id: r.id,
        email: email.get(r.customerId) ?? "",
        subscriptionValid,
        motherAccountId: r.motherAccountId,
        motherAccountName: r.motherAccount?.accountName,
        shares: r.shares,
        limitUsd: limit,
        usedUsd: r.usedUsd,
        remainingUsd: Math.max(0, limit - r.usedUsd),
        totalUsedUsd: r.totalUsedUsd,
        totalRequests: r.totalRequests,
        lastUsedAt: r.lastUsedAt,
        periodStartedAt: r.periodStartedAt,
        enabled: r.enabled,
        keyHint: r.keyHint,
      };
    }));
  }

  async allocationEligibility(email: string) {
    const customer = await this.prisma.customer.findUnique({ where: { email: String(email || "").trim().toLowerCase() } });
    if (!customer) return { eligible: false, message: "找不到该邮箱对应的用户" };
    const eligible = await this.hasActiveSubscription(customer.id);
    return { eligible, message: eligible ? "Claude 订阅有效" : "必须有有效的 Claude 订阅才能分配母号" };
  }

  /** 按邮箱给用户分配份额并生成专用 key。同一用户只占一个母号。 */
  async assign(email: string, shares?: number, motherAccountId?: string) {
    return this.prisma.$transaction(async (db) => {
      const customer = await db.customer.findUnique({ where: { email: String(email || "").trim().toLowerCase() } });
      if (!customer) throw new NotFoundException("找不到该邮箱对应的用户");
      if (!(await this.activeClaudeSubscriptions(customer.id, db)).length) {
        throw new ForbiddenException("必须有有效的 Claude 订阅才能分配母号");
      }
      if (await db.gatewayUser.findUnique({ where: { customerId: customer.id } })) {
        throw new BadRequestException("该用户已分配,请直接修改份数");
      }
      const st = await this.getPoolSettings();
      const k = shares === undefined ? st.defaultUserShares : Number(shares);
      if (!Number.isSafeInteger(k) || k < 1) throw new BadRequestException("份数至少为 1");

      const mother = await this.pickMother(motherAccountId, db);
      const plain = `gfa-${randomBytes(24).toString("hex")}`;
      const row = await db.gatewayUser.create({
        data: {
          customerId: customer.id,
          motherAccountId: mother.id,
          shares: k,
          keyHash: hashKey(plain),
          keyCipher: encryptKey(plain),
          keyHint: `****${plain.slice(-4)}`,
        },
    });
    return { id: row.id, motherAccountId: mother.id, motherAccountName: mother.accountName, shares: k };
    });
  }

  private async pickMother(specified?: string, db: any = this.prisma) {
    const mothers = await db.gatewayMotherAccount.findMany({
      where: { enabled: true, status: "ready", ...(specified ? { id: specified } : {}) },
    });
    const sums = await db.gatewayUser.groupBy({ by: ["motherAccountId"], _sum: { shares: true } });
    const used = new Map<string, number>(sums.map((s: any) => [s.motherAccountId, s._sum.shares ?? 0]));
    const free = (m: any) => m.totalShares - (used.get(m.id) ?? 0);
    // Total shares is a reference capacity; prefer the greatest spare capacity,
    // then the least overallocated account when every account is already full.
    const ok = mothers.sort((a: any, b: any) => free(b) - free(a) || String(a.id).localeCompare(String(b.id)));
    if (ok.length === 0) throw new BadRequestException("没有可用母号");
    return ok[0];
  }

  async updateUser(id: string, input: { shares?: number; enabled?: boolean }) {
    await this.prisma.$transaction(async (db) => {
      const row = await db.gatewayUser.findUnique({ where: { id } });
      if (!row) throw new NotFoundException("用户不存在");
      if ((input.enabled === true || (input.shares !== undefined && Number(input.shares) > row.shares)) &&
          !(await this.activeClaudeSubscriptions(row.customerId, db)).length) {
        throw new ForbiddenException("必须有有效的 Claude 订阅才能启用或增加份数");
      }
      const data: Record<string, unknown> = {};
      if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
      if (input.shares !== undefined) {
        const k = Number(input.shares);
        if (!Number.isSafeInteger(k) || k < 1) throw new BadRequestException("份数至少为 1");
        const mother = await db.gatewayMotherAccount.findUnique({ where: { id: row.motherAccountId } });
        if (!mother) throw new BadRequestException("母号不存在");
        if (k > row.shares && (!mother.enabled || mother.status !== "ready")) {
          throw new BadRequestException("母号当前不可用，不能增加份数");
        }
        data.shares = k;
      }
      await db.gatewayUser.update({ where: { id }, data });
      this.cache.delete(row.keyHash);
    });
  }

  async resetUsage(id: string) {
    const row = await this.prisma.gatewayUser.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("用户不存在");
    await this.prisma.gatewayUser.update({ where: { id }, data: { usedUsd: 0, periodStartedAt: new Date(), quotaResetAt: new Date() } });
    this.cache.delete(row.keyHash);
  }

  async removeUser(id: string) {
    const row = await this.prisma.gatewayUser.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("用户不存在");
    await this.prisma.gatewayUser.delete({ where: { id } });
    this.cache.delete(row.keyHash);
  }

  /** 换 key(怀疑泄露时):旧 key 立即失效。新 key 只通过本人的托管接口取得。 */
  async rotateKey(id: string) {
    const row = await this.prisma.gatewayUser.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("用户不存在");
    const plain = `gfa-${randomBytes(24).toString("hex")}`;
    await this.prisma.gatewayUser.update({
      where: { id },
      data: { keyHash: hashKey(plain), keyCipher: encryptKey(plain), keyHint: `****${plain.slice(-4)}` },
    });
    this.cache.delete(row.keyHash);
  }

  // ── 客户端「一键托管」 ───────────────────────────────────────────
  /** 本人激活:返回专用 key、母号 id、模型和额度。托管时顺带刷新该母号的模型列表(10 分钟内不重复请求上游)。 */
  async activate(customerId: string) {
    if (!(await this.hasActiveSubscription(customerId))) {
      throw new ForbiddenException({ code: "SUBSCRIPTION_EXPIRED", message: "需要有效的 Claude 订阅，请续费或购买套餐" });
    }
    const row = await this.prisma.gatewayUser.findUnique({
      where: { customerId },
      include: { motherAccount: { select: { id: true, accountName: true } } },
    });
    if (!row || !row.enabled) throw new NotFoundException("尚未为你开通,请联系管理员");
    const models = (await this.pool.refreshModels(row.motherAccountId)).filter(model => hasApiPrice("anthropic", model));
    const { shareUsd } = await this.getPoolSettings();
    const limit = this.limitUsd(row.shares, shareUsd);
    return {
      key: decryptKey(row.keyCipher),
      motherAccountId: row.motherAccountId,
      shares: row.shares,
      limitUsd: limit,
      usedUsd: row.usedUsd,
      remainingUsd: Math.max(0, limit - row.usedUsd),
      models,
    };
  }

  // ── 转发热路径 ───────────────────────────────────────────────────
  /** Check live subscription state on every request: a cached gateway key must
   * not outlive cancellation, expiry, or a disabled customer. */
  private async activeClaudeSubscriptions(customerId: string, db: any = this.prisma) {
    const customer = await db.customer.findUnique({ where: { id: customerId }, select: { status: true } });
    if (!customer || customer.status !== "ACTIVE") return [];
    const now = new Date();
    const subscriptions = await db.subscription.findMany({
      where: { customerId, status: "ACTIVE", startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: [{ priority: "asc" }, { startsAt: "asc" }, { id: "asc" }],
    });
    return subscriptions.filter((sub: any) => {
      const products = rowToConfig(sub).products;
      return Array.isArray(products) && products.includes("anthropic");
    });
  }
  async hasActiveSubscription(customerId: string): Promise<boolean> {
    return (await this.activeClaudeSubscriptions(customerId)).length > 0;
  }

  async resolve(key: string): Promise<UserState | null> {
    if (!key) return null;
    const h = hashKey(key);
    let s = this.cache.get(h);
    if (s && Date.now() - s.loadedAt < STATE_TTL_MS) return s;
    const row = await this.prisma.gatewayUser.findUnique({ where: { keyHash: h } });
    if (!row) {
      this.cache.delete(h);
      return null;
    }
    const inflight = s?.inflight ?? 0;
    s = Object.assign(s ?? {}, {
      id: row.id,
      customerId: row.customerId,
      motherId: row.motherAccountId,
      shares: row.shares,
      enabled: row.enabled,
      usedUsd: s?.usedUsd !== undefined && s.inflight > 0 ? Math.max(s.usedUsd, row.usedUsd) : row.usedUsd,
      periodStartedAt: row.periodStartedAt.getTime(),
      loadedAt: Date.now(),
      inflight,
    }) as UserState;
    this.cache.set(h, s);
    return s;
  }

  /** Subscription budgets are read live; balances come from the immutable ledger,
   * not a second set of 5h/7d counters. A request keeps the selected subscription. */
  async quotaStatus(state: Pick<UserState, "id" | "customerId" | "motherId" | "shares">, existingRow?: any, active?: any[]) {
    const now = Date.now();
    const row = existingRow ?? await this.prisma.gatewayUser.findUnique({ where: { id: state.id }, include: { motherAccount: true } });
    if (row && !existingRow) row.motherAccount = await this.pool.quotaSnapshot(state.motherId) ?? row.motherAccount;
    const mother = row?.motherAccount;
    const upstream = upstreamWindows(mother, now);
    const subscriptions = active ?? await this.activeClaudeSubscriptions(state.customerId);
    const base = { allowed: false, reason: "subscription_required", subscriptionId: null as string | null,
      windows: upstream, usedUsd: row?.usedUsd ?? 0, limitUsd: 0, remainingUsd: null as number | null, retryAt: null as number | null };
    if (!subscriptions.length) return base;
    if (!row?.enabled || !mother?.enabled || mother.status !== "ready") return { ...base, reason: "service_disabled" };
    const settings = await this.getPoolSettings();
    let first: typeof base | undefined;
    for (let index = 0; index < subscriptions.length; index++) {
      const sub = subscriptions[index];
      const config: any = rowToConfig(sub);
      const configured = config.usdQuotaByProduct?.anthropic;
      const quota = configured ?? { fiveHour: 0, weekly: this.limitUsd(state.shares, settings.shareUsd) };
      const limits = [quota.fiveHour ?? 0, quota.weekly ?? 0];
      if (limits.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        first ??= { ...base, reason: "quota_configuration_invalid" }; continue;
      }
      const personal = new Map<Period, { limit: number; used: number; resetAt: number | null }>();
      let weeklyUsed = 0;
      for (const period of ["5h", "7d"] as Period[]) {
        const limit = period === "5h" ? limits[0] : limits[1];
        if (limit === 0 && period !== "7d") continue;
        const up = upstream.find(w => w.period === period)!;
        const anchored = { ...up, resetAt: up.state === "unlimited" ? null :
          Number(period === "5h" ? mother.upstreamResetAt5h : mother.upstreamResetAt7d) || up.resetAt };
        const startsAt = new Date(sub.startsAt).getTime();
        if (!Number.isFinite(startsAt)) return { ...base, reason: "quota_configuration_invalid" };
        const range = quotaRange(period, anchored, startsAt, now);
        const start = new Date(Math.max(range.start, new Date(row.quotaResetAt || 0).getTime()));
        const time = { gte: start, ...(range.end !== null ? { lt: new Date(range.end) } : {}) };
        const sum = await this.prisma.gatewayUsage.aggregate({
          where: { gatewayUserId: state.id, AND: [
            // Pre-migration records belong only to the first eligible Claude subscription.
            index === 0 ? { OR: [{ subscriptionId: sub.id }, { subscriptionId: null }] } : { subscriptionId: sub.id },
            { OR: [{ occurredAt: time }, { occurredAt: null, createdAt: time }] },
          ] }, _sum: { costUsd: true },
        });
        let used = sum._sum.costUsd ?? 0;
        if (period === "7d") weeklyUsed = used;
        if (limit > 0) personal.set(period, { limit, used, resetAt: range.end });
      }
      const windows = (["5h", "7d"] as Period[]).map(period => personalWindow(period, personal.get(period) ?? null));
      const exhausted = windows.find(w => w.exhausted) ?? upstream.find(w => w.exhausted);
      const uncertain = upstream.some(w => w.uncertain);
      const candidate = { ...base, allowed: !exhausted && !uncertain, subscriptionId: sub.id,
        reason: exhausted ? `quota_${exhausted.period}_exhausted` : uncertain ? "quota_reading_uncertain" : "ok",
        windows, usedUsd: weeklyUsed, limitUsd: limits[1], remainingUsd: limits[1] > 0 ? Math.max(0, limits[1] - weeklyUsed) : null,
        retryAt: exhausted?.resetAt ?? null };
      first ??= candidate;
      if (candidate.allowed) return candidate;
    }
    return first ?? base;
  }

  async hasQuota(s: UserState): Promise<boolean> { return (await this.quotaStatus(s)).allowed; }

  /** 每个请求结束后落库一次(事务):用量明细 + 用户累计。requestId 唯一,崩溃重试不会重复计费。 */
  async recordUsage(s: UserState, p: { requestId: string; model: string; tokens: UsageTokens; status: number; occurredAt?: number; pricingMode?: ApiPricingMode; subscriptionId?: string | null }) {
    const cost = p.status >= 200 && p.status < 300 ? costUsd(p.model, p.tokens, p.occurredAt, p.pricingMode) : 0;
    try {
      await this.prisma.$transaction([
        this.prisma.gatewayUsage.create({
          data: {
            requestId: p.requestId,
            gatewayUserId: s.id,
            motherAccountId: s.motherId,
            model: p.model,
            subscriptionId: p.subscriptionId ?? null,
            occurredAt: new Date(p.occurredAt ?? Date.now()),
            inputTokens: p.tokens.input,
            outputTokens: p.tokens.output,
            cacheReadTokens: p.tokens.cacheRead,
            cacheWrite5m: p.tokens.cacheWrite5m,
            cacheWrite1h: p.tokens.cacheWrite1h,
            costUsd: cost,
            pricingVersion: apiPriceRegistryAt(p.occurredAt ?? Date.now()).version,
            pricingMode: p.pricingMode ?? "standard",
            status: p.status,
          },
        }),
        this.prisma.gatewayUser.update({
          where: { id: s.id },
          data: {
            usedUsd: { increment: cost },
            totalUsedUsd: { increment: cost },
            totalRequests: { increment: 1 },
            lastUsedAt: new Date(),
          },
        }),
      ]);
      s.usedUsd += cost;
    } catch (err: any) {
      if (err?.code === "P2002") return; // 同一 requestId 已记过
      throw err;
    }
  }
}
