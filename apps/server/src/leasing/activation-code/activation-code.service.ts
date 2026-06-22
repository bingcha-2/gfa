/**
 * activation-code.service.ts — 激活码生命周期。
 *
 * 激活码是「码 + selection 模板」:生成时不绑账号、不占座位、永久有效到激活。用户在 web account
 * 后台兑换时,按 selection 对「当前 PUBLISHED 目录」computePurchase 现算价/配置,造一笔
 * payChannel=ACTIVATION_CODE 的订单(记真实价格),再走与付费/授予同一的 activateForOrder 入口
 * 开通一条**独立**订阅(forceNew,不与已有订阅续期叠加)。座位在激活那一刻才分配。
 *
 * 座位不足 / 目录非法:createActivationCodeOrder 在建订单前抛 BadRequest → 激活码回滚为 UNUSED、
 * 可重试,绝不留半成品。并发:认领走 CAS(updateMany where status=UNUSED),只有一个赢家。
 */
import * as crypto from "crypto";

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { BillingService } from "../account/billing/billing.service";
import { SubscriptionService } from "../subscription/subscription.service";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";
import { computePurchase, type CatalogConfig, type Selection } from "../plan-catalog/pricing";

export interface GenerateInput {
  selection: Selection;
  count: number;
  name?: string;
  batchId?: string;
  createdById?: string;
}

export interface ActivationCodeSubscriptionSummary {
  id: string;
  expiresAt: string | null;
  products: string[];
  deviceLimit: number;
}

export interface ActivateResult {
  ok: true;
  alreadyActivated?: boolean;
  subscription: ActivationCodeSubscriptionSummary;
}

/** 用户可读的激活码:AC-XXXX-XXXX-XXXX,字符集去掉易混的 0/O/1/I/L。 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newActivationCode(): string {
  const groups = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join(""),
  );
  return `AC-${groups.join("-")}`;
}

@Injectable()
export class ActivationCodeService {
  private readonly logger = new Logger(ActivationCodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionService,
    private readonly planCatalog: PlanCatalogService,
  ) {}

  /**
   * 批量生成激活码。只对当前 PUBLISHED 目录校验 selection 形态(computePurchase 会对未知
   * tier/level/product 抛错),通过后 createMany 生成 N 条 UNUSED 码。不读账号池、不占座位 ——
   * 永远不会因「座位不足」生不出码。同一次生成共享一个 batchId(便于筛选/导出/整批停用)。
   */
  async generate(input: GenerateInput): Promise<{ count: number; batchId: string; codes: string[] }> {
    const count = Math.max(1, Math.min(200, Math.floor(Number(input.count) || 0)));

    const published = await this.planCatalog.getPublished();
    if (!published) throw new BadRequestException("套餐目录未发布,无法生成激活码");
    try {
      computePurchase(published.config as CatalogConfig, input.selection);
    } catch (err: any) {
      throw new BadRequestException(`无效的套餐选择:${err?.message || err}`);
    }

    const batchId = input.batchId?.trim() || `batch_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const selection = JSON.stringify(input.selection);
    const codes = Array.from({ length: count }, () => newActivationCode());
    const data = codes.map((code) => ({
      code,
      selection,
      name: input.name?.trim() || null,
      batchId,
      createdById: input.createdById ?? null,
    }));

    await this.prisma.activationCode.createMany({ data });
    return { count, batchId, codes };
  }

  /**
   * 用户兑换激活码 → 开通订阅。返回开通的订阅摘要。
   *  - 不存在 → NotFound;已停用 → BadRequest;已被他人激活 → Conflict;本人已激活 → 幂等返回。
   *  - UNUSED:CAS 认领为 ACTIVATED(防并发重复激活)→ 造 ACTIVATION_CODE 订单 → forceNew 激活
   *    订阅 → 回填 subscriptionId + 审计回链。中途失败(座位不足/目录非法/激活异常)→ 回滚为
   *    UNUSED 并清理孤儿订单,激活码可重试。
   */
  async activate(customerId: string, rawCode: string): Promise<ActivateResult> {
    const code = String(rawCode || "").trim();
    if (!code) throw new BadRequestException({ error: "CODE_REQUIRED", message: "请输入激活码" });

    const row = await this.prisma.activationCode.findUnique({ where: { code } });
    if (!row) throw new NotFoundException({ error: "CODE_NOT_FOUND", message: "激活码不存在" });

    if (row.status === "DISABLED") {
      throw new BadRequestException({ error: "CODE_DISABLED", message: "激活码已停用" });
    }
    if (row.status === "ACTIVATED") {
      return this.alreadyActivatedResult(customerId, row);
    }

    // CAS 认领:只有把 UNUSED 翻成 ACTIVATED 的那个调用继续往下;并发输家 count===0 → 重判状态。
    const claim = await this.prisma.activationCode.updateMany({
      where: { id: row.id, status: "UNUSED" },
      data: { status: "ACTIVATED", activatedAt: new Date(), activatedByCustomerId: customerId },
    });
    if (claim.count === 0) {
      const fresh = await this.prisma.activationCode.findUnique({ where: { id: row.id } });
      if (fresh?.status === "ACTIVATED") return this.alreadyActivatedResult(customerId, fresh);
      throw new ConflictException({ error: "CODE_UNAVAILABLE", message: "激活码状态已变化,请重试" });
    }

    const selection = JSON.parse(row.selection) as Selection;
    let order: Awaited<ReturnType<BillingService["createActivationCodeOrder"]>> | undefined;
    let sub: any;
    try {
      // 造激活码订单(computePurchase 现算价 + 绑定线座位预检;无座位/目录非法 → 抛 BadRequest)。
      order = await this.billing.createActivationCodeOrder(customerId, selection);
      // forceNew 激活:每张码 = 一条独立订阅,不与已有订阅续期叠加。
      sub = await this.subscriptions.activateForOrder(order, { forceNew: true });
    } catch (err: any) {
      // 回滚:把「已认领但未回填 subscriptionId」的码还原成 UNUSED(可重试);清理可能产生的孤儿订单。
      await this.prisma.activationCode.updateMany({
        where: { id: row.id, status: "ACTIVATED", subscriptionId: null },
        data: { status: "UNUSED", activatedAt: null, activatedByCustomerId: null },
      });
      if (order && !sub) await this.cancelOrphanOrder(order.id);
      throw err;
    }

    await this.prisma.activationCode.update({
      where: { id: row.id },
      data: { subscriptionId: sub.id },
    });
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { activatedFromActivationCodeId: row.id },
    });

    this.logger.log(`activation-code ${row.id} activated by customer ${customerId} → subscription ${sub.id}`);
    return { ok: true, subscription: this.summarize(sub) };
  }

  /**
   * 后台列表:按 status / batchId / 码模糊搜索过滤,分页(createdAt desc),并解析激活客户邮箱。
   * 不返回敏感字段;selection 原样回传(前端按需展示)。
   */
  async list(opts: {
    status?: "UNUSED" | "ACTIVATED" | "DISABLED";
    batchId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: any[]; total: number }> {
    const page = Number.isFinite(opts.page) ? Math.max(1, Math.floor(opts.page!)) : 1;
    const pageSize = Number.isFinite(opts.pageSize) ? Math.min(200, Math.max(1, Math.floor(opts.pageSize!))) : 20;

    const where: Record<string, any> = {};
    if (opts.status) where.status = opts.status;
    if (opts.batchId?.trim()) where.batchId = opts.batchId.trim();
    if (opts.search?.trim()) where.code = { contains: opts.search.trim() };

    const [rows, total] = await Promise.all([
      this.prisma.activationCode.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activationCode.count({ where }),
    ]);

    // 一次解析本页激活客户的邮箱(activatedByCustomerId → email)。
    const customerIds = [...new Set(rows.map((r) => r.activatedByCustomerId).filter((id): id is string => !!id))];
    const emailById = new Map<string, string | null>();
    if (customerIds.length > 0) {
      const customers = await this.prisma.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, email: true },
      });
      for (const c of customers) emailById.set(c.id, c.email ?? null);
    }

    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        selection: r.selection,
        name: r.name,
        batchId: r.batchId,
        activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
        activatedByCustomerId: r.activatedByCustomerId,
        activatedByEmail: r.activatedByCustomerId ? emailById.get(r.activatedByCustomerId) ?? null : null,
        subscriptionId: r.subscriptionId,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 停用一张激活码(仅 UNUSED → DISABLED,CAS)。已激活的码不可停用(停用码不应吊销已开通的订阅);
   * 已是 DISABLED → 幂等。不存在 → NotFound。
   */
  async disable(id: string): Promise<{ ok: true; status: "DISABLED" }> {
    const cas = await this.prisma.activationCode.updateMany({
      where: { id, status: "UNUSED" },
      data: { status: "DISABLED" },
    });
    if (cas.count > 0) return { ok: true, status: "DISABLED" };

    const row = await this.prisma.activationCode.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ error: "CODE_NOT_FOUND", message: "激活码不存在" });
    if (row.status === "DISABLED") return { ok: true, status: "DISABLED" };
    throw new ConflictException({ error: "CODE_NOT_DISABLABLE", message: "已激活的激活码不可停用" });
  }

  /** 已激活的码:本人 → 幂等返回其订阅;他人 → Conflict。 */
  private async alreadyActivatedResult(customerId: string, row: any): Promise<ActivateResult> {
    if (row.activatedByCustomerId !== customerId) {
      throw new ConflictException({ error: "CODE_ALREADY_USED", message: "激活码已被使用" });
    }
    const sub = row.subscriptionId
      ? await this.prisma.subscription.findUnique({ where: { id: row.subscriptionId } })
      : null;
    if (!sub) {
      // 已标 ACTIVATED 但订阅丢失(异常态):当作不可用,提示联系客服而非默默放过。
      throw new ConflictException({ error: "CODE_ALREADY_USED", message: "激活码已被使用" });
    }
    return { ok: true, alreadyActivated: true, subscription: this.summarize(sub) };
  }

  /** 激活中途失败时,把已建的 PAID 激活码订单标记 CANCELLED(尽力而为,不抛)。 */
  private async cancelOrphanOrder(orderId: string): Promise<void> {
    try {
      await this.prisma.planOrder.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    } catch (err: any) {
      this.logger.warn(`activation-code: failed to cancel orphan order ${orderId}: ${err?.message || err}`);
    }
  }

  private summarize(sub: any): ActivationCodeSubscriptionSummary {
    let products: string[] = [];
    try {
      const parsed = JSON.parse(String(sub.productEntitlements || "[]"));
      products = Array.isArray(parsed) ? parsed.map((p: unknown) => String(p)) : [];
    } catch {
      products = [];
    }
    return {
      id: sub.id,
      expiresAt: sub.expiresAt ? new Date(sub.expiresAt).toISOString() : null,
      products,
      deviceLimit: Number(sub.deviceLimit ?? 1),
    };
  }
}
