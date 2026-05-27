import { describe, expect, it, vi } from "vitest";

import { RedeemCodeService } from "./redeem-code.service";

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma = {
    redeemCode: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      ...prismaOverrides.redeemCode,
    },
  };

  return {
    prisma,
    service: new RedeemCodeService(prisma as any),
  };
}

describe("RedeemCodeService", () => {
  it("defaults list sorting to newest createdAt first", async () => {
    const { prisma, service } = makeService();

    await service.findAll(1, 30, undefined, undefined, true);

    expect(prisma.redeemCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("supports createdAt ascending sorting", async () => {
    const { prisma, service } = makeService();

    await service.findAll(1, 30, undefined, undefined, true, undefined, "createdAt", "asc");

    expect(prisma.redeemCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("deletes expired codes during manual cleanup", async () => {
    const { prisma, service } = makeService({
      redeemCode: {
        deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
    });
    const now = new Date("2026-05-27T00:00:00.000Z");

    await service.cleanupExpiredCodes(now);

    expect(prisma.redeemCode.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: "EXPIRED" },
          { expiresAt: { lte: now } },
        ],
      },
    });
  });
});
