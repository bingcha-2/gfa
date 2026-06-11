/**
 * plan.service.spec.ts
 *
 * TDD tests for PlanService:
 * 1. Public list: returns only active, sorted, customer-safe shape
 * 2. Create: valid payload persists; invalid product rejected; duplicates rejected; weight 0/9 rejected; priceCents -1 rejected
 * 3. Update: partial patch updates only sent fields; invalid patch rejected
 * 4. Delete: unreferenced plan deletes; Subscription reference → 409; PlanOrder reference → 409
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

import { PlanService } from "./plan.service";

const VALID_PRODUCTS = ["antigravity", "codex", "anthropic"];

// ---- Factory helpers ----

function makePlan(overrides: Record<string, any> = {}) {
  return {
    id: "plan-1",
    name: "Basic Plan",
    description: "A basic plan",
    priceCents: 1000,
    durationDays: 30,
    productEntitlements: JSON.stringify(["antigravity"]),
    bucketLimits: null,
    levels: null,
    weight: 1,
    deviceLimit: 1,
    weeklyTokenLimit: null,
    windowMs: 18000000,
    active: true,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma = {
    plan: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(makePlan()),
      update: vi.fn().mockResolvedValue(makePlan()),
      delete: vi.fn().mockResolvedValue(makePlan()),
      count: vi.fn().mockResolvedValue(0),
      ...prismaOverrides.plan,
    },
    subscription: {
      count: vi.fn().mockResolvedValue(0),
      ...prismaOverrides.subscription,
    },
    planOrder: {
      count: vi.fn().mockResolvedValue(0),
      ...prismaOverrides.planOrder,
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      ...prismaOverrides.auditLog,
    },
  };

  return {
    prisma,
    service: new PlanService(prisma as any),
  };
}

// ---- 1. Public catalog ----

describe("PlanService.listPublic", () => {
  it("returns only active plans ordered by sortOrder asc then priceCents asc", async () => {
    const activePlan = makePlan({ active: true, sortOrder: 1, priceCents: 500 });
    const inactivePlan = makePlan({ id: "plan-2", active: false });
    const { prisma, service } = makeService({
      plan: {
        findMany: vi.fn().mockResolvedValue([activePlan]),
      },
    });

    const result = await service.listPublic();

    expect(prisma.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
      })
    );
    expect(result.plans).toHaveLength(1);
  });

  it("returns customer-safe shape without internal fields", async () => {
    const plan = makePlan({
      productEntitlements: JSON.stringify(["antigravity", "codex"]),
      bucketLimits: JSON.stringify({ model: 100 }),
      levels: JSON.stringify({ antigravity: "pro" }),
      weeklyTokenLimit: 50000,
      windowMs: 18000000,
    });
    const { service } = makeService({
      plan: { findMany: vi.fn().mockResolvedValue([plan]) },
    });

    const result = await service.listPublic();
    const publicPlan = result.plans[0];

    // Should have customer-safe fields
    expect(publicPlan).toHaveProperty("id");
    expect(publicPlan).toHaveProperty("name");
    expect(publicPlan).toHaveProperty("description");
    expect(publicPlan).toHaveProperty("priceCents");
    expect(publicPlan).toHaveProperty("durationDays");
    expect(publicPlan).toHaveProperty("products");
    expect(publicPlan).toHaveProperty("deviceLimit");
    expect(publicPlan).toHaveProperty("weight");
    expect(publicPlan).toHaveProperty("sortOrder");

    // Must NOT expose internal fields
    expect(publicPlan).not.toHaveProperty("bucketLimits");
    expect(publicPlan).not.toHaveProperty("levels");
    expect(publicPlan).not.toHaveProperty("weeklyTokenLimit");
    expect(publicPlan).not.toHaveProperty("windowMs");
    expect(publicPlan).not.toHaveProperty("productEntitlements");
    expect(publicPlan).not.toHaveProperty("createdAt");
    expect(publicPlan).not.toHaveProperty("updatedAt");
  });

  it("parses productEntitlements JSON string into products array", async () => {
    const plan = makePlan({
      productEntitlements: JSON.stringify(["antigravity", "codex"]),
    });
    const { service } = makeService({
      plan: { findMany: vi.fn().mockResolvedValue([plan]) },
    });

    const result = await service.listPublic();
    expect(result.plans[0].products).toEqual(["antigravity", "codex"]);
    expect(Array.isArray(result.plans[0].products)).toBe(true);
  });
});

// ---- 2. Create plan ----

describe("PlanService.create", () => {
  const validDto = {
    name: "Pro Plan",
    priceCents: 2000,
    durationDays: 30,
    products: ["antigravity", "codex"],
    weight: 4,
    deviceLimit: 2,
    active: true,
    sortOrder: 1,
    windowMs: 18000000,
  };

  it("creates a plan and stores products as JSON string", async () => {
    const { prisma, service } = makeService({
      plan: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(makePlan()),
      },
    });

    await service.create(validDto as any);

    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productEntitlements: JSON.stringify(["antigravity", "codex"]),
        }),
      })
    );
  });

  it("rejects an invalid product name", async () => {
    const { service } = makeService();

    await expect(
      service.create({ ...validDto, products: ["invalid-product"] } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects duplicate products in the array", async () => {
    const { service } = makeService();

    await expect(
      service.create({ ...validDto, products: ["antigravity", "antigravity"] } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects weight of 0", async () => {
    const { service } = makeService();

    await expect(
      service.create({ ...validDto, weight: 0 } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects weight of 9", async () => {
    const { service } = makeService();

    await expect(
      service.create({ ...validDto, weight: 9 } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects priceCents of -1", async () => {
    const { service } = makeService();

    await expect(
      service.create({ ...validDto, priceCents: -1 } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects empty products array", async () => {
    const { service } = makeService();

    await expect(
      service.create({ ...validDto, products: [] } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts valid boundary weight values 1 and 8", async () => {
    const { service } = makeService({
      plan: { create: vi.fn().mockResolvedValue(makePlan()) },
    });

    await expect(service.create({ ...validDto, weight: 1 } as any)).resolves.toBeDefined();
    await expect(service.create({ ...validDto, weight: 8 } as any)).resolves.toBeDefined();
  });

  it("stringifies bucketLimits object when provided", async () => {
    const { prisma, service } = makeService({
      plan: { create: vi.fn().mockResolvedValue(makePlan()) },
    });

    const bucketLimits = { gpt4: 100, claude: 200 };
    await service.create({ ...validDto, bucketLimits } as any);

    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bucketLimits: JSON.stringify(bucketLimits),
        }),
      })
    );
  });

  it("stringifies levels object when provided", async () => {
    const { prisma, service } = makeService({
      plan: { create: vi.fn().mockResolvedValue(makePlan()) },
    });

    const levels = { antigravity: "pro" };
    await service.create({ ...validDto, levels } as any);

    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          levels: JSON.stringify(levels),
        }),
      })
    );
  });
});

// ---- 3. Update plan ----

describe("PlanService.update", () => {
  it("updates only sent fields (partial patch)", async () => {
    const existing = makePlan();
    const { prisma, service } = makeService({
      plan: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, name: "New Name" }),
      },
    });

    const result = await service.update("plan-1", { name: "New Name" } as any);

    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plan-1" },
        data: expect.objectContaining({ name: "New Name" }),
      })
    );
    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ priceCents: expect.anything() }),
      })
    );
  });

  it("throws NotFoundException for non-existent plan", async () => {
    const { service } = makeService({
      plan: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.update("non-existent", { name: "x" } as any)).rejects.toThrow(
      NotFoundException
    );
  });

  it("rejects invalid product name on update", async () => {
    const existing = makePlan();
    const { service } = makeService({
      plan: { findUnique: vi.fn().mockResolvedValue(existing) },
    });

    await expect(
      service.update("plan-1", { products: ["invalid"] } as any)
    ).rejects.toThrow(BadRequestException);
  });

  it("stringifies products when updating", async () => {
    const existing = makePlan();
    const { prisma, service } = makeService({
      plan: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(existing),
      },
    });

    await service.update("plan-1", { products: ["anthropic"] } as any);

    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productEntitlements: JSON.stringify(["anthropic"]),
        }),
      })
    );
  });
});

// ---- 4. Delete plan ----

describe("PlanService.delete", () => {
  it("deletes an unreferenced plan", async () => {
    const existing = makePlan();
    const { prisma, service } = makeService({
      plan: {
        findUnique: vi.fn().mockResolvedValue(existing),
        delete: vi.fn().mockResolvedValue(existing),
      },
      subscription: { count: vi.fn().mockResolvedValue(0) },
      planOrder: { count: vi.fn().mockResolvedValue(0) },
    });

    const result = await service.delete("plan-1");

    expect(prisma.plan.delete).toHaveBeenCalledWith({ where: { id: "plan-1" } });
    expect(result).toMatchObject({ id: "plan-1", deleted: true });
  });

  it("throws 409 PLAN_IN_USE when a Subscription references the plan", async () => {
    const existing = makePlan();
    const { service } = makeService({
      plan: { findUnique: vi.fn().mockResolvedValue(existing) },
      subscription: { count: vi.fn().mockResolvedValue(1) },
      planOrder: { count: vi.fn().mockResolvedValue(0) },
    });

    const error = await service.delete("plan-1").catch((e: any) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.response).toMatchObject({ error: "PLAN_IN_USE" });
  });

  it("throws 409 PLAN_IN_USE when a PlanOrder references the plan", async () => {
    const existing = makePlan();
    const { service } = makeService({
      plan: { findUnique: vi.fn().mockResolvedValue(existing) },
      subscription: { count: vi.fn().mockResolvedValue(0) },
      planOrder: { count: vi.fn().mockResolvedValue(1) },
    });

    const error = await service.delete("plan-1").catch((e: any) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.response).toMatchObject({ error: "PLAN_IN_USE" });
  });

  it("throws NotFoundException for non-existent plan", async () => {
    const { service } = makeService({
      plan: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.delete("non-existent")).rejects.toThrow(NotFoundException);
  });
});
