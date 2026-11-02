import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { calculateApiValue } from "@gfa/shared";
import { createHash, randomBytes } from "node:crypto";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { decryptKey, encryptKey } from "./key-vault";
import { GatewayPoolService } from "./gateway-pool.service";

const PERIOD_MS = 7 * 24 * 3600_000;
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

/** 转发热路径用的内存状态:鉴权、额度检查都不查库。 */
export type UserState = {
  id: string;
  motherId: string;
  shares: number;
  enabled: boolean;
  usedUsd: number;
  periodStartedAt: number;
  loadedAt: number;
  inflight: number;
};

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Anthropic 官方价(复用 @gfa/shared 的价格表):输入、输出、缓存读写分别计价。 */
export function costUsd(model: string, t: UsageTokens): number {
  return calculateApiValue({
    provider: "anthropic",
    modelId: model,
    pricingMode: "standard",
    inputTokens: t.input,
    cachedInputTokens: t.cacheRead,
    cacheWrite5mTokens: t.cacheWrite5m,
    cacheWrite1hTokens: t.cacheWrite1h,
    outputTokens: t.output,
    contextTokens: t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h,
    occurredAt: Date.now(),
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
    return rows.map((r: any) => {
      const limit = this.limitUsd(r.shares, shareUsd);
      return {
        id: r.id,
        email: email.get(r.customerId) ?? "",
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
    });
  }

  /** 按邮箱给用户分配份额并生成专用 key。同一用户只占一个母号。 */
  async assign(email: string, shares?: number, motherAccountId?: string) {
    const customer = await this.prisma.customer.findUnique({ where: { email: String(email || "").trim().toLowerCase() } });
    if (!customer) throw new NotFoundException("找不到该邮箱对应的用户");
    if (await this.prisma.gatewayUser.findUnique({ where: { customerId: customer.id } })) {
      throw new BadRequestException("该用户已分配,请直接修改份数");
    }
    const st = await this.getPoolSettings();
    const k = shares === undefined ? st.defaultUserShares : Math.floor(Number(shares));
    if (!Number.isFinite(k) || k < 1) throw new BadRequestException("份数至少为 1");

    const mother = await this.pickMother(k, motherAccountId);
    const plain = `gfa-${randomBytes(24).toString("hex")}`;
    const row = await this.prisma.gatewayUser.create({
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
  }

  private async pickMother(need: number, specified?: string) {
    const mothers = await this.prisma.gatewayMotherAccount.findMany({
      where: { enabled: true, status: "ready", ...(specified ? { id: specified } : {}) },
    });
    const sums = await this.prisma.gatewayUser.groupBy({ by: ["motherAccountId"], _sum: { shares: true } });
    const used = new Map<string, number>(sums.map((s: any) => [s.motherAccountId, s._sum.shares ?? 0]));
    const free = (m: any) => m.totalShares - (used.get(m.id) ?? 0);
    const ok = mothers.filter((m: any) => free(m) >= need).sort((a: any, b: any) => free(b) - free(a));
    if (ok.length === 0) throw new BadRequestException("没有剩余份数足够的可用母号");
    return ok[0];
  }

  async updateUser(id: string, input: { shares?: number; enabled?: boolean }) {
    const row = await this.prisma.gatewayUser.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("用户不存在");
    const data: Record<string, unknown> = {};
    if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
    if (input.shares !== undefined) {
      const k = Math.floor(Number(input.shares));
      if (!Number.isFinite(k) || k < 1) throw new BadRequestException("份数至少为 1");
      const mother = await this.prisma.gatewayMotherAccount.findUnique({ where: { id: row.motherAccountId } });
      const others = await this.prisma.gatewayUser.aggregate({
        where: { motherAccountId: row.motherAccountId, NOT: { id } },
        _sum: { shares: true },
      });
      if (!mother || (others._sum.shares ?? 0) + k > mother.totalShares) throw new BadRequestException("该母号剩余份数不足");
      data.shares = k;
    }
    await this.prisma.gatewayUser.update({ where: { id }, data });
    this.cache.delete(row.keyHash);
  }

  async resetUsage(id: string) {
    const row = await this.prisma.gatewayUser.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("用户不存在");
    await this.prisma.gatewayUser.update({ where: { id }, data: { usedUsd: 0, periodStartedAt: new Date() } });
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
    const row = await this.prisma.gatewayUser.findUnique({
      where: { customerId },
      include: { motherAccount: { select: { id: true, accountName: true } } },
    });
    if (!row || !row.enabled) throw new NotFoundException("尚未为你开通,请联系管理员");
    const models = await this.pool.refreshModels(row.motherAccountId);
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
  async resolve(key: string): Promise<UserState | null> {
    if (!key) return null;
    const h = hashKey(key);
    let s = this.cache.get(h);
    if (s && Date.now() - s.loadedAt < STATE_TTL_MS) return this.rolled(s);
    const row = await this.prisma.gatewayUser.findUnique({ where: { keyHash: h } });
    if (!row) {
      this.cache.delete(h);
      return null;
    }
    const inflight = s?.inflight ?? 0;
    s = {
      id: row.id,
      motherId: row.motherAccountId,
      shares: row.shares,
      enabled: row.enabled,
      usedUsd: s?.usedUsd !== undefined && s.inflight > 0 ? Math.max(s.usedUsd, row.usedUsd) : row.usedUsd,
      periodStartedAt: row.periodStartedAt.getTime(),
      loadedAt: Date.now(),
      inflight,
    };
    this.cache.set(h, s);
    return this.rolled(s);
  }

  /** 兜底周期:满 7 天仍未收到上游重置信号,也自动清零。 */
  private rolled(s: UserState): UserState {
    if (Date.now() - s.periodStartedAt >= PERIOD_MS) {
      s.usedUsd = 0;
      s.periodStartedAt = Date.now();
      void this.prisma.gatewayUser
        .update({ where: { id: s.id }, data: { usedUsd: 0, periodStartedAt: new Date(s.periodStartedAt) } })
        .catch(() => undefined);
    }
    return s;
  }

  async hasQuota(s: UserState): Promise<boolean> {
    const { shareUsd } = await this.getPoolSettings();
    return s.usedUsd < this.limitUsd(s.shares, shareUsd);
  }

  /** 每个请求结束后落库一次(事务):用量明细 + 用户累计。requestId 唯一,崩溃重试不会重复计费。 */
  async recordUsage(s: UserState, p: { requestId: string; model: string; tokens: UsageTokens; status: number }) {
    const cost = p.status >= 200 && p.status < 300 ? costUsd(p.model, p.tokens) : 0;
    try {
      await this.prisma.$transaction([
        this.prisma.gatewayUsage.create({
          data: {
            requestId: p.requestId,
            gatewayUserId: s.id,
            motherAccountId: s.motherId,
            model: p.model,
            inputTokens: p.tokens.input,
            outputTokens: p.tokens.output,
            cacheReadTokens: p.tokens.cacheRead,
            cacheWrite5m: p.tokens.cacheWrite5m,
            cacheWrite1h: p.tokens.cacheWrite1h,
            costUsd: cost,
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
