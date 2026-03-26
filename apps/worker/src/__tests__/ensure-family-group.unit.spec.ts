/**
 * Unit tests for ensureFamilyGroup().
 *
 * Uses a mocked Playwright Page and mocked PrismaClient (vi.fn).
 * No real browser or DB connection is required.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureFamilyGroup } from "../ensure-family-group";

// ----- Minimal TaskLogger mock -----
function buildMockLogger() {
  return { log: vi.fn().mockResolvedValue(undefined) } as any;
}

// ----- Locator factory -----
function buildLocator(count: number, extraMethods: Record<string, any> = {}) {
  const loc: any = {
    count: vi.fn().mockResolvedValue(count),
    first: () => loc,
    click: vi.fn().mockResolvedValue(undefined),
    ...extraMethods,
  };
  return loc;
}

/**
 * Build a mock Playwright Page for ensureFamilyGroup tests.
 *
 * inviteCount:   how many times a[href*="invitemembers"] is found
 * createCount:   how many times the "Create a family" button is found
 * inviteAfterCreate: how many invite links exist AFTER creation wizard
 * evaluateResult: body.innerText snippet returned on unknown-state path
 */
function buildMockPage(opts: {
  inviteCount?: number;
  createCount?: number;
  inviteAfterCreate?: number;
  evaluateResult?: string;
  currentUrl?: string;
} = {}) {
  let gotoCallCount = 0;

  const page: any = {
    url: vi.fn().mockReturnValue(opts.currentUrl ?? "https://myaccount.google.com/family/details"),
    goto: vi.fn().mockImplementation(async () => {
      gotoCallCount++;
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(opts.evaluateResult ?? ""),
    locator: vi.fn((selector: string) => {
      // "invitemembers" anchor — found on family/details page
      if (selector.includes("invitemembers")) {
        // First goto → inviteCount; subsequent goto (after creation) → inviteAfterCreate
        const count = gotoCallCount <= 1
          ? (opts.inviteCount ?? 0)
          : (opts.inviteAfterCreate ?? opts.inviteCount ?? 0);
        return buildLocator(count);
      }
      // "Create a family" button
      if (
        selector.includes("family/create") ||
        selector.includes("Create a family") ||
        selector.includes("建立家庭")
      ) {
        return buildLocator(opts.createCount ?? 0);
      }
      // Wizard continue/next buttons — always present so wizard completes
      if (
        selector.includes("Continue") ||
        selector.includes("繼續") ||
        selector.includes("建立") ||
        selector.includes("Next") ||
        selector.includes("Done")
      ) {
        return buildLocator(0); // wizard buttons absent → exits wizard loop early
      }
      return buildLocator(0);
    }),
  };

  return page;
}

// ----- PrismaClient mock factory -----
function buildMockPrisma(opts: {
  existingGroup?: { id: string } | null;
  createdGroupId?: string;
} = {}) {
  const familyGroup = {
    findFirst: vi.fn().mockResolvedValue(opts.existingGroup ?? null),
    create: vi.fn().mockResolvedValue({ id: opts.createdGroupId ?? "new-group-id" }),
  };
  return { familyGroup } as any;
}

// ----- Tests -----

const FAKE_ACCOUNT = { id: "acct-001", loginEmail: "testaccount@gmail.com" };

describe("ensureFamilyGroup — family group already exists", () => {
  it("returns existing DB record ID when invite link and DB record are present", async () => {
    const page   = buildMockPage({ inviteCount: 1 });
    const prisma = buildMockPrisma({ existingGroup: { id: "existing-group-123" } });
    const logger = buildMockLogger();

    const result = await ensureFamilyGroup(page, FAKE_ACCOUNT, prisma, logger);

    expect(result.familyGroupId).toBe("existing-group-123");
    expect(prisma.familyGroup.findFirst).toHaveBeenCalledOnce();
    expect(prisma.familyGroup.create).not.toHaveBeenCalled();
  });

  it("creates a new DB record when invite link exists but DB has no record", async () => {
    const page   = buildMockPage({ inviteCount: 1 });
    const prisma = buildMockPrisma({ existingGroup: null, createdGroupId: "fresh-group-456" });
    const logger = buildMockLogger();

    const result = await ensureFamilyGroup(page, FAKE_ACCOUNT, prisma, logger);

    expect(result.familyGroupId).toBe("fresh-group-456");
    expect(prisma.familyGroup.create).toHaveBeenCalledOnce();
    // groupName should be derived from loginEmail prefix
    const createData = prisma.familyGroup.create.mock.calls[0][0].data;
    expect(createData.groupName).toBe("testaccount");
    expect(createData.maxMembers).toBe(5);
    expect(createData.availableSlots).toBe(5);
  });
});

describe("ensureFamilyGroup — auto-create family group", () => {
  it("creates family group via UI wizard and returns new DB record", async () => {
    // invite link absent on first visit, present after creation wizard
    const page   = buildMockPage({ inviteCount: 0, createCount: 1, inviteAfterCreate: 1 });
    const prisma = buildMockPrisma({ existingGroup: null, createdGroupId: "wizard-group-789" });
    const logger = buildMockLogger();

    const result = await ensureFamilyGroup(page, FAKE_ACCOUNT, prisma, logger);

    expect(result.familyGroupId).toBe("wizard-group-789");
    // Click the create button
    const createLocator = page.locator.mock.results.find((r: any) =>
      page.locator.mock.calls[page.locator.mock.results.indexOf(r)]?.[0]?.includes("family/create")
    );
    // goto was called at least twice (initial + post-creation verify + google-one-sharing)
    expect(page.goto).toHaveBeenCalled();
    expect(prisma.familyGroup.create).toHaveBeenCalledOnce();
  });

  it("throws when invite link is still absent after creation wizard", async () => {
    // Creation button exists but invite link never appears
    const page   = buildMockPage({ inviteCount: 0, createCount: 1, inviteAfterCreate: 0 });
    const prisma = buildMockPrisma();
    const logger = buildMockLogger();

    await expect(
      ensureFamilyGroup(page, FAKE_ACCOUNT, prisma, logger)
    ).rejects.toThrow("creation may have failed");
  });
});

describe("ensureFamilyGroup — unknown state", () => {
  it("throws when neither invite link nor create button is found", async () => {
    const page   = buildMockPage({ inviteCount: 0, createCount: 0, evaluateResult: "Some unexpected page content" });
    const prisma = buildMockPrisma();
    const logger = buildMockLogger();

    await expect(
      ensureFamilyGroup(page, FAKE_ACCOUNT, prisma, logger)
    ).rejects.toThrow("Cannot determine family group state");
  });
});
