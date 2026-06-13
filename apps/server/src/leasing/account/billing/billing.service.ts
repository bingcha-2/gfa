/**
 * billing.service.ts — catalog order creation and management.
 *
 * Does NOT talk to epay directly: it builds the payUrl that the client can
 * use. The epay callback is handled in EpayCallbackService.
 */
import * as crypto from "crypto";
import * as QRCode from "qrcode";

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { PlanCatalogService } from "../../plan-catalog/plan-catalog.service";
import { computePurchase, type CatalogConfig, type Selection } from "../../plan-catalog/pricing";
import { RosettaService } from "../../rosetta/rosetta.service";
import { occupiedSharesByAccount, type SubConfig } from "../../subscription/seat";
import { signParams } from "./epay.sign";

const THIRTY_MIN_MS = 30 * 60 * 1000;

function resolveEpayBase(): string {
  return process.env.EPAY_API_BASE ?? "https://pay.example.com";
}

function resolveEpayPid(): string {
  return process.env.EPAY_PID ?? "";
}

function resolveEpayKey(): string {
  return process.env.EPAY_KEY ?? "";
}

function resolveNotifyUrl(): string {
  const pub = process.env.PUBLIC_API_BASE ?? "http://localhost:3001/api";
  return process.env.EPAY_NOTIFY_URL ?? `${pub}/epay/notify`;
}

function resolveReturnUrl(): string {
  const web = process.env.WEB_BASE_URL ?? "http://localhost:3000";
  return process.env.EPAY_RETURN_URL ?? `${web}/account/billing`;
}

/** 支付通道手续费率（%），由用户承担。留空/非法/0 → 不加价（默认）。范围 [0,100)。 */
function resolveFeePercent(): number {
  const raw = process.env.EPAY_FEE_PERCENT;
  if (!raw) return 0;
  const pct = parseFloat(raw);
  return isNaN(pct) || pct < 0 || pct >= 100 ? 0 : pct;
}

/** Collision-resistant trade number: "gfa" + timestamp + 12 random hex chars. */
export function generateOutTradeNo(): string {
  const ts = Date.now().toString();
  const rand = crypto.randomBytes(6).toString("hex");
  return `gfa${ts}${rand}`;
}

/** Parse a subscription's config JSON into an object (empty on malformed). */
function parseConfig(json: string | null): Record<string, any> {
  try {
    const parsed = JSON.parse(String(json || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Human-ish epay order name for a catalog selection (shown on the pay page). */
function orderName(selection: Selection): string {
  const products =
    selection.line === "bind"
      ? selection.items.map((i) => i.product)
      : selection.products;
  const line = selection.line === "bind" ? "绑定" : "号池";
  return `GFA ${line}套餐 ${products.join("+") || "套餐"}`;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planCatalog: PlanCatalogService,
    private readonly rosetta: RosettaService,
  ) {}

  /**
   * Catalog-driven order (spec §8): price a `selection` against the PUBLISHED
   * catalog via computePurchase, then persist a PlanOrder snapshotting the
   * selection + generated config + catalogVersion. On activation the epay
   * callback writes that config into the Subscription. computePurchase throws on
   * an invalid selection (unknown tier/level) — we let it propagate so no order
   * is created.
   */
  async createCatalogOrder(
    customerId: string,
    selection: Selection,
    channel: "ALIPAY" | "WXPAY",
  ) {
    const published = await this.planCatalog.getPublished();
    if (!published) throw new BadRequestException("No published plan catalog — purchasing is unavailable");

    // computePurchase throws on an invalid selection (unknown tier/level/product) —
    // that's a client error, surface it as 400 (never create an order).
    let priceCents: number;
    let config: Record<string, unknown>;
    try {
      ({ priceCents, config } = computePurchase(published.config as CatalogConfig, selection));
    } catch (err: any) {
      throw new BadRequestException(`Invalid selection: ${err?.message || err}`);
    }

    // 座位预检(spec §10):绑定线下单前确认每个 product+level 有可用座位,无 → 拒绝下单
    // (避免用户付钱拿不到号)。号池线不预检(运行时动态调度,无座位概念)。
    await this.assertBindSeatsAvailable(config);

    const referrerId = await this.resolveReferrerId(customerId);

    return this.buildPaymentAndPersist({
      customerId,
      referrerId,
      baseCents: priceCents,
      name: orderName(selection),
      channel,
      orderData: {
        catalogVersion: published.version,
        selection: JSON.stringify(selection),
        config: JSON.stringify(config),
      },
    });
  }

  /**
   * 管理员手动授予(目录版):不走支付,按目录 selection 算 config + 绑定线座位预检,落一条
   * ¥0、status=PAID、payChannel=GRANT 的订单(保留订单→订阅审计链 + activatedFromOrderId FK)。
   * 激活由调用方走与付费单同一的 SubscriptionService.activateForOrder 入口。返回该订单。
   */
  async createGrantOrder(customerId: string, selection: Selection) {
    const published = await this.planCatalog.getPublished();
    if (!published) throw new BadRequestException("套餐目录未发布,无法授予");

    let config: Record<string, unknown>;
    try {
      ({ config } = computePurchase(published.config as CatalogConfig, selection));
    } catch (err: any) {
      throw new BadRequestException(`Invalid selection: ${err?.message || err}`);
    }

    // 与付费下单同口径:绑定线座位预检(避免授予了拿不到号);号池线不预检。
    await this.assertBindSeatsAvailable(config);
    // resolveReferrerId 顺带校验客户存在(不存在 → NotFound)。
    const referrerId = await this.resolveReferrerId(customerId);

    const now = new Date();
    return this.prisma.planOrder.create({
      data: {
        customerId,
        amountCents: 0,
        payChannel: "GRANT",
        outTradeNo: generateOutTradeNo(),
        status: "PAID",
        paidAt: now,
        expiresAt: now, // 已 PAID,pending TTL 无意义
        referrerId,
        catalogVersion: published.version,
        selection: JSON.stringify(selection),
        config: JSON.stringify(config),
      } as any,
    });
  }

  /**
   * 下单前座位预检(spec §10):仅对绑定线 config,逐 product 确认该等级还有可用座位
   * (任一上游号剩 ≥ 本单 weight 份),无 → 抛 BadRequest 拒绝下单。占用份额从 DB ACTIVE
   * 订阅的 config 按 weight 汇总(单一真相源,不读 access-keys.json 文件,避免停写文件后
   * 从文件数会超卖的陷阱)。一次查全部 ACTIVE 订阅,逐 product 复算占用。号池线无座位概念,
   * 直接放行 —— 运行时由 selectAccount 动态调度。
   */
  private async assertBindSeatsAvailable(config: Record<string, unknown>): Promise<void> {
    if (config?.line !== "bind") return; // 号池线不预检

    const products: string[] = Array.isArray(config.products) ? (config.products as string[]) : [];
    if (products.length === 0) return;
    const weight = Math.max(1, Math.floor(Number(config.weight) || 1));
    const levels = (config.levels && typeof config.levels === "object" ? config.levels : {}) as Record<string, string>;

    // 一次读全部 ACTIVE 订阅的 config(座位真相源),逐 product 复算占用份额。
    const rows = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, config: true },
    });
    const configs: Array<SubConfig & { id: string }> = rows.map(
      (r: { id: string; config: string | null }) => ({ id: r.id, ...parseConfig(r.config) }),
    );

    for (const product of products) {
      const level = String(levels[product] || "").trim();
      if (!level) {
        throw new BadRequestException(`绑定线缺少 ${product} 的会员等级,无法下单`);
      }
      const occupied = occupiedSharesByAccount(configs, product);
      if (!this.rosetta.hasAvailableSeatFromShares(product, weight, level, occupied)) {
        throw new BadRequestException(
          `${product}(${level})暂无可用座位(无配额充足且份额足够的号),请稍后重试或联系客服`,
        );
      }
    }
  }

  /** Snapshot referrerId = customer.invitedById at order-create time. */
  private async resolveReferrerId(customerId: string): Promise<string | null> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, invitedById: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found`);
    return customer.invitedById ?? null;
  }

  /**
   * Shared epay flow: apply the user-borne fee, build the signed payUrl + QR,
   * persist the PENDING PlanOrder, return payment info. `orderData` carries the
   * catalog snapshot columns (catalogVersion / selection / config).
   */
  private async buildPaymentAndPersist(args: {
    customerId: string;
    referrerId: string | null;
    baseCents: number;
    name: string;
    channel: "ALIPAY" | "WXPAY";
    orderData: Record<string, unknown>;
  }) {
    const { customerId, referrerId, baseCents, name, channel, orderData } = args;

    const outTradeNo = generateOutTradeNo();
    const expiresAt = new Date(Date.now() + THIRTY_MIN_MS);
    // 手续费由用户承担：基准价上加 EPAY_FEE_PERCENT%（向上取整到分）。
    // amountCents 存「实付毛额」，与 epay 回调上报的 money 天然一致。
    const feeCents = Math.ceil((baseCents * resolveFeePercent()) / 100);
    const amountCents = baseCents + feeCents;
    const money = (amountCents / 100).toFixed(2);
    const type = channel === "ALIPAY" ? "alipay" : "wxpay";

    const pid = resolveEpayPid();
    const epayKey = resolveEpayKey();
    const notifyUrl = resolveNotifyUrl();
    const returnUrl = resolveReturnUrl();
    const apiBase = resolveEpayBase();

    // Build signed params for the payment URL.
    const rawParams: Record<string, string> = {
      pid,
      type,
      out_trade_no: outTradeNo,
      notify_url: notifyUrl,
      return_url: returnUrl,
      name,
      money,
      sign_type: "MD5",
    };
    const sign = signParams(rawParams, epayKey);
    const allParams: Record<string, string> = { ...rawParams, sign_type: "MD5", sign };

    const qs = new URLSearchParams(allParams).toString();
    const payUrl = `${apiBase}/submit.php?${qs}`;
    const qrDataUri = await QRCode.toDataURL(payUrl);

    // Persist the order.
    const order = await this.prisma.planOrder.create({
      data: {
        customerId,
        amountCents,
        payChannel: channel,
        outTradeNo,
        status: "PENDING",
        expiresAt,
        referrerId,
        ...orderData,
      } as any,
    });

    this.logger.log(`Created PlanOrder ${order.id} outTradeNo=${outTradeNo} for customer ${customerId}`);

    return {
      outTradeNo: order.outTradeNo,
      amountCents: order.amountCents,
      baseCents,
      feeCents,
      expiresAt: order.expiresAt.toISOString(),
      payUrl,
      qrDataUri,
    };
  }

  /** Get a single order by outTradeNo, ownership-scoped. */
  async getOrder(customerId: string, outTradeNo: string) {
    const order = await this.prisma.planOrder.findUnique({
      where: { outTradeNo },
    });
    if (!order || order.customerId !== customerId) {
      throw new NotFoundException("Order not found");
    }
    return {
      outTradeNo: order.outTradeNo,
      status: order.status,
      paidAt: order.paidAt?.toISOString() ?? null,
      subscriptionId: order.subscriptionId ?? null,
    };
  }

  /** List orders for a customer with pagination. */
  async listOrders(
    customerId: string,
    page: number,
    pageSize: number,
  ) {
    // Clamp to safe ranges. A negative page would yield a negative skip and a
    // non-positive pageSize would yield a negative take — both make Prisma 500.
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safePageSize = Number.isFinite(pageSize)
      ? Math.min(100, Math.max(1, Math.floor(pageSize)))
      : 20;
    const skip = (safePage - 1) * safePageSize;
    const [orders, total] = await Promise.all([
      this.prisma.planOrder.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        skip,
        take: safePageSize,
      }),
      this.prisma.planOrder.count({ where: { customerId } }),
    ]);

    return {
      orders: orders.map((o) => ({
        outTradeNo: o.outTradeNo,
        planName: null, // catalog orders carry no Plan name; the selection/config is the detail
        amountCents: o.amountCents,
        payChannel: o.payChannel,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        paidAt: o.paidAt?.toISOString() ?? null,
      })),
      total,
    };
  }

  /** List subscriptions for a customer. */
  async listSubscriptions(customerId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    });

    return {
      subscriptions: subs.map((s) => {
        let products: string[] = [];
        try {
          const parsed = JSON.parse(String(s.productEntitlements || "[]"));
          products = Array.isArray(parsed) ? parsed.map((p: unknown) => String(p)) : [];
        } catch {
          products = [];
        }
        return {
          id: s.id,
          planName: null, // configurator has no single plan name; products[] is the detail
          status: s.status,
          products,
          expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
          deviceLimit: s.deviceLimit,
          weight: s.weight,
          migratedFromCard: s.migratedFromKey != null,
        };
      }),
    };
  }
}
