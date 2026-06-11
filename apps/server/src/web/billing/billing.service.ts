/**
 * billing.service.ts — plan order creation and management.
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

import { PrismaService } from "../../prisma/prisma.service";
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

/** Collision-resistant trade number: "gfa" + timestamp + 12 random hex chars. */
export function generateOutTradeNo(): string {
  const ts = Date.now().toString();
  const rand = crypto.randomBytes(6).toString("hex");
  return `gfa${ts}${rand}`;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a PENDING PlanOrder, build the payUrl and qrDataUri.
   * Snapshot referrerId = customer.invitedById at order-create time.
   */
  async createOrder(
    customerId: string,
    planId: string,
    channel: "ALIPAY" | "WXPAY",
  ) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException(`Plan "${planId}" not found`);
    if (!plan.active) throw new BadRequestException("Plan is not available for purchase");

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, invitedById: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found`);

    const outTradeNo = generateOutTradeNo();
    const expiresAt = new Date(Date.now() + THIRTY_MIN_MS);
    const money = (plan.priceCents / 100).toFixed(2);
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
      name: plan.name,
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
        planId,
        amountCents: plan.priceCents,
        payChannel: channel,
        outTradeNo,
        status: "PENDING",
        expiresAt,
        referrerId: customer.invitedById ?? null,
      },
    });

    this.logger.log(`Created PlanOrder ${order.id} outTradeNo=${outTradeNo} for customer ${customerId}`);

    return {
      outTradeNo: order.outTradeNo,
      amountCents: order.amountCents,
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
        include: { plan: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: safePageSize,
      }),
      this.prisma.planOrder.count({ where: { customerId } }),
    ]);

    return {
      orders: orders.map((o) => ({
        outTradeNo: o.outTradeNo,
        planName: o.plan.name,
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
      include: { plan: { select: { name: true } } },
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
          planName: s.planId ? (s.plan?.name ?? null) : null,
          status: s.status,
          products,
          expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
          deviceLimit: s.deviceLimit,
          weight: s.weight,
          migratedFromCard: s.planId == null,
        };
      }),
    };
  }
}
