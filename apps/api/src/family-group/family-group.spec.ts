/**
 * Comprehensive tests for FamilyGroupService
 *
 * Covers: CRUD, member listing, auto-select algorithm, not-found handling
 * Edge cases: no available groups, all groups full, risk score ordering
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  getPrisma,
  cleanDb,
  disconnectDb,
  createTestAccount,
  createTestFamilyGroup
} from "../__tests__/helpers";
import { FamilyGroupService } from "./family-group.service";

describe("FamilyGroupService", () => {
  let service: FamilyGroupService;

  // Mock sync queue since we're testing service logic, not queue integration
  const mockSyncQueue = {
    add: async (_name: string, _data: any, _opts: any) => ({ id: "mock-job-1" })
  };

  beforeAll(() => {
    service = new FamilyGroupService(getPrisma() as any, mockSyncQueue as any);
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  describe("create", () => {
    it("should create group with default maxMembers=6", async () => {
      const account = await createTestAccount();
      const group = await service.create({
        accountId: account.id,
        groupName: "Test Group"
      });

      expect(group.maxMembers).toBe(6);
      expect(group.availableSlots).toBe(6);
      expect(group.status).toBe("ACTIVE");
    });

    it("should create group with custom maxMembers", async () => {
      const account = await createTestAccount();
      const group = await service.create({
        accountId: account.id,
        groupName: "Small Group",
        maxMembers: 3
      });

      expect(group.maxMembers).toBe(3);
      expect(group.availableSlots).toBe(3);
    });
  });

  describe("findOne", () => {
    it("should return group with account and members", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);

      const found = await service.findOne(group.id);
      expect(found.id).toBe(group.id);
      expect(found.account?.id).toBe(account.id);
      expect(found.members).toEqual([]);
    });

    it("should throw for nonexistent group", async () => {
      await expect(service.findOne("nonexistent")).rejects.toThrow(
        "Family group not found"
      );
    });
  });

  describe("findAll", () => {
    it("should filter by accountId", async () => {
      const a1 = await createTestAccount();
      const a2 = await createTestAccount();
      await createTestFamilyGroup(a1.id);
      await createTestFamilyGroup(a1.id);
      await createTestFamilyGroup(a2.id);

      const a1Groups = await service.findAll(a1.id);
      expect(a1Groups).toHaveLength(2);
    });

    it("should return all groups when no filter", async () => {
      const a = await createTestAccount();
      await createTestFamilyGroup(a.id);
      await createTestFamilyGroup(a.id);

      const all = await service.findAll();
      expect(all).toHaveLength(2);
    });

    it("should tolerate orphaned groups without throwing", async () => {
      const mockService = new FamilyGroupService(
        {
          familyGroup: {
            findMany: async () => [
              {
                id: "group-1",
                accountId: "missing-account-id",
                _count: { members: 0, invites: 0 }
              }
            ]
          },
          account: {
            findMany: async () => []
          }
        } as any,
        mockSyncQueue as any
      );

      const all = await mockService.findAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("group-1");
      expect(all[0].account).toBeNull();
    });
  });

  // ---- Auto-select algorithm ----

  describe("findAvailableGroup", () => {
    it("should return null when no groups exist", async () => {
      const result = await service.findAvailableGroup();
      expect(result).toBeNull();
    });

    it("should return null when all groups are full (0 slots)", async () => {
      const account = await createTestAccount();
      await createTestFamilyGroup(account.id, { availableSlots: 0 });
      await createTestFamilyGroup(account.id, { availableSlots: 0 });

      const result = await service.findAvailableGroup();
      expect(result).toBeNull();
    });

    it("should return null when all groups are DISABLED", async () => {
      const account = await createTestAccount();
      await createTestFamilyGroup(account.id, {
        availableSlots: 3,
        status: "DISABLED"
      });

      const result = await service.findAvailableGroup();
      expect(result).toBeNull();
    });

    it("should prefer group with lowest risk score", async () => {
      const account = await createTestAccount();
      const highRisk = await createTestFamilyGroup(account.id, {
        availableSlots: 5,
        riskScore: 80
      });
      const lowRisk = await createTestFamilyGroup(account.id, {
        availableSlots: 5,
        riskScore: 10
      });

      const result = await service.findAvailableGroup();
      expect(result).toBe(lowRisk.id);
    });

    it("should prefer group with more available slots when risk is same", async () => {
      const account = await createTestAccount();
      const fewer = await createTestFamilyGroup(account.id, {
        availableSlots: 1,
        riskScore: 0
      });
      const more = await createTestFamilyGroup(account.id, {
        availableSlots: 4,
        riskScore: 0
      });

      const result = await service.findAvailableGroup();
      expect(result).toBe(more.id);
    });

    it("should not select DISABLED groups", async () => {
      const account = await createTestAccount();
      await createTestFamilyGroup(account.id, {
        availableSlots: 0,
        status: "DISABLED"
      });
      const active = await createTestFamilyGroup(account.id, {
        availableSlots: 2
      });

      const result = await service.findAvailableGroup();
      expect(result).toBe(active.id);
    });

    it("should skip groups whose account record is missing", async () => {
      const mockService = new FamilyGroupService(
        {
          familyGroup: {
            findMany: async () => [
              { id: "orphan-group", accountId: "missing-account-id" },
              { id: "valid-group", accountId: "valid-account-id" }
            ]
          },
          account: {
            findUnique: async ({
              where
            }: {
              where: { id: string };
              select: { id: true };
            }) => {
              if (where.id === "valid-account-id") {
                return { id: "valid-account-id" };
              }

              return null;
            }
          }
        } as any,
        mockSyncQueue as any
      );

      const result = await mockService.findAvailableGroup();
      expect(result).toBe("valid-group");
      expect(result).not.toBe("orphan-group");
    });
  });

  describe("triggerSync", () => {
    it("should enqueue sync job for valid group", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);

      const result = await service.triggerSync(group.id);
      expect(result.queued).toBe(true);
      expect(result.jobId).toBe("mock-job-1");
    });

    it("should throw for nonexistent group", async () => {
      await expect(service.triggerSync("nonexistent")).rejects.toThrow(
        "Family group not found"
      );
    });
  });
});
