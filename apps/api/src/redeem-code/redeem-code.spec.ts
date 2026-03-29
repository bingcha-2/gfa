/**
 * Comprehensive tests for RedeemCodeService
 *
 * Covers: batchCreate, verifyAndReserve (race condition fix), disable, markUsed
 * Edge cases: already-used codes, disabled codes, nonexistent codes
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { getPrisma, cleanDb, disconnectDb, createTestRedeemCode } from "../__tests__/helpers";
import { RedeemCodeService } from "./redeem-code.service";

describe("RedeemCodeService", () => {
  let service: RedeemCodeService;

  beforeAll(() => {
    service = new RedeemCodeService(getPrisma() as any);
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  // ---- batchCreate ----

  describe("batchCreate", () => {
    it("should create the exact number of codes requested", async () => {
      const codes = await service.batchCreate({ count: 5 });
      expect(codes).toHaveLength(5);
      codes.forEach((c) => {
        // Codes now have a type prefix: JZ-<16 alphanumeric chars>
        expect(c.code).toHaveLength(19); // "JZ-" (3) + 16 = 19
        expect(c.code).toMatch(/^JZ-[A-Z0-9]{16}$/);
        expect(c.product).toBe("GOOGLE_ONE");
        expect(c.status).toBe("UNUSED");
        expect(c.expiresAt).toBeNull();
      });
    });

    it("should generate unique codes", async () => {
      const codes = await service.batchCreate({ count: 20 });
      const codeSet = new Set(codes.map((c) => c.code));
      expect(codeSet.size).toBe(20);
    });

    it("should accept custom product name", async () => {
      const codes = await service.batchCreate({
        count: 1,
        product: "YOUTUBE_PREMIUM"
      });
      expect(codes[0].product).toBe("YOUTUBE_PREMIUM");
    });

    it("should generate codes with consistent prefix format", async () => {
      const codes = await service.batchCreate({ count: 25 });

      codes.forEach((code) => {
        // Default codeType is JOIN_GROUP which uses "JZ" prefix
        expect(code.code).toMatch(/^JZ-[A-Z0-9]{16}$/);
      });
    });

    it("should create 0 codes when count is 0", async () => {
      const codes = await service.batchCreate({ count: 0 });
      expect(codes).toHaveLength(0);
    });
  });

  // ---- verifyAndReserve ----

  describe("verifyAndReserve", () => {
    it("should reserve an UNUSED code", async () => {
      const code = await createTestRedeemCode(undefined, {
        code: "VALID-CODE-001"
      });

      const result = await service.verifyAndReserve(" valid-code-001 ");

      expect(result).not.toBeNull();
      expect(result!.id).toBe(code.id);

      // Verify status changed in DB
      const updated = await getPrisma().redeemCode.findUnique({
        where: { id: code.id }
      });
      expect(updated!.status).toBe("RESERVED");
    });

    it("should return null for nonexistent code", async () => {
      const result = await service.verifyAndReserve("DOES-NOT-EXIST");
      expect(result).toBeNull();
    });

    it("should return null for already USED code", async () => {
      await createTestRedeemCode(undefined, {
        code: "USED-CODE",
        status: "USED"
      });

      const result = await service.verifyAndReserve("USED-CODE");
      expect(result).toBeNull();
    });

    it("should return null for RESERVED code", async () => {
      await createTestRedeemCode(undefined, {
        code: "RESERVED-CODE",
        status: "RESERVED"
      });

      const result = await service.verifyAndReserve("RESERVED-CODE");
      expect(result).toBeNull();
    });

    it("should return null for DISABLED code", async () => {
      await createTestRedeemCode(undefined, {
        code: "DISABLED-CODE",
        status: "DISABLED"
      });

      const result = await service.verifyAndReserve("DISABLED-CODE");
      expect(result).toBeNull();
    });

  });

  // ---- disable ----

  describe("disable", () => {
    it("should disable an existing code", async () => {
      const code = await createTestRedeemCode();
      const disabled = await service.disable(code.id);
      expect(disabled.status).toBe("DISABLED");
    });

    it("should throw for nonexistent code", async () => {
      await expect(service.disable("nonexistent-id")).rejects.toThrow();
    });
  });

  // ---- markUsed ----

  describe("markUsed", () => {
    it("should mark code as USED with timestamp", async () => {
      const code = await createTestRedeemCode();
      await service.markUsed(code.id);

      const used = await getPrisma().redeemCode.findUnique({
        where: { id: code.id }
      });

      expect(used!.status).toBe("USED");
      expect(used!.usedAt).not.toBeNull();
    });

    it("should be idempotent for already used code", async () => {
      const code = await createTestRedeemCode(undefined, {
        status: "USED"
      });

      const before = await getPrisma().redeemCode.findUnique({
        where: { id: code.id }
      });

      const updatedCount = await service.markUsed(code.id);
      const after = await getPrisma().redeemCode.findUnique({
        where: { id: code.id }
      });

      expect(updatedCount.count).toBe(0);
      expect(after!.usedAt).toEqual(before!.usedAt);
    });
  });

  // ---- findAll ----

  describe("findAll", () => {
    it("should return all codes", async () => {
      await service.batchCreate({ count: 3 });
      const all = await service.findAll();
      expect(all).toHaveLength(3);
    });

    it("should filter by status", async () => {
      await service.batchCreate({ count: 2 });
      const code = await createTestRedeemCode(undefined, { status: "USED" });

      const unused = await service.findAll("UNUSED");
      expect(unused).toHaveLength(2);

      const used = await service.findAll("USED");
      expect(used).toHaveLength(1);
    });
  });
});
