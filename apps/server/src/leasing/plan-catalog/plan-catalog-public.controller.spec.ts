import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { PlanCatalogPublicController } from "./plan-catalog-public.controller";
import { IS_PUBLIC_KEY } from "../../shared/auth/public.decorator";

function makeController(getPublished: any) {
  const service = { getPublished } as any;
  return new PlanCatalogPublicController(service);
}

describe("PlanCatalogPublicController", () => {
  it("GET /api/plan-catalog → 当前 PUBLISHED 的 {version, config}(给前端渲染两条线)", async () => {
    const published = {
      id: "c1",
      version: 3,
      status: "PUBLISHED",
      config: { products: ["anthropic"], pricing: {}, usageTiers: {}, levels: {} },
    };
    const controller = makeController(vi.fn().mockResolvedValue(published));

    const result = await controller.get();

    expect(result).toEqual({ version: 3, config: published.config });
  });

  it("没有 PUBLISHED → version null + config null(前端可据此提示未配置)", async () => {
    const controller = makeController(vi.fn().mockResolvedValue(null));

    const result = await controller.get();

    expect(result).toEqual({ version: null, config: null });
  });

  it("类上标注 @Public()(跳过全局 JwtAuthGuard,公开可读)", () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, PlanCatalogPublicController);
    expect(isPublic).toBe(true);
  });
});
