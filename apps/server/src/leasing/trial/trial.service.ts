import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";
import { computePurchase, type CatalogConfig, type PoolSelection } from "../plan-catalog/pricing";
import { SubscriptionService } from "../subscription/subscription.service";

// Codex 试用默认值写死在服务端；管理员发放单个试用时仍可覆盖。
const TRIAL_DURATION_DAYS = 3;
const TRIAL_WEEKLY_USD_LIMIT = 20;
const MAX_TRIAL_DAYS = 365;
const MAX_TRIAL_USD_LIMIT = 1_000_000;

export interface TrialGrantResult {
  subscription: Awaited<ReturnType<SubscriptionService["activateForOrder"]>>;
  created: boolean;
}

export interface TrialGrantOptions {
  durationDays?: number;
  weeklyUsdLimit?: number;
}

function trialOutTradeNo(customerId: string): string {
  return `trial_${customerId}`;
}

@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planCatalog: PlanCatalogService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  getDefaultDurationDays(): number {
    return TRIAL_DURATION_DAYS;
  }

  getDefaultWeeklyUsdLimit(): number {
    return TRIAL_WEEKLY_USD_LIMIT;
  }

  /**
   * Grant the customer's one lifetime Codex trial. The deterministic
   * outTradeNo is the idempotency anchor for admin retries and double clicks.
   */
  async grantTrial(
    customerId: string,
    options: TrialGrantOptions = {},
  ): Promise<TrialGrantResult> {
    const days = this.validateDurationDays(
      options.durationDays ?? this.getDefaultDurationDays(),
    );
    const weeklyUsdLimit = this.validateWeeklyUsdLimit(
      options.weeklyUsdLimit ?? this.getDefaultWeeklyUsdLimit(),
    );
    const outTradeNo = trialOutTradeNo(customerId);

    const existing = await this.prisma.planOrder.findUnique({ where: { outTradeNo } });
    if (existing) {
      return { subscription: await this.ensureActivated(existing), created: false };
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found`);

    const published = await this.planCatalog.getPublished();
    if (!published) {
      throw new BadRequestException("套餐目录未发布，暂时无法发放试用");
    }

    const selection = this.buildTrialSelection(published.config as CatalogConfig);
    let config: Record<string, unknown>;
    try {
      ({ config } = computePurchase(published.config as CatalogConfig, selection));
    } catch (err: any) {
      throw new BadRequestException(`试用套餐配置无效：${err?.message || err}`);
    }
    config = {
      ...config,
      products: ["codex"],
      bucketLimits: {},
      weeklyTokenLimit: 0,
      quotaAlgorithm: "usd",
      usdQuotaByProduct: {
        codex: {
          fiveHour: 0,
          weekly: weeklyUsdLimit,
        },
      },
      usdQuotaSource: "manual",
      trial: {
        durationDays: days,
        weeklyUsdLimit,
        policy: "one-per-customer",
        startsAt: new Date().toISOString(),
      },
    };

    const now = new Date();
    let order;
    try {
      order = await this.prisma.planOrder.create({
        data: {
          customerId,
          amountCents: 0,
          payChannel: "TRIAL",
          outTradeNo,
          status: "PAID",
          paidAt: now,
          expiresAt: now,
          catalogVersion: published.version,
          selection: JSON.stringify(selection),
          config: JSON.stringify(config),
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
        throw err;
      }
      order = await this.prisma.planOrder.findUnique({ where: { outTradeNo } });
      if (!order) throw err;
      return { subscription: await this.ensureActivated(order), created: false };
    }

    const subscription = await this.ensureActivated(order);
    await this.prisma.notification.create({
      data: {
        customerId,
        type: "BILLING",
        title: "试用已开通",
        body: `您的 ${days} 天 Codex 试用已开通，每周额度 $${weeklyUsdLimit.toFixed(2)}。`,
      },
    });
    this.logger.log(
      `[trial] granted ${days}-day trial ${subscription.id} to customer ${customerId}`,
    );
    return { subscription, created: true };
  }

  private async ensureActivated(order: {
    id: string;
    customerId: string;
    subscriptionId: string | null;
    config: string | null;
    catalogVersion: number | null;
    payChannel: string;
  }) {
    if (order.subscriptionId) {
      const linked = await this.prisma.subscription.findUnique({
        where: { id: order.subscriptionId },
      });
      if (linked) return linked;
    }

    const exact = await this.prisma.subscription.findFirst({
      where: { activatedFromOrderId: order.id },
    });
    if (exact) {
      await this.linkOrder(order.id, exact.id);
      return exact;
    }

    const subscription = await this.subscriptions.activateForOrder(order);
    await this.linkOrder(order.id, subscription.id);
    return subscription;
  }

  private async linkOrder(orderId: string, subscriptionId: string): Promise<void> {
    await this.prisma.planOrder.update({
      where: { id: orderId },
      data: { subscriptionId },
    });
  }

  private buildTrialSelection(catalog: CatalogConfig): PoolSelection {
    const codexAvailable = Object.prototype.hasOwnProperty.call(
      catalog.pricing?.pool?.product || {},
      "codex",
    );
    const usageTiers = Object.keys(catalog.usageTiers || {});
    const usageTier = usageTiers.includes("small") ? "small" : usageTiers[0];
    if (!codexAvailable || !usageTier) {
      throw new BadRequestException("当前套餐目录缺少 Codex 号池产品或用量档");
    }
    return {
      line: "pool",
      products: ["codex"],
      usageTier,
      deviceLimit: 1,
    };
  }

  private validateDurationDays(value: number): number {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > MAX_TRIAL_DAYS) {
      throw new BadRequestException(`试用天数必须是 1-${MAX_TRIAL_DAYS} 的整数`);
    }
    return days;
  }

  private validateWeeklyUsdLimit(value: number): number {
    const usd = Number(value);
    if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_TRIAL_USD_LIMIT) {
      throw new BadRequestException(
        `每周美元额度必须大于 0 且不超过 ${MAX_TRIAL_USD_LIMIT}`,
      );
    }
    return Math.round(usd * 1_000_000) / 1_000_000;
  }
}
