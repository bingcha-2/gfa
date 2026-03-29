/**
 * Comprehensive tests for FamilyGroupService
 *
 * Covers: CRUD, member listing, auto-select algorithm, not-found handling
 * Edge cases: no available groups, all groups full, risk score ordering
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

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

  // Mock queues since we're testing service logic, not queue integration
  const mockSyncQueue = {
    add: async (_name: string, _data: any, _opts: any) => ({ id: "mock-job-1" })
  };
  const mockRemoveQueue = {
    add: async (_name: string, _data: any, _opts: any) => ({ id: "mock-remove-1" })
  };
  const mockInviteQueue = {
    add: async (_name: string, _data: any, _opts: any) => ({ id: "mock-invite-1" })
  };
  const mockReplaceQueue = {
    add: async (_name: string, _data: any, _opts: any) => ({ id: "mock-replace-1" })
  };

  beforeAll(() => {
    service = new FamilyGroupService(
      getPrisma() as any,
      mockSyncQueue as any,
      mockRemoveQueue as any,
      mockInviteQueue as any,
      mockReplaceQueue as any
    );
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  describe("create", () => {
    it("should create group with default maxMembers=5", async () => {
      const account = await createTestAccount();
      const group = await service.create({
        accountId: account.id,
        groupName: "Test Group"
      });

      expect(group.maxMembers).toBe(5);
      expect(group.availableSlots).toBe(5);
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
        mockSyncQueue as any,
        mockRemoveQueue as any,
        mockInviteQueue as any,
        mockReplaceQueue as any
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

    it("should prefer earliest created group (createdAt ASC)", async () => {
      const account = await createTestAccount();
      // Create groups with a small delay to ensure different createdAt
      const first = await createTestFamilyGroup(account.id, {
        availableSlots: 5,
        riskScore: 80
      });
      // Second group created later
      const second = await createTestFamilyGroup(account.id, {
        availableSlots: 5,
        riskScore: 10
      });

      const result = await service.findAvailableGroup();
      // Should return the first created, regardless of riskScore
      expect(result).toBe(first.id);
    });

    it("should return earliest created group even with fewer slots", async () => {
      const account = await createTestAccount();
      const earlier = await createTestFamilyGroup(account.id, {
        availableSlots: 1,
        riskScore: 0
      });
      const later = await createTestFamilyGroup(account.id, {
        availableSlots: 4,
        riskScore: 0
      });

      const result = await service.findAvailableGroup();
      // createdAt ASC: earlier group wins
      expect(result).toBe(earlier.id);
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

    it("should not return a group when its account is not HEALTHY", async () => {
      const account = await createTestAccount();
      // Mark the account as RISKY so findAvailableGroup skips it
      await getPrisma().account.update({
        where: { id: account.id },
        data: { status: "RISKY" }
      });
      await createTestFamilyGroup(account.id, { availableSlots: 3 });

      const result = await service.findAvailableGroup();
      expect(result).toBeNull();
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

  // ---- isInGroup derived field ----

  describe("isInGroup derived field", () => {
    it("findOne: ACTIVE member has isInGroup=true", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: {
          familyGroupId: group.id,
          email: "active@test.com",
          role: "member",
          status: "ACTIVE"
        }
      });

      const found = await service.findOne(group.id);
      const member = found.members.find((m: any) => m.email === "active@test.com");
      expect(member?.isInGroup).toBe(true);
    });

    it("findOne: PENDING member has isInGroup=false", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: {
          familyGroupId: group.id,
          email: "pending@test.com",
          role: "member",
          status: "PENDING"
        }
      });

      const found = await service.findOne(group.id);
      const member = found.members.find((m: any) => m.email === "pending@test.com");
      expect(member?.isInGroup).toBe(false);
    });

    it("findOne: REMOVED member is excluded from results", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: {
          familyGroupId: group.id,
          email: "removed@test.com",
          role: "member",
          status: "REMOVED"
        }
      });

      const found = await service.findOne(group.id);
      const member = found.members.find((m: any) => m.email === "removed@test.com");
      // REMOVED members are filtered out at query level (audit records, not active slots)
      expect(member).toBeUndefined();
    });

    it("getMembers: correctly maps isInGroup for mixed statuses", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.createMany({
        data: [
          { familyGroupId: group.id, email: "a@test.com", role: "member", status: "ACTIVE" },
          { familyGroupId: group.id, email: "b@test.com", role: "member", status: "PENDING" },
        ]
      });

      const members = await service.getMembers(group.id);
      const active = (members as any[]).find((m) => m.email === "a@test.com");
      const pending = (members as any[]).find((m) => m.email === "b@test.com");

      expect(active?.isInGroup).toBe(true);
      expect(pending?.isInGroup).toBe(false);
    });
  });

  // ---- Bulk operations ----

  describe("bulkRemove", () => {
    it("should queue emails for ACTIVE members and report notFound for unknown emails", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "active@test.com", role: "member", status: "ACTIVE" }
      });

      const result = await service.bulkRemove(group.id, ["active@test.com", "ghost@test.com"]);

      expect(result.queued).toContain("active@test.com");
      expect(result.notFound).toContain("ghost@test.com");
      expect(result.alreadyRemoved).toHaveLength(0);
    });

    it("should queue PENDING members for removal (not alreadyRemoved)", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "pending@test.com", role: "member", status: "PENDING" }
      });

      const result = await service.bulkRemove(group.id, ["pending@test.com"]);

      // PENDING members are now removable (invited-not-yet-accepted)
      expect(result.queued).toContain("pending@test.com");
      expect(result.alreadyRemoved).toHaveLength(0);
    });

    it("should deduplicate email casing", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "user@test.com", role: "member", status: "ACTIVE" }
      });

      // Uppercase variant normalised to same email
      const result = await service.bulkRemove(group.id, ["USER@TEST.COM"]);
      expect(result.queued).toContain("user@test.com");
    });

    it("should throw for nonexistent group", async () => {
      await expect(service.bulkRemove("nonexistent", ["a@test.com"])).rejects.toThrow(
        "Family group not found"
      );
    });
  });

  describe("bulkInvite", () => {
    it("should queue emails when slots are available", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 5 });

      const result = await service.bulkInvite(group.id, ["a@test.com", "b@test.com"]);

      expect(result.queued).toHaveLength(2);
      expect(result.rejected).toHaveLength(0);
      expect(result.reason).toBeUndefined();
    });

    it("should reject all emails when slots are insufficient", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 1 });

      const result = await service.bulkInvite(group.id, ["a@test.com", "b@test.com"]);

      expect(result.queued).toHaveLength(0);
      expect(result.rejected).toHaveLength(2);
      expect(result.reason).toMatch(/Not enough slots/);
    });

    it("should deduplicate input emails", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 5 });

      // Same email twice — should only enqueue once
      const result = await service.bulkInvite(group.id, ["dup@test.com", "DUP@TEST.COM"]);
      expect(result.queued).toHaveLength(1);
      expect(result.queued[0]).toBe("dup@test.com");
    });

    it("should throw for nonexistent group", async () => {
      await expect(service.bulkInvite("nonexistent", ["a@test.com"])).rejects.toThrow(
        "Family group not found"
      );
    });
  });

  describe("getTasks", () => {
    it("should return tasks filtered by type", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.task.createMany({
        data: [
          { type: "REMOVE_MEMBER", familyGroupId: group.id, accountId: account.id },
          { type: "INVITE_MEMBER", familyGroupId: group.id, accountId: account.id }
        ]
      });

      const removeTasks = await service.getTasks(group.id, { type: "REMOVE_MEMBER" });
      expect(removeTasks.every((t) => t.type === "REMOVE_MEMBER")).toBe(true);
    });

    it("should filter by since ISO8601 date", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.task.create({
        data: { type: "SYNC_FAMILY_GROUP", familyGroupId: group.id, accountId: account.id }
      });

      // since = future date should return empty
      const future = new Date(Date.now() + 60_000).toISOString();
      const empty = await service.getTasks(group.id, { since: future });
      expect(empty).toHaveLength(0);
    });

    it("should throw for nonexistent group", async () => {
      await expect(service.getTasks("bad-id", {})).rejects.toThrow("Family group not found");
    });
  });

  // ---- Cross-group bulk operations ----

  describe("crossBulkRemove", () => {
    it("should auto-discover groups and queue ACTIVE members", async () => {
      const account = await createTestAccount();
      const groupA = await createTestFamilyGroup(account.id);
      const groupB = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.createMany({
        data: [
          { familyGroupId: groupA.id, email: "a@test.com", role: "member", status: "ACTIVE" },
          { familyGroupId: groupB.id, email: "b@test.com", role: "member", status: "ACTIVE" }
        ]
      });

      const result = await service.crossBulkRemove(["a@test.com", "b@test.com", "ghost@test.com"]);

      expect(result.queued).toHaveLength(2);
      expect(result.queued).toContain("a@test.com");
      expect(result.queued).toContain("b@test.com");
      expect(result.notFound).toContain("ghost@test.com");
      expect(result.alreadyRemoved).toHaveLength(0);
    });

    it("should report alreadyRemoved for non-ACTIVE members", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "removed@test.com", role: "member", status: "REMOVED" }
      });

      const result = await service.crossBulkRemove(["removed@test.com"]);
      expect(result.alreadyRemoved).toContain("removed@test.com");
      expect(result.queued).toHaveLength(0);
    });

    it("should deduplicate emails (case-insensitive)", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "user@test.com", role: "member", status: "ACTIVE" }
      });

      // Submit same email twice with different casing
      const result = await service.crossBulkRemove(["USER@TEST.COM", "user@test.com"]);
      expect(result.queued).toHaveLength(1);
    });

    it("should return all as notFound when no members exist", async () => {
      const result = await service.crossBulkRemove(["nobody@test.com"]);
      expect(result.notFound).toContain("nobody@test.com");
      expect(result.queued).toHaveLength(0);
    });
  });

  describe("crossBulkInvite", () => {
    it("should distribute emails across available groups", async () => {
      const account = await createTestAccount();
      // Two groups each with 2 slots
      await createTestFamilyGroup(account.id, { availableSlots: 2 });
      await createTestFamilyGroup(account.id, { availableSlots: 2 });

      const result = await service.crossBulkInvite(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);

      const totalQueued = result.allocated.reduce((s, a) => s + a.queued.length, 0);
      expect(totalQueued).toBe(4);
      expect(result.unplaceable).toHaveLength(0);
      // Should have used 2 groups
      expect(result.allocated).toHaveLength(2);
    });

    it("should report unplaceable when total slots are insufficient", async () => {
      const account = await createTestAccount();
      await createTestFamilyGroup(account.id, { availableSlots: 1 });

      const result = await service.crossBulkInvite(["a@x.com", "b@x.com", "c@x.com"]);

      const totalQueued = result.allocated.reduce((s, a) => s + a.queued.length, 0);
      expect(totalQueued).toBe(1);
      expect(result.unplaceable).toHaveLength(2);
      expect(result.reason).toMatch(/could not be placed/);
    });

    it("should return all unplaceable when no available groups", async () => {
      // No groups created — zero slots
      const result = await service.crossBulkInvite(["a@x.com"]);
      expect(result.allocated).toHaveLength(0);
      expect(result.unplaceable).toContain("a@x.com");
      expect(result.reason).toMatch(/No available slots/);
    });
  });

  // ---- R2 bug-fix regression tests ----

  describe("bulkInvite (R2: slot rollback)", () => {
    it("should release slot back to pool when queue.add throws", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 1 });
      const db = getPrisma();

      // Force inviteQueue.add to throw on first call
      (service as any).inviteQueue.add = vi.fn().mockRejectedValueOnce(new Error("Redis down"));

      const result = await service.bulkInvite(group.id, ["fail@test.com"]);

      expect(result.rejected).toContain("fail@test.com");
      expect(result.queued).toHaveLength(0);

      // Slot should have been restored
      const freshGroup = await db.familyGroup.findUnique({ where: { id: group.id }, select: { availableSlots: true } });
      expect(freshGroup?.availableSlots).toBe(1); // back to original
    });
  });

  describe("bulkRemove (R2: PENDING rollback)", () => {
    it("should roll back member to ACTIVE when queue.add throws", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "rollback@test.com", role: "member", status: "ACTIVE" }
      });

      // Force removeQueue.add to throw
      (service as any).removeQueue.add = vi.fn().mockRejectedValueOnce(new Error("Redis down"));

      const result = await service.bulkRemove(group.id, ["rollback@test.com"]);

      // Should not be in queued (treated as failed)
      expect(result.queued).toHaveLength(0);

      // Member status must be back to ACTIVE (not stuck as PENDING)
      const member = await db.familyMember.findFirst({ where: { email: "rollback@test.com" } });
      expect(member?.status).toBe("ACTIVE");
    });
  });

  describe("getTasks (R2: invalid since)", () => {
    it("should throw 400 BadRequestException for non-ISO8601 'since'", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);

      await expect(service.getTasks(group.id, { since: "not-a-date" }))
        .rejects.toThrow("Invalid 'since' date");
    });
  });

  describe("crossBulkRemove (R2: truly absent vs removed)", () => {
    it("should report removed-only emails as alreadyRemoved, not notFound", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      // email only has a REMOVED record
      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "exmember@test.com", role: "member", status: "REMOVED" }
      });

      const result = await service.crossBulkRemove(["exmember@test.com", "truly-absent@test.com"]);

      expect(result.alreadyRemoved).toContain("exmember@test.com");
      expect(result.notFound).toContain("truly-absent@test.com");
      // Should NOT be in notFound
      expect(result.notFound).not.toContain("exmember@test.com");
    });
  });

  // ---- R3 bug-fix regression tests ----

  describe("bulkRemove (R3: dedup)", () => {
    it("should deduplicate duplicate emails in input, not double-process", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "dup@test.com", role: "member", status: "ACTIVE" }
      });

      // Send same email twice
      const result = await service.bulkRemove(group.id, ["dup@test.com", "DUP@TEST.COM"]);

      // Should only be queued once, not appear in alreadyRemoved
      expect(result.queued).toHaveLength(1);
      expect(result.queued[0]).toBe("dup@test.com");
      expect(result.alreadyRemoved).toHaveLength(0);
    });
  });

  describe("getTasks (R3: unknown type)", () => {
    it("should throw 400 BadRequestException for unknown task type", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id);

      await expect(service.getTasks(group.id, { type: "INVALID_TYPE" }))
        .rejects.toThrow("Unknown task type");
    });
  });

  describe("crossBulkInvite (R3: skip existing members)", () => {
    it("should not re-invite emails that already have ACTIVE member status", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 5 });
      const db = getPrisma();

      // existing@test.com is already an ACTIVE member
      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "existing@test.com", role: "member", status: "ACTIVE" }
      });

      // Create another group with slots for the new invite
      await createTestFamilyGroup(account.id, { availableSlots: 5 });

      const result = await service.crossBulkInvite(["existing@test.com", "fresh@test.com"]);

      const allQueued = result.allocated.flatMap((a) => a.queued);
      // existing member should NOT be re-invited
      expect(allQueued).not.toContain("existing@test.com");
      // fresh email should be placed
      expect(allQueued).toContain("fresh@test.com");
    });

    it("should return early if all emails are already active members", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 5 });
      const db = getPrisma();

      await db.familyMember.create({
        data: { familyGroupId: group.id, email: "all-existing@test.com", role: "member", status: "ACTIVE" }
      });

      const result = await service.crossBulkInvite(["all-existing@test.com"]);

      expect(result.allocated).toHaveLength(0);
      expect(result.unplaceable).toHaveLength(0);
      expect(result.reason).toMatch(/already active members/);
    });
  });
});
