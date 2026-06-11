/**
 * Tests for subscription-aware admin cleanup methods.
 *
 * Bug being fixed: cleanupUnboundKeys and cleanupExpiredKeys deleted shadow
 * AccessKey records that back active customer subscriptions, because those
 * records have no sessionClientId (shadow records skip per-card sessions) and
 * migrated-card records can appear time-expired while still being a customer's
 * history-bearing subscription.
 *
 * Fix: both methods exclude records that are:
 *   (a) present in the current Subscription table (id match), OR
 *   (b) migrated-card records (migratedToCustomerId set).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccessKeyService } from "../access-key.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("cleanupUnboundKeys — subscription-aware", () => {
  let dataDir: string;
  let filePath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-cleanup-sub-"));
    filePath = path.join(dataDir, "access-keys.json");
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("does NOT delete a shadow record whose id equals a Subscription id (no sessionClientId)", async () => {
    const subscriptionId = "sub_abc123";

    writeJson(filePath, {
      keys: [
        // Shadow record: id == Subscription.id, no sessionClientId
        { id: subscriptionId, key: "bcai_shadow_key", name: "订阅:customer@example.com", status: "active" },
        // Genuine orphan admin card: no subscription, no migration, no sessionClientId → must be deleted
        { id: "card_orphan_1", key: "bcai_orphan_key", name: "Orphan card", status: "active" },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    const result = await svc.cleanupUnboundKeys(new Set([subscriptionId]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toContain(subscriptionId); // shadow record kept
    expect(remainingIds).not.toContain("card_orphan_1"); // orphan deleted
  });

  it("does NOT delete a migrated card record (migratedToCustomerId set, no sessionClientId)", async () => {
    writeJson(filePath, {
      keys: [
        // Migrated card: migratedToCustomerId set → kept regardless of sessionClientId
        {
          id: "card_migrated_1",
          key: "sub_abc_backing_key",
          name: "Migrated card",
          status: "active",
          migratedToCustomerId: "cust_xyz",
          migratedAt: new Date().toISOString(),
        },
        // Genuine orphan admin card: no subscription, no migration, no sessionClientId → must be deleted
        { id: "card_orphan_2", key: "bcai_orphan_2", name: "Orphan card 2", status: "active" },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    // No subscription IDs; the protection here comes from migratedToCustomerId
    const result = await svc.cleanupUnboundKeys(new Set([]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toContain("card_migrated_1"); // migrated record kept
    expect(remainingIds).not.toContain("card_orphan_2"); // orphan deleted
  });

  it("deletes a genuinely unbound admin card (no subscription, not migrated, no sessionClientId)", async () => {
    writeJson(filePath, {
      keys: [
        { id: "card_plain_1", key: "bcai_plain", name: "Plain card", status: "active" },
        { id: "card_with_client", key: "bcai_bound", name: "Bound card", status: "active", sessionClientId: "client-123" },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    const result = await svc.cleanupUnboundKeys(new Set([]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toContain("card_with_client");
    expect(remainingIds).not.toContain("card_plain_1");
  });

  it("handles combination: subscription shadow + migrated + sessionClientId card + orphan", async () => {
    const subId = "sub_combo";

    writeJson(filePath, {
      keys: [
        // Shadow subscription record — KEEP
        { id: subId, key: "bcai_shadow", name: "Subscription shadow", status: "active" },
        // Migrated card — KEEP
        { id: "card_mig", key: "sub_mig_key", name: "Migrated", status: "active", migratedToCustomerId: "cust_1" },
        // Card with sessionClientId — KEEP
        { id: "card_sess", key: "bcai_sess", name: "With client", status: "active", sessionClientId: "client-xyz" },
        // Orphan admin card — DELETE
        { id: "card_orphan", key: "bcai_orp", name: "Orphan", status: "active" },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    const result = await svc.cleanupUnboundKeys(new Set([subId]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toEqual(expect.arrayContaining([subId, "card_mig", "card_sess"]));
    expect(remainingIds).not.toContain("card_orphan");
  });
});

describe("cleanupExpiredKeys — subscription-aware", () => {
  let dataDir: string;
  let filePath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-cleanup-exp-sub-"));
    filePath = path.join(dataDir, "access-keys.json");
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("does NOT delete an expired migrated card record (migratedToCustomerId set)", async () => {
    const now = Date.now();

    writeJson(filePath, {
      keys: [
        // Expired migrated card: has migratedToCustomerId → KEEP (history-bearing)
        {
          id: "card_expired_mig",
          key: "sub_expired_key",
          name: "Expired migrated",
          status: "active",
          migratedToCustomerId: "cust_abc",
          migratedAt: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(),
          firstUsedAt: new Date(now - 7200000).toISOString(),
          durationMs: 3600000, // expired 1 hour ago
        },
        // Expired plain admin card: no migration, no subscription → DELETE
        {
          id: "card_expired_plain",
          key: "bcai_expired_plain",
          name: "Expired plain",
          status: "active",
          firstUsedAt: new Date(now - 7200000).toISOString(),
          durationMs: 3600000,
        },
        // Active card — KEEP
        {
          id: "card_active",
          key: "bcai_active",
          name: "Active",
          status: "active",
          firstUsedAt: new Date(now - 1800000).toISOString(),
          durationMs: 3600000,
        },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    const result = await svc.cleanupExpiredKeys(new Set([]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toContain("card_expired_mig"); // migrated, kept despite expiry
    expect(remainingIds).not.toContain("card_expired_plain"); // plain expired, deleted
    expect(remainingIds).toContain("card_active");
  });

  it("does NOT delete an expired subscription shadow record (id in subscription set)", async () => {
    const now = Date.now();
    const subId = "sub_expired_shadow";

    writeJson(filePath, {
      keys: [
        // Expired subscription shadow — KEEP (subscription system owns expiry)
        {
          id: subId,
          key: "bcai_shadow_expired",
          name: "Expired shadow",
          status: "expired", // EntitlementSyncService marks it expired
        },
        // Genuinely expired plain card — DELETE
        {
          id: "card_expired_2",
          key: "bcai_exp2",
          name: "Expired plain 2",
          status: "expired",
        },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    const result = await svc.cleanupExpiredKeys(new Set([subId]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toContain(subId); // subscription shadow, kept
    expect(remainingIds).not.toContain("card_expired_2"); // plain expired, deleted
  });

  it("deletes an expired plain admin card (no subscription, not migrated)", async () => {
    const now = Date.now();

    writeJson(filePath, {
      keys: [
        {
          id: "card_exp_plain",
          key: "bcai_plain_exp",
          name: "Plain expired",
          status: "active",
          firstUsedAt: new Date(now - 7200000).toISOString(),
          durationMs: 3600000,
        },
        {
          id: "card_still_active",
          key: "bcai_still",
          name: "Still active",
          status: "active",
        },
      ],
    });

    const svc = new AccessKeyService(
      { dataDir, accessKeysFile: { read: () => readJson(filePath) } } as any,
    );
    const result = await svc.cleanupExpiredKeys(new Set([]));

    expect(result).toMatchObject({ ok: true, deleted: 1 });

    const remaining = readJson(filePath);
    const remainingIds = remaining.keys.map((k: any) => k.id);
    expect(remainingIds).toContain("card_still_active");
    expect(remainingIds).not.toContain("card_exp_plain");
  });
});
