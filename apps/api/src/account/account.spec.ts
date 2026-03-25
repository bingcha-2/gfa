/**
 * Comprehensive tests for AccountService
 *
 * Covers: CRUD, status filtering, update with partial data, not found handling
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  getPrisma,
  cleanDb,
  disconnectDb,
  createTestAccount
} from "../__tests__/helpers";
import { AccountService } from "./account.service";

describe("AccountService", () => {
  let service: AccountService;

  beforeAll(() => {
    service = new AccountService(getPrisma() as any);
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  describe("create", () => {
    it("should create an account with required fields", async () => {
      const account = await service.create({
        name: "Test Account",
        loginEmail: "test@gmail.com",
        adspowerProfileId: "profile-1"
      });

      expect(account.id).toBeDefined();
      expect(account.name).toBe("Test Account");
      expect(account.status).toBe("HEALTHY");
      expect(account.riskScore).toBe(0);
    });

    it("should reject duplicate loginEmail", async () => {
      await service.create({
        name: "First",
        loginEmail: "dup@gmail.com",
        adspowerProfileId: "p-1"
      });

      await expect(
        service.create({
          name: "Second",
          loginEmail: "dup@gmail.com",
          adspowerProfileId: "p-2"
        })
      ).rejects.toThrow();
    });

    it("should reject duplicate adspowerProfileId", async () => {
      await service.create({
        name: "First",
        loginEmail: "a1@gmail.com",
        adspowerProfileId: "same-profile"
      });

      await expect(
        service.create({
          name: "Second",
          loginEmail: "a2@gmail.com",
          adspowerProfileId: "same-profile"
        })
      ).rejects.toThrow();
    });
  });

  describe("findOne", () => {
    it("should return account with family groups", async () => {
      const account = await createTestAccount();
      const found = await service.findOne(account.id);
      expect(found.id).toBe(account.id);
      expect(found.familyGroups).toEqual([]);
    });

    it("should throw NotFoundException for invalid id", async () => {
      await expect(service.findOne("nonexistent")).rejects.toThrow(
        "Account not found"
      );
    });
  });

  describe("findAll", () => {
    it("should return all accounts", async () => {
      await createTestAccount({ name: "A1" });
      await createTestAccount({ name: "A2" });

      const all = await service.findAll();
      expect(all).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const account = await createTestAccount();
      await getPrisma().account.update({
        where: { id: account.id },
        data: { status: "RISKY" }
      });

      await createTestAccount();

      const healthy = await service.findAll("HEALTHY");
      expect(healthy).toHaveLength(1);

      const risky = await service.findAll("RISKY");
      expect(risky).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("should update only provided fields", async () => {
      const account = await createTestAccount({ name: "Original" });

      const updated = await service.update(account.id, { name: "Updated" });
      expect(updated.name).toBe("Updated");
      expect(updated.loginEmail).toBe(account.loginEmail);
    });

    it("should update status", async () => {
      const account = await createTestAccount();
      const updated = await service.update(account.id, {
        status: "RISKY"
      });
      expect(updated.status).toBe("RISKY");
    });

    it("should throw for nonexistent account", async () => {
      await expect(
        service.update("nonexistent", { name: "X" })
      ).rejects.toThrow("Account not found");
    });
  });
});
