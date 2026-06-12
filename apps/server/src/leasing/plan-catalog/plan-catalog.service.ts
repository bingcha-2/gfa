import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";

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
    return { ...row, config: JSON.parse(row.config) };
  }
}
