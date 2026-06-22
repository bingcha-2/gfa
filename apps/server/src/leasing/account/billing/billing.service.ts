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
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { PlanCatalogService } from "../../plan-catalog/plan-catalog.service";
import { computePurchase, type CatalogConfig, type Selection } from "../../plan-catalog/pricing";
import { buildFixedEntitlements, salesSeatCapacityFor } from "../../plan-catalog/unified-entitlement";
import { RosettaService } from "../../rosetta/rosetta.service";
import { occupiedSharesByAccount, salesSeatCapacityForProduct, seatWeight, type SubConfig } from "../../subscription/seat";
import { rowToConfig } from "../../subscription/subscription-config";
import { signParams } from "./epay.sign";
import { EpayCallbackService } from "./epay-callback.service";
import { SubscriptionService } from "../../subscription/subscription.service";
import type { PlanOrder } from "@prisma/client";

const THIRTY_MIN_MS = 30 * 60 * 1000;

function selectionDisplayName(json: string | null): string | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json);
    if (!s || typeof s !== "object") return null;
    const line = s.line === "bind" ? "绑定" : "号池";
    const products: string[] = s.line === "bind"
      ? (s.items ?? []).map((i: { product: string }) => i.product)
      : s.products ?? [];
    return products.length > 0 ? `${line} ${products.join("+")}` : `${line}套餐`;
  } catch { return null; }
}

/**
 * 真实支付方式以网关回调/查询的 type 为准(alipay/wxpay/bank…),已随 PAID 一起存进
 * notifyRaw。未支付 / 无 type / 坏 JSON → null。下单时的 payChannel 只是占位:统一收银台
 * 由用户在网关侧自选渠道,故展示「支付方式」应取这里而非 payChannel。
 */
function payTypeFromNotifyRaw(notifyRaw: string | null): string | null {
  if (!notifyRaw) return null;
  try {
    const t = (JSON.parse(notifyRaw) as { type?: unknown })?.type;
    return typeof t === "string" && t.trim() ? t.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function resolveEpayBase(): string {
  return process.env.EPAY_API_BASE ?? "https://pay.example.com";
}

/** zhunfu V2 必填的 10 位秒级时间戳(字符串)。 */
function epayTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function resolveEpayPid(): string {
  return process.env.EPAY_PID ?? "";
}

/** V2 商户私钥(裸 base64,PKCS#8),用于下单 RSA 签名。 */
function resolveMerchantPrivateKey(): string {
  return process.env.EPAY_MERCHANT_PRIVATE_KEY ?? "";
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
    private readonly epayCallback: EpayCallbackService,
    private readonly subscriptions: SubscriptionService,
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
    // 统一收银台:前端不再预选渠道,默认占位 ALIPAY;真实支付方式以回调/查询 type 为准。
    channel: "ALIPAY" | "WXPAY" = "ALIPAY",
    // 余额抵扣额(分):最高可抵到基础价 100%。服务端夹断 [0, min(余额, baseCents)] 并原子扣减。
    useCreditCents?: number,
  ) {
    // 邮箱未验证不允许下单:付款后凭据/找回密码都依赖可达邮箱,先卡住避免「付了钱忘了密码进不去」。
    const buyer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { emailVerified: true },
    });
    if (!buyer) throw new NotFoundException("Customer not found");
    if (!buyer.emailVerified) {
      throw new ForbiddenException({
        error: "EMAIL_NOT_VERIFIED",
        message: "请先验证邮箱后再购买",
      });
    }

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
    config = this.enrichUnifiedBindConfig(published.config as CatalogConfig, config);

    // 座位预检(spec §10):绑定线下单前确认每个 product+level 有可用座位,无 → 拒绝下单
    // (避免用户付钱拿不到号)。号池线不预检(运行时动态调度,无座位概念)。
    await this.assertBindSeatsAvailable(config);

    const referrerId = await this.resolveReferrerId(customerId);

    // 每次选购都是一笔全新订单(不再复用旧单 —— 复用会把改价后的目录现价与旧单锁定的毛额混用,
    // 导致差额被错算成「手续费」)。新建前先作废该客户所有「待支付」旧单:否则同时存在多个有效
    // 二维码会有重复扫码支付的风险。CANCELLED 语义同 EXPIRED —— 若用户仍扫了某张旧码,迟到的
    // 支付回调(handleNotify 的 CAS 接受 CANCELLED→PAID)仍能正常激活,钱不会丢。GRANT 单是
    // PAID 不在 PENDING 范围,不受影响。校验(算价/座位/客户存在)全部通过后才作废,避免误废。
    // 作废旧单时回补其占用的余额 —— 回补在算本单抵扣之前,旧单余额可被新单复用。
    await this.voidPendingOrdersForCustomer(customerId);

    // 余额抵扣:夹断到 [0, min(余额, baseCents)] 并原子扣减(防并发重复花)。
    const creditApplied = await this.applyCredit(customerId, useCreditCents, priceCents);
    const payable = priceCents - creditApplied;
    const orderData = {
      catalogVersion: published.version,
      selection: JSON.stringify(selection),
      config: JSON.stringify(config),
      creditAppliedCents: creditApplied,
    };

    // 全额抵扣:epay 收不了 ¥0 → 落一条 CREDIT 内部已支付单并立即激活(同 GRANT 口径)。
    if (payable === 0) {
      return this.createCreditCoveredOrder({
        customerId,
        referrerId,
        appliedCents: creditApplied,
        orderData,
      });
    }

    // 部分抵扣 / 不抵扣:走 epay,手续费按抵后 payable 计。下单失败要回补已扣余额。
    try {
      return await this.buildPaymentAndPersist({
        customerId,
        referrerId,
        baseCents: payable,
        name: orderName(selection),
        channel,
        orderData,
      });
    } catch (err) {
      if (creditApplied > 0) {
        await this.prisma.customer.update({
          where: { id: customerId },
          data: { creditCents: { increment: creditApplied } },
        });
      }
      throw err;
    }
  }

  /**
   * 夹断并原子扣减余额,返回实际抵扣额(分)。夹断到 [0, min(余额, cap)];cap=基础价(最高抵 100%)。
   * 条件更新 `where creditCents >= applied` 防并发重复花:扣减影响行数 ≠ 1 → 抛冲突。
   */
  private async applyCredit(customerId: string, requested: number | undefined, cap: number): Promise<number> {
    const want = Math.floor(Number(requested) || 0);
    if (want <= 0 || cap <= 0) return 0;
    const { creditCents } = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { creditCents: true },
    });
    const applied = Math.min(want, creditCents, cap);
    if (applied <= 0) return 0;
    const dec = await this.prisma.customer.updateMany({
      where: { id: customerId, creditCents: { gte: applied } },
      data: { creditCents: { decrement: applied } },
    });
    if (dec.count !== 1) {
      throw new ConflictException("余额不足或已被占用,请刷新后重试");
    }
    return applied;
  }

  /** 作废该客户所有 PENDING 单(理由见 createCatalogOrder),并回补各自抵扣的余额(同一更新清零防重复回补)。 */
  private async voidPendingOrdersForCustomer(customerId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const pendings = await tx.planOrder.findMany({
        where: { customerId, status: "PENDING" },
        select: { id: true, creditAppliedCents: true },
      });
      if (pendings.length === 0) return;
      const refund = pendings.reduce((sum, o) => sum + o.creditAppliedCents, 0);
      await tx.planOrder.updateMany({
        where: { customerId, status: "PENDING" },
        data: { status: "CANCELLED", creditAppliedCents: 0 },
      });
      if (refund > 0) {
        await tx.customer.update({
          where: { id: customerId },
          data: { creditCents: { increment: refund } },
        });
      }
      this.logger.log(
        `Superseded ${pendings.length} prior PENDING order(s) for customer ${customerId} (restored ${refund} credit)`,
      );
    });
  }

  /**
   * 把单笔 PENDING 单转终态(EXPIRED/CANCELLED)并回补 creditAppliedCents。CAS 保证只回补一次:
   * status 必须仍是 PENDING 才翻,且同一更新里清零 creditAppliedCents。expiry cron / cancelOrder 复用。
   */
  async voidPendingOrder(orderId: string, toStatus: "EXPIRED" | "CANCELLED"): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.planOrder.findUnique({
        where: { id: orderId },
        select: { customerId: true, status: true, creditAppliedCents: true },
      });
      if (!order || order.status !== "PENDING") return false;
      const cas = await tx.planOrder.updateMany({
        where: { id: orderId, status: "PENDING" },
        data: { status: toStatus, creditAppliedCents: 0 },
      });
      if (cas.count !== 1) return false;
      if (order.creditAppliedCents > 0) {
        await tx.customer.update({
          where: { id: order.customerId },
          data: { creditCents: { increment: order.creditAppliedCents } },
        });
      }
      return true;
    });
  }

  /**
   * 退款连带回收推广人返点:把该订单触发的 ReferralReward(GRANTED)置 REVOKED,并从推广人余额扣回。
   * CAS(status=GRANTED 才翻)保证只回收一次,重复退款幂等。无返点单 → no-op。退款两条路径(toC
   * refundOwnOrder / console billing-admin)都调用,杜绝「下单领返点→退款→返点留下」的套利。
   * 注:推广人若已花掉这笔返点,扣回后余额可能为负 —— 这是诚实的账面真相(applyCredit 对负余额取 0,
   * 即暂不可用,直到重新积累),不在此处兜底为 0。
   */
  async revokeReferralRewardForOrder(orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const reward = await tx.referralReward.findUnique({
        where: { planOrderId: orderId },
        select: { id: true, referrerId: true, amountCents: true, status: true },
      });
      if (!reward || reward.status !== "GRANTED") return;
      const cas = await tx.referralReward.updateMany({
        where: { id: reward.id, status: "GRANTED" },
        data: { status: "REVOKED" },
      });
      if (cas.count !== 1) return;
      await tx.customer.update({
        where: { id: reward.referrerId },
        data: { creditCents: { decrement: reward.amountCents } },
      });
      this.logger.log(
        `[refund] revoked referral reward ${reward.id} for order ${orderId}: referrer=${reward.referrerId} -${reward.amountCents}`,
      );
    });
  }

  /**
   * 全额余额抵扣单:落一条 ¥0、status=PAID、payChannel=CREDIT 的内部单(同 GRANT 口径),立即激活。
   * amountCents=0 → 付款回调返点天然为 0(用余额买的部分不再产生新返点)。激活失败回补余额并作废。
   */
  private async createCreditCoveredOrder(args: {
    customerId: string;
    referrerId: string | null;
    appliedCents: number;
    orderData: Record<string, unknown>;
  }) {
    const { customerId, referrerId, appliedCents, orderData } = args;
    const now = new Date();
    const order = await this.prisma.planOrder.create({
      data: {
        customerId,
        amountCents: 0,
        payChannel: "CREDIT",
        outTradeNo: generateOutTradeNo(),
        status: "PAID",
        paidAt: now,
        expiresAt: now,
        referrerId,
        ...orderData,
      } as any,
    });

    let sub: Awaited<ReturnType<SubscriptionService["activateForOrder"]>>;
    try {
      sub = await this.subscriptions.activateForOrder(order);
    } catch (err) {
      await this.prisma.$transaction([
        this.prisma.customer.update({
          where: { id: customerId },
          data: { creditCents: { increment: appliedCents } },
        }),
        this.prisma.planOrder.update({
          where: { id: order.id },
          data: { status: "CANCELLED", creditAppliedCents: 0 },
        }),
      ]);
      throw err;
    }

    await this.prisma.notification.create({
      data: {
        customerId,
        type: "BILLING",
        title: "套餐已开通",
        body: "您的套餐已成功开通(余额抵扣),感谢您的订购。",
      },
    });
    this.logger.log(`Created CREDIT PlanOrder ${order.id} (fully covered ${appliedCents} cents) for customer ${customerId}`);

    return {
      outTradeNo: order.outTradeNo,
      amountCents: 0,
      baseCents: appliedCents,
      feeCents: 0,
      creditAppliedCents: appliedCents,
      expiresAt: order.expiresAt.toISOString(),
      paid: true as boolean,
      subscriptionId: sub.id as string | null,
      payUrl: undefined as string | undefined,
      qrDataUri: undefined as string | undefined,
    };
  }

  /**
   * 管理员手动授予(目录版):不走支付,落一条 ¥0、status=PAID、payChannel=GRANT 的订单。
   * 激活由调用方走与付费单同一的 SubscriptionService.activateForOrder 入口。返回该订单。
   */
  async createGrantOrder(customerId: string, selection: Selection) {
    return this.createInternalPaidOrder(customerId, selection, { payChannel: "GRANT", charge: false });
  }

  /**
   * 激活码兑换:不走支付,落一条 status=PAID、payChannel=ACTIVATION_CODE 的订单。与 GRANT 同口径
   * (computePurchase 算 config + 绑定线座位预检),唯一区别是 amountCents 记「激活当时目录算出的
   * 真实价格」(对账/营收可见),而非 ¥0。激活由调用方走 activateForOrder(同付费/授予)。返回该订单。
   * 绑定线无座位 → assertBindSeatsAvailable 抛 BadRequest、不建单(调用方据此让激活码保持 UNUSED)。
   */
  async createActivationCodeOrder(customerId: string, selection: Selection) {
    return this.createInternalPaidOrder(customerId, selection, { payChannel: "ACTIVATION_CODE", charge: true });
  }

  /**
   * 内部已支付订单(GRANT / 激活码):按目录 selection 算 config + 绑定线座位预检,落一条
   * status=PAID 的订单(保留订单→订阅审计链 + activatedFromOrderId FK)。charge=true 记真实价格,
   * 否则 ¥0。校验失败(目录未发布 / selection 非法 / 绑定线无座位)抛 BadRequest、不建单。
   */
  private async createInternalPaidOrder(
    customerId: string,
    selection: Selection,
    opts: { payChannel: "GRANT" | "ACTIVATION_CODE"; charge: boolean },
  ) {
    const published = await this.planCatalog.getPublished();
    if (!published) {
      throw new BadRequestException(opts.charge ? "套餐目录未发布,无法激活" : "套餐目录未发布,无法授予");
    }

    let priceCents = 0;
    let config: Record<string, unknown>;
    try {
      ({ priceCents, config } = computePurchase(published.config as CatalogConfig, selection));
    } catch (err: any) {
      throw new BadRequestException(`Invalid selection: ${err?.message || err}`);
    }
    config = this.enrichUnifiedBindConfig(published.config as CatalogConfig, config);

    // 与付费下单同口径:绑定线座位预检(避免授予/激活了拿不到号);号池线不预检。
    await this.assertBindSeatsAvailable(config);
    // resolveReferrerId 顺带校验客户存在(不存在 → NotFound)。
    const referrerId = await this.resolveReferrerId(customerId);

    const now = new Date();
    return this.prisma.planOrder.create({
      data: {
        customerId,
        amountCents: opts.charge ? priceCents : 0,
        payChannel: opts.payChannel,
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

  private enrichUnifiedBindConfig(
    catalog: CatalogConfig,
    config: Record<string, any>,
  ): Record<string, any> {
    if (config.line !== "bind") return config;

    const products = Array.isArray(config.products) ? config.products : [];
    const levels = config.levels || {};
    const shareCapacity = Number(config.shareCapacity || 8);
    const salesSeatCapacity = Object.fromEntries(
      products.map((product: string) => [
        product,
        salesSeatCapacityFor(catalog, product, String(levels[product] || ""), shareCapacity),
      ]),
    );
    const antigravityOnly = products.length === 1 && products[0] === "antigravity";
    const staticEntitlements = antigravityOnly
      ? buildFixedEntitlements(catalog, {
          products,
          shareSeats: Number(config.shareSeats || config.weight || 1),
          shareCapacity,
        })
      : {};

    // Codex/Anthropic bind lines stay pinned and fair-share governed.
    // Antigravity is display-bound only: static token buckets govern
    // customer quota while runtime supply rotates through pro/premium accounts.
    return {
      ...config,
      salesSeatCapacity,
      ...staticEntitlements,
      assignmentPolicy: antigravityOnly ? "display-bound-pool" : "pinned",
    };
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
    const weight = seatWeight(config as SubConfig);
    const levels = (config.levels && typeof config.levels === "object" ? config.levels : {}) as Record<string, string>;

    // 一次读全部 ACTIVE 订阅的 config(座位真相源),逐 product 复算占用份额。
    const rows = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        config: true,
        productEntitlements: true,
        bucketLimits: true,
        bindings: true,
        levels: true,
        weight: true,
        deviceLimit: true,
        weeklyTokenLimit: true,
        windowMs: true,
      },
    });
    const configs: Array<SubConfig & { id: string }> = rows.map(
      (r: any) => ({ id: r.id, ...rowToConfig(r) }),
    );

    for (const product of products) {
      const level = String(levels[product] || "").trim();
      if (!level) {
        throw new BadRequestException(`绑定线缺少 ${product} 的会员等级,无法下单`);
      }
      const occupied = occupiedSharesByAccount(configs, product);
      const salesCapacity = salesSeatCapacityForProduct(config as SubConfig, product, Number(config.shareCapacity || 8));
      if (!this.rosetta.hasAvailableSeatFromShares(product, weight, level, occupied, salesCapacity)) {
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
   * POST 到 zhunfu /api/pay/submit 拿收银台页面 URL,再生成二维码。
   * V2 RSA 必须用 POST(GET 被 zhunfu 拒绝签名校验)。
   */
  private async buildEpayPayUrl(args: {
    outTradeNo: string;
    amountCents: number;
    name: string;
  }): Promise<{ payUrl: string; qrDataUri: string }> {
    const money = (args.amountCents / 100).toFixed(2);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawParams: Record<string, string> = {
      pid: resolveEpayPid(),
      out_trade_no: args.outTradeNo,
      notify_url: resolveNotifyUrl(),
      return_url: resolveReturnUrl(),
      name: args.name,
      money,
      timestamp,
      sign_type: "RSA",
    };
    const privateKey = resolveMerchantPrivateKey();
    if (!privateKey) {
      throw new ServiceUnavailableException("支付未配置：EPAY_MERCHANT_PRIVATE_KEY 为空");
    }
    const sign = signParams(rawParams, privateKey);

    const base = resolveEpayBase();
    const submitUrl = `${base}/api/pay/submit`;
    const postBody = new URLSearchParams({ ...rawParams, sign }).toString();
    this.logger.debug(`epay POST ${submitUrl} body(200): ${postBody.slice(0, 200)}`);
    const resp = await fetch(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postBody,
      redirect: "manual",
    });
    const html = await resp.text();

    // zhunfu 返回 HTTP 200 + JS 跳转: window.location.replace('/pay/...')
    const m = html.match(/location\.replace\(['"]([^'"]+)['"]\)/);
    if (!m) {
      const errMsg = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? html.slice(0, 500);
      this.logger.error(`epay submit 失败: ${errMsg}`);
      throw new ServiceUnavailableException("支付网关未返回收银台地址");
    }
    const payUrl = m[1].startsWith("http") ? m[1] : `${base}${m[1]}`;
    const qrDataUri = await QRCode.toDataURL(payUrl);
    return { payUrl, qrDataUri };
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

    const { payUrl, qrDataUri } = await this.buildEpayPayUrl({ outTradeNo, amountCents, name });

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
      creditAppliedCents: (orderData.creditAppliedCents as number) ?? 0,
      expiresAt: order.expiresAt.toISOString(),
      paid: false as boolean,
      subscriptionId: null as string | null,
      payUrl: payUrl as string | undefined,
      qrDataUri: qrDataUri as string | undefined,
    };
  }

  /** Get a single order by outTradeNo, ownership-scoped. */
  async getOrder(customerId: string, outTradeNo: string) {
    let order = await this.prisma.planOrder.findUnique({
      where: { outTradeNo },
    });
    if (!order || order.customerId !== customerId) {
      throw new NotFoundException("Order not found");
    }

    // PENDING / 本地已过期(EXPIRED:30min TTL cron 翻的)/ 已取消(CANCELLED:用户取消或新建时
    // 被作废)都兜底查一次网关 —— 若网关侧实际已支付,handleNotify 的 CAS 接受
    // PENDING|EXPIRED|CANCELLED→PAID,可恢复「付了钱但本地非 PAID」的单(本地开发 ngrok 回调
    // 不通时尤为重要;生产由 epay 重试 + reconcile cron 再兜底)。
    if (order.status === "PENDING" || order.status === "EXPIRED" || order.status === "CANCELLED") {
      const synced = await this.queryAndSyncEpayOrder(outTradeNo);
      if (synced) {
        order = await this.prisma.planOrder.findUnique({ where: { outTradeNo } }) ?? order;
      }
    }

    return {
      outTradeNo: order.outTradeNo,
      status: order.status,
      paidAt: order.paidAt?.toISOString() ?? null,
      subscriptionId: order.subscriptionId ?? null,
    };
  }

  /**
   * 用户主动取消一笔未支付订单(ownership-scoped)。仅 PENDING 可取消;其他状态视为幂等 no-op,
   * 原样返回当前状态。取消前先查一次网关:若该单实际已支付(用户已扫码),走激活流程而非取消
   * (钱已收,不能丢)。CAS PENDING→CANCELLED 防并发回调争用 —— 若回调抢先翻成 PAID,取消让位。
   * 返回结构与 getOrder 一致,前端可直接复用 BillingOrderState。
   */
  async cancelOrder(customerId: string, outTradeNo: string) {
    let order = await this.prisma.planOrder.findUnique({ where: { outTradeNo } });
    if (!order || order.customerId !== customerId) {
      throw new NotFoundException("Order not found");
    }

    if (order.status === "PENDING") {
      // 取消前兜底查网关:已支付则激活(不取消),避免「用户扫了码又点取消」丢单。
      const synced = await this.queryAndSyncEpayOrder(outTradeNo);
      if (synced) {
        order = await this.prisma.planOrder.findUnique({ where: { outTradeNo } }) ?? order;
      } else {
        // CAS:仅当仍为 PENDING 才取消 —— 并发回调若抢先翻 PAID,让位于支付。同时回补抵扣的余额。
        const voided = await this.voidPendingOrder(order.id, "CANCELLED");
        if (voided) {
          this.logger.log(`Customer ${customerId} cancelled PlanOrder outTradeNo=${outTradeNo}`);
        }
        order = await this.prisma.planOrder.findUnique({ where: { outTradeNo } }) ?? order;
      }
    }

    return {
      outTradeNo: order.outTradeNo,
      status: order.status,
      paidAt: order.paidAt?.toISOString() ?? null,
      subscriptionId: order.subscriptionId ?? null,
    };
  }

  /**
   * 用户自助退款一笔已支付订单(ownership-scoped)。镜像 console 管理员退款,多一道归属校验,
   * 且只退实付的 96.4%(保留 3.6% 渠道费,与支付页 channelFeeNote 提示一致)。
   * 资格:本人 + PAID + 真实付费单(非 GRANT/¥0)+ 支付后无 token 用量。
   * 先调网关退款,确认成功(钱已退)才 CAS PAID→REFUNDED 并取消订阅 —— 钱→状态,绝不反过来。
   */
  async refundOwnOrder(customerId: string, outTradeNo: string) {
    const order = await this.prisma.planOrder.findUnique({ where: { outTradeNo } });
    if (!order || order.customerId !== customerId) {
      throw new NotFoundException("Order not found");
    }
    if (order.status === "REFUNDED") {
      return { ok: true, alreadyRefunded: true, refundedCents: 0 };
    }
    if (order.status !== "PAID") {
      throw new ConflictException(`只有已支付订单可退款（当前状态 ${order.status}）`);
    }
    if (order.payChannel === "GRANT" || order.amountCents <= 0) {
      throw new ConflictException("该订单无可退款金额");
    }

    // 使用检测:订单支付后产生过 token 用量 → 不允许退款(防「买了用完再退」)。
    // 查小时聚合表(CardUsageHourly,保留 ~60 天,覆盖任意订阅期);原始流水只留 2 天、
    // 不能用来判老订单。下界按 paidAt 所在整点向下取整(保守:含该小时全部用量 → 宁可拦)。
    const since = order.paidAt ?? order.createdAt;
    const hourFloor = new Date(Math.floor(since.getTime() / 3_600_000) * 3_600_000);
    const usageCount = await this.prisma.cardUsageHourly.count({
      where: { customerId: order.customerId, hourStart: { gte: hourFloor } },
    });
    if (usageCount > 0) {
      throw new ConflictException("订单支付后已产生使用记录,不可退款");
    }

    // 只退 96.4%:3.6% 渠道费由用户承担(与支付页提示一致)。
    const refundCents = Math.round(order.amountCents * 0.964);
    const refund = await this.refundEpayOrder(order.outTradeNo, refundCents);
    if (!refund.ok) {
      throw new ServiceUnavailableException(`退款失败,订单状态未变更:${refund.msg ?? "未知错误"}`);
    }

    // CAS PAID→REFUNDED:并发退款收敛为一个赢家,输家重读返回幂等结果。
    const cas = await this.prisma.planOrder.updateMany({
      where: { id: order.id, status: "PAID" },
      data: { status: "REFUNDED" },
    });
    if (cas.count !== 1) {
      const again = await this.prisma.planOrder.findUnique({ where: { id: order.id } });
      if (again?.status === "REFUNDED") {
        return { ok: true, alreadyRefunded: true, refundedCents: 0 };
      }
      throw new ConflictException(`订单状态已变化,退款未执行（当前状态 ${again?.status ?? "UNKNOWN"}）`);
    }

    await this.cancelRefundedSubscription(order);
    // 退款连带回补本单抵扣的余额(现金只退 96.4%,但余额是站内额度,全额还回)。
    // 仅 CAS 赢家(cas.count===1)到这,故不会重复回补。
    if (order.creditAppliedCents > 0) {
      await this.prisma.customer.update({
        where: { id: order.customerId },
        data: { creditCents: { increment: order.creditAppliedCents } },
      });
    }
    // 回收该单触发的推广人返点(防套利)。
    await this.revokeReferralRewardForOrder(order.id);
    this.logger.log(`Customer ${customerId} refunded PlanOrder outTradeNo=${outTradeNo} (${refundCents} cents, restored ${order.creditAppliedCents} credit)`);
    return { ok: true, alreadyRefunded: false, refundedCents: refundCents };
  }

  /** 退款连带取消该订单激活的订阅(已取消则 no-op)。与 console 管理员退款同等逻辑。 */
  private async cancelRefundedSubscription(order: PlanOrder): Promise<string | null> {
    const sub = order.subscriptionId
      ? await this.prisma.subscription.findUnique({ where: { id: order.subscriptionId } })
      : await this.prisma.subscription.findFirst({ where: { activatedFromOrderId: order.id } });
    if (!sub || sub.status === "CANCELLED") return null;
    await this.subscriptions.cancelSubscription(sub.id);
    return sub.id;
  }

  /**
   * 主动查询 zhunfu 订单状态:POST /api/pay/query,若已支付(status=1)则走回调激活流程。
   * 用于本地开发(ngrok 回调不通)及生产容错(回调丢失/延迟时前端轮询兜底)。
   * 返回 true 表示订单已被同步为 PAID。
   */
  async queryAndSyncEpayOrder(outTradeNo: string): Promise<boolean> {
    const pid = resolveEpayPid();
    const privateKey = resolveMerchantPrivateKey();
    if (!pid || !privateKey) return false;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    // V2 /api/pay/query 文档参数:pid + out_trade_no + timestamp + sign + sign_type。
    // (act=order 是 V1 api.php?act=order 遗留,V2 不需要;签名按发出的参数集计算。)
    const rawParams: Record<string, string> = {
      pid,
      out_trade_no: outTradeNo,
      timestamp,
      sign_type: "RSA",
    };
    const sign = signParams(rawParams, privateKey);

    const base = resolveEpayBase();
    try {
      const resp = await fetch(`${base}/api/pay/query`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...rawParams, sign }).toString(),
      });
      const data = await resp.json() as Record<string, any>;
      this.logger.log(`[epay-query] zhunfu full response for ${outTradeNo}: ${JSON.stringify(data)}`);

      // zhunfu /api/pay/query 文档:code=0 表示查询成功(非 0 为失败),status=1 表示已支付
      // (0 未支付 / 2 已退款 / 3 已冻结 / 4 预授权退款)。早前误用 code===1 判成功,
      // 导致已支付订单被判「未支付」,前端轮询永不翻转 → 页面无反应。
      if (String(data.code) !== "0" || String(data.status) !== "1") {
        this.logger.warn(`[epay-query] zhunfu not paid: code=${data.code} status=${data.status} msg=${data.msg ?? ""}`);
        return false;
      }

      const callbackParams: Record<string, string> = {
        pid: String(data.pid ?? pid),
        trade_no: String(data.trade_no ?? ""),
        out_trade_no: String(data.out_trade_no ?? outTradeNo),
        type: String(data.type ?? ""),
        name: String(data.name ?? ""),
        money: String(data.money ?? ""),
        trade_status: "TRADE_SUCCESS",
      };

      const result = await this.epayCallback.handleNotify(callbackParams, { skipVerify: true });
      this.logger.log(`[epay-query] synced order ${outTradeNo}: handleNotify=${result}`);
      return result === "success";
    } catch (err: any) {
      this.logger.warn(`[epay-query] failed to query order ${outTradeNo}: ${err?.message || err}`);
      return false;
    }
  }

  /** 商户私钥 RSA 签名后 POST 一个 zhunfu V2 接口,返回解析后的 JSON(网络/解析失败 → null,不抛)。 */
  private async postEpaySigned(
    path: string,
    params: Record<string, string>,
    privateKey: string,
  ): Promise<Record<string, any> | null> {
    const sign = signParams(params, privateKey);
    const base = resolveEpayBase();
    try {
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, sign }).toString(),
      });
      const data = (await resp.json()) as Record<string, any>;
      this.logger.log(`[epay] ${path} ${params.out_trade_no ?? params.out_refund_no ?? ""}: ${JSON.stringify(data)}`);
      return data;
    } catch (err: any) {
      this.logger.error(`[epay] ${path} request failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * 调用 zhunfu V2 退款接口给客户实际打款(全额退 amountCents),并复核退款最终成功。返回 { ok, msg }:
   *  - 两步:① POST /api/pay/refund 发起退款(code=0 仅代表受理);② POST /api/pay/refundquery
   *    按 out_refund_no 复核,**必须 status=1(退款成功)才算最终确认**,ok=true。
   *  - 任一步失败(受理失败 / 查询失败 / status≠1 / pid·私钥缺失 / 网络异常)→ ok=false 并带 msg。
   *  - 调用方仅在 ok=true 时翻订单状态(钱→状态,绝不反过来;杜绝「标了 REFUNDED 但客户没收到钱」)。
   *
   * out_refund_no 按 outTradeNo 确定性派生:同一订单的退款重试始终用同一个号,网关据此去重 ——
   * 既防并发重复退款,也让「打款成功但本地翻状态前崩溃 / 异步到账」的重试拿回原结果并复核确认(幂等)。
   * 注:需先在 zhunfu 商户后台开启「订单退款 API」开关,否则接口返回失败。
   */
  async refundEpayOrder(outTradeNo: string, amountCents: number): Promise<{ ok: boolean; msg?: string }> {
    const pid = resolveEpayPid();
    const privateKey = resolveMerchantPrivateKey();
    if (!pid || !privateKey) return { ok: false, msg: "支付未配置(EPAY_PID / 商户私钥为空)" };

    const outRefundNo = `rf${outTradeNo}`; // 确定性退款单号 → 网关去重,重试幂等
    const money = (amountCents / 100).toFixed(2);

    // ① 发起退款。code=0 仅代表网关受理,不代表已到账。
    const refund = await this.postEpaySigned(
      "/api/pay/refund",
      { pid, out_trade_no: outTradeNo, money, out_refund_no: outRefundNo, timestamp: epayTimestamp(), sign_type: "RSA" },
      privateKey,
    );
    if (!refund) return { ok: false, msg: "网关请求失败" };
    if (String(refund.code) !== "0") {
      this.logger.warn(`[epay-refund] refund rejected for ${outTradeNo}: code=${refund.code} msg=${refund.msg ?? ""}`);
      return { ok: false, msg: String(refund.msg ?? `code=${refund.code}`) };
    }

    // ② 复核:按 out_refund_no 查退款状态,必须 status=1(退款成功)才最终确认。
    const q = await this.postEpaySigned(
      "/api/pay/refundquery",
      { pid, out_refund_no: outRefundNo, timestamp: epayTimestamp(), sign_type: "RSA" },
      privateKey,
    );
    if (!q) return { ok: false, msg: "退款已提交,但退款查询请求失败,请稍后复核或查商户后台" };
    if (String(q.code) === "0" && String(q.status) === "1") {
      this.logger.log(`[epay-refund] refund CONFIRMED for ${outTradeNo} (out_refund_no=${outRefundNo})`);
      return { ok: true, msg: String(q.msg ?? "退款成功") };
    }
    this.logger.warn(`[epay-refund] refund NOT confirmed for ${outTradeNo}: query code=${q.code} status=${q.status} msg=${q.msg ?? ""}`);
    return { ok: false, msg: `退款未确认成功(status=${q.status ?? "?"}),请稍后复核或查商户后台:${q.msg ?? ""}`.trim() };
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
        planName: selectionDisplayName(o.selection),
        amountCents: o.amountCents,
        payChannel: o.payChannel,
        payType: payTypeFromNotifyRaw(o.notifyRaw),
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
          // 目录订阅:用 products 拼接作展示名;迁移卡密订阅保持 null,前端回退「迁移卡密订阅」标签。
          planName: s.migratedFromKey != null
            ? null
            : products.length > 0 ? products.join("+") : null,
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
