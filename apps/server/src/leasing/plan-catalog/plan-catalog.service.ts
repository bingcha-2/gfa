import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import { AccessKeyStore } from "../token-server/access-key-store";
import { rowToConfig, subscriptionToLimitRecord } from "../subscription/subscription-config";
import { migrateBindSubscriptionToUsd } from "../subscription/subscription-usd-migration";
import type { CatalogConfig } from "./pricing";

/**
 * PlanCatalog 生命周期:草稿编辑 → 发布(同时至多一条 PUBLISHED)。
 * config 为 JSON 字符串(SQLite 无 Json 类型)。见 spec §4.1 / §7。
 */
@Injectable()
export class PlanCatalogService {
  private readonly logger = new Logger(PlanCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject("SHARED_ACCESS_KEY_STORE") private readonly accessKeyStore?: AccessKeyStore,
  ) {}

  /** 发布某版本:先把现有 PUBLISHED 归档,再把目标版设为 PUBLISHED。 */
  async publish(id: string) {
    const apply = async (db: any) => {
      await db.planCatalog.updateMany({
        where: { status: "PUBLISHED" },
        data: { status: "ARCHIVED" },
      });
      const published = await db.planCatalog.update({
        where: { id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      const refresh = await this.rewriteSubscriptionUsdQuotas(db, published);
      return { published, ...refresh };
    };
    const result = typeof (this.prisma as any).$transaction === "function"
      ? await (this.prisma as any).$transaction((tx: any) => apply(tx))
      : await apply(this.prisma);
    // Runtime state changes only after the catalog + every subscription config
    // committed together. A failed transaction therefore cannot expose a
    // partially-published quota rule to active sessions.
    for (const record of result.activeRecords) {
      this.accessKeyStore?.loadSubscriptionRecords([record]);
    }
    if (result.changed > 0) {
      this.logger.log(`published per-share USD quotas applied to ${result.changed} subscription(s)`);
    }
    return result.published;
  }

  /** 新建草稿版本:version = 现有最大 + 1。 */
  async createDraft(config: string) {
    const max = await this.prisma.planCatalog.aggregate({ _max: { version: true } });
    const nextVersion = (max._max.version ?? 0) + 1;
    return this.prisma.planCatalog.create({
      data: { version: nextVersion, status: "DRAFT", config },
    });
  }

  /** 当前发布版本(config 解析为对象);无则 null。 */
  async getPublished() {
    const row = await this.prisma.planCatalog.findFirst({ where: { status: "PUBLISHED" } });
    if (!row) return null;
    return { ...row, config: this.withRuntimeCapacity(JSON.parse(row.config)) };
  }

  /**
   * 按版本号取目录(config 解析为对象);无则 null。版本一经创建其 config 不再变更
   * (改价=发新版),故激活时按订单的 catalogVersion 溯源稳定的 durationDays 等全局规则。
   */
  async getByVersion(version: number) {
    const row = await this.prisma.planCatalog.findUnique({ where: { version } });
    if (!row) return null;
    return { ...row, config: this.withRuntimeCapacity(JSON.parse(row.config)) };
  }

  /**
   * 读目录时注入运行时账号份额容量(ACCOUNT_SHARE_CAPACITY)——绑定线 weight=容量/共享人数
   * 必须与运行时座位口径同源(去双源:定价不再硬编码 8)。按当前 env 注入、不落库,故改 env
   * 后无陈旧快照;已显式带 shareCapacity 的 config 保留其值(测试/特例可覆盖)。
   */
  private withRuntimeCapacity(config: any) {
    if (config && typeof config === "object" && config.shareCapacity == null) {
      config.shareCapacity = ACCOUNT_SHARE_CAPACITY;
    }
    return config;
  }

  /**
   * A published per-share quota is a live plan rule, not a new-customer-only
   * snapshot. Rewrite currently active, unexpired Codex/Claude bind subscriptions
   * without touching their used USD windows. Inactive history remains immutable;
   * entitlement-sync migrates it if it is ever renewed.
   */
  private async rewriteSubscriptionUsdQuotas(
    db: any,
    published: { config?: string; version?: number },
  ): Promise<{ changed: number; activeRecords: any[] }> {
    if (!published?.config || !db.subscription?.findMany) return { changed: 0, activeRecords: [] };
    const catalog = this.withRuntimeCapacity(JSON.parse(published.config)) as CatalogConfig;
    const now = new Date();
    const rows = await db.subscription.findMany({
      where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: {
        id: true, customerId: true, priority: true, backingKeyValue: true,
        status: true, expiresAt: true, productEntitlements: true,
        bucketLimits: true, bindings: true, levels: true, weight: true,
        deviceLimit: true, weeklyTokenLimit: true, windowMs: true, config: true,
      },
    });
    let changed = 0;
    const activeRecords: any[] = [];
    for (const sub of rows) {
      const migration = migrateBindSubscriptionToUsd(rowToConfig(sub as any), catalog, {
        forceCatalogRefresh: true,
        catalogVersion: published.version,
      });
      if (!migration.changed) continue;
      const serialized = JSON.stringify(migration.config);
      await db.subscription.update({ where: { id: sub.id }, data: { config: serialized } });
      changed++;

      activeRecords.push(subscriptionToLimitRecord({
            id: sub.id,
            customerId: sub.customerId,
            priority: sub.priority,
            backingKeyValue: sub.backingKeyValue,
            status: sub.status,
            expiresAt: sub.expiresAt,
            config: migration.config,
          }) as any);
    }
    return { changed, activeRecords };
  }
}
