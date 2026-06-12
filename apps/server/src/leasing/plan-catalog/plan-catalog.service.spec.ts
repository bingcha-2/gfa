import { describe, expect, it, vi } from "vitest";

import { PlanCatalogService } from "./plan-catalog.service";

function makeService(overrides: Record<string, any> = {}) {
  const prisma = {
    planCatalog: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 0 } }),
      ...overrides.planCatalog,
    },
  };
  return { prisma, service: new PlanCatalogService(prisma as any) };
}

describe("PlanCatalogService.publish", () => {
  it("发布某版 → 该版 PUBLISHED,之前的 PUBLISHED 全部归档为 ARCHIVED(同时至多一个 PUBLISHED)", async () => {
    const { prisma, service } = makeService();

    await service.publish("cat-2");

    // 先把现有 PUBLISHED 归档
    expect(prisma.planCatalog.updateMany).toHaveBeenCalledWith({
      where: { status: "PUBLISHED" },
      data: { status: "ARCHIVED" },
    });
    // 再把目标版设为 PUBLISHED
    expect(prisma.planCatalog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat-2" },
        data: expect.objectContaining({ status: "PUBLISHED" }),
      }),
    );
  });
});

describe("PlanCatalogService.createDraft", () => {
  it("创建草稿 → version = 当前最大+1,status=DRAFT,config 原样存", async () => {
    const { prisma, service } = makeService({
      planCatalog: { aggregate: vi.fn().mockResolvedValue({ _max: { version: 3 } }) },
    });

    await service.createDraft('{"durationDays":30}');

    expect(prisma.planCatalog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 4,
          status: "DRAFT",
          config: '{"durationDays":30}',
        }),
      }),
    );
  });

  it("首个草稿 → version = 1", async () => {
    const { prisma, service } = makeService(); // aggregate 默认 _max.version = 0

    await service.createDraft("{}");

    expect(prisma.planCatalog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 1 }) }),
    );
  });
});

describe("PlanCatalogService.getPublished", () => {
  it("返回当前 PUBLISHED 版本,config 解析为对象", async () => {
    const { prisma, service } = makeService({
      planCatalog: {
        findFirst: vi.fn().mockResolvedValue({
          id: "c1",
          version: 2,
          status: "PUBLISHED",
          config: '{"durationDays":30}',
        }),
      },
    });

    const result = await service.getPublished();

    expect(prisma.planCatalog.findFirst).toHaveBeenCalledWith({ where: { status: "PUBLISHED" } });
    expect(result).toEqual(expect.objectContaining({ version: 2, config: { durationDays: 30 } }));
  });

  it("没有 PUBLISHED → null", async () => {
    const { service } = makeService();
    expect(await service.getPublished()).toBeNull();
  });
});

describe("PlanCatalogService.getByVersion", () => {
  it("按版本号取该版(config 解析为对象)—— 激活时按订单 catalogVersion 溯源不变的 durationDays", async () => {
    const { prisma, service } = makeService({
      planCatalog: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c1",
          version: 5,
          status: "ARCHIVED",
          config: '{"durationDays":30}',
        }),
      },
    });

    const result = await service.getByVersion(5);

    expect(prisma.planCatalog.findUnique).toHaveBeenCalledWith({ where: { version: 5 } });
    expect(result).toEqual(expect.objectContaining({ version: 5, config: { durationDays: 30 } }));
  });

  it("该版本不存在 → null", async () => {
    const { service } = makeService(); // findUnique 默认 null
    expect(await service.getByVersion(999)).toBeNull();
  });
});
