import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";

/**
 * PlanCatalog 生命周期:草稿编辑 → 发布(同时至多一条 PUBLISHED)。
 * config 为 JSON 字符串(SQLite 无 Json 类型)。见 spec §4.1 / §7。
 */
@Injectable()
export class PlanCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** 发布某版本:先把现有 PUBLISHED 归档,再把目标版设为 PUBLISHED。 */
  async publish(id: string) {
    await this.prisma.planCatalog.updateMany({
      where: { status: "PUBLISHED" },
      data: { status: "ARCHIVED" },
    });
    return this.prisma.planCatalog.update({
      where: { id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
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
}
