/**
 * entitlement-sync.service.spec.ts — shadow-record sync into access-keys.json.
 *
 * Uses a real RosettaService (the single file writer) over a tmp dataDir, the
 * real shared AccessKeyStore, stub pool reloaders, and a stub Prisma.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntitlementSyncService } from "../entitlement-sync.service";
import { RosettaService } from "../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import { cardIdSessionResolver, sessionReqFor } from "../../token-server/__tests__/session-test-util";

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let accessKeysPath: string;

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readKeys(): any[] {
  return JSON.parse(fs.readFileSync(accessKeysPath, "utf8")).keys;
}

function makeSub(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: overrides.id ?? "sub-test-1",
    customerId: overrides.customerId ?? "cust-1",
    planId: overrides.planId === undefined ? "plan-1" : overrides.planId,
    status: overrides.status ?? "ACTIVE",
    startsAt: overrides.startsAt ?? new Date(),
    expiresAt: overrides.expiresAt === undefined ? new Date(Date.now() + 30 * DAY_MS) : overrides.expiresAt,
    productEntitlements: overrides.productEntitlements ?? JSON.stringify(["antigravity"]),
    bucketLimits: overrides.bucketLimits ?? JSON.stringify({ "antigravity-gemini": 1_000_000 }),
    bindings: overrides.bindings ?? null,
    levels: overrides.levels ?? JSON.stringify({ antigravity: "ultra" }),
    weight: overrides.weight ?? 2,
    deviceLimit: overrides.deviceLimit ?? 3,
    weeklyTokenLimit: overrides.weeklyTokenLimit === undefined ? 5_000_000 : overrides.weeklyTokenLimit,
    windowMs: overrides.windowMs ?? 18_000_000,
    backingKeyValue: overrides.backingKeyValue ?? "sub_" + "a".repeat(48),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

describe("EntitlementSyncService", () => {
  let rosetta: RosettaService;
  let store: AccessKeyStore;
  let reloads: { tokenServer: any; remoteCodex: any; remoteAnthropic: any };
  let prismaStub: any;
  let service: EntitlementSyncService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entitlement-sync-"));
    accessKeysPath = path.join(tmpDir, "access-keys.json");
    writeJson(accessKeysPath, { keys: [], updatedAt: "" });
    // antigravity pool with one bindable ultra account (4 free shares by the
    // BCAI_ACCOUNT_SHARE_CAPACITY=4 test env).
    writeJson(path.join(tmpDir, "accounts.json"), {
      accounts: [
        { id: 7, email: "ultra@pool.test", refreshToken: "rt", enabled: true, projectId: "proj-7", planType: "ultra" },
      ],
    });

    rosetta = new RosettaService({ dataDir: tmpDir });
    store = new AccessKeyStore(accessKeysPath);
    store.setSessionResolver(cardIdSessionResolver);
    reloads = {
      tokenServer: { reloadAccessKeys: vi.fn(() => store.reload()) },
      remoteCodex: { reloadAccessKeys: vi.fn() },
      remoteAnthropic: { reloadAccessKeys: vi.fn() },
    };
    prismaStub = {
      customer: { findUnique: vi.fn(async () => ({ email: "user@example.com" })) },
      subscription: { update: vi.fn(async (args: any) => args) },
    };
    service = new EntitlementSyncService(
      rosetta,
      store,
      reloads.tokenServer,
      reloads.remoteCodex,
      reloads.remoteAnthropic,
      prismaStub,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("new sub → shadow record in the file with id/key/limits/weight/window/expiry + pool reloads", async () => {
    const sub = makeSub();
    await service.syncSubscription(sub, { customerEmail: "user@example.com" });

    const keys = readKeys();
    expect(keys).toHaveLength(1);
    const record = keys[0];
    expect(record.id).toBe(sub.id);
    expect(record.key).toBe(sub.backingKeyValue);
    expect(record.name).toBe("订阅:user@example.com");
    expect(record.status).toBe("active");
    expect(record.bucketLimits).toEqual({ "antigravity-gemini": 1_000_000 });
    expect(record.weight).toBe(2);
    expect(record.windowMs).toBe(18_000_000);
    expect(record.weeklyTokenLimit).toBe(5_000_000);
    expect(record.keyExpiresAt).toBe(sub.expiresAt.toISOString());
    expect(record.products).toEqual(["antigravity"]);

    expect(reloads.tokenServer.reloadAccessKeys).toHaveBeenCalledTimes(1);
    expect(reloads.remoteCodex.reloadAccessKeys).toHaveBeenCalledTimes(1);
    expect(reloads.remoteAnthropic.reloadAccessKeys).toHaveBeenCalledTimes(1);

    // The shared store sees the record after reload.
    expect(store.findByKey(sub.backingKeyValue)?.id).toBe(sub.id);
  });

  it("new plan-backed sub auto-assigns a seat per product and persists the bindings snapshot", async () => {
    const sub = makeSub();
    await service.syncSubscription(sub);

    const record = readKeys()[0];
    expect(record.bindings).toEqual({ antigravity: 7 });
    expect(prismaStub.subscription.update).toHaveBeenCalledWith({
      where: { id: sub.id },
      data: { bindings: JSON.stringify({ antigravity: 7 }) },
    });
  });

  it("seat-assignment failure logs loudly and leaves the product unbound — sync still succeeds, record marked requiresBinding", async () => {
    // Pool has no "premium" account → assignment fails for antigravity.
    const sub = makeSub({ levels: JSON.stringify({ antigravity: "premium" }) });
    await expect(service.syncSubscription(sub)).resolves.toBeUndefined();

    const record = readKeys()[0];
    expect(record.bindings).toEqual({});
    expect(record.status).toBe("active");
    // M13b: binding-less plan-backed record must NOT fall through to the broad
    // dynamic pool — the flag makes LeaseService deny instead.
    expect(record.requiresBinding).toBe(true);
  });

  it("plan-backed sub → requiresBinding true; planId-null sub (migrated legacy card) → flag NOT set", async () => {
    await service.syncSubscription(makeSub({ id: "sub-plan", backingKeyValue: "sub_" + "e".repeat(48) }));
    await service.syncSubscription(
      makeSub({ id: "sub-legacy", planId: null, levels: null, expiresAt: null, backingKeyValue: "sub_" + "f".repeat(48) }),
    );

    const keys = readKeys();
    const planRecord = keys.find((k: any) => k.id === "sub-plan");
    const legacyRecord = keys.find((k: any) => k.id === "sub-legacy");
    expect(planRecord.requiresBinding).toBe(true);
    // Migrated legacy cards are POOL cards by design — they must keep leasing
    // from the dynamic pool, so the flag must never appear on them.
    expect(legacyRecord.requiresBinding).toBeUndefined();
  });

  it("extend → expiry updated, usage counters and in-memory window events untouched", async () => {
    const sub = makeSub();
    await service.syncSubscription(sub);

    // Record real usage through the shared store (counters + window events).
    expect(store.recordUsage(sub.id, 200, { totalTokens: 500 }, "gemini-2.5-pro", "r1", "antigravity")).toBe(true);
    store.flush();
    const before = readKeys()[0];
    expect(before.totalRequests).toBe(1);
    const usedBefore = before.totalTokensUsed;
    expect(usedBefore).toBeGreaterThan(0);

    const newExpiry = new Date(Date.now() + 60 * DAY_MS);
    await service.syncSubscription({ ...sub, expiresAt: newExpiry });

    const after = readKeys()[0];
    expect(after.keyExpiresAt).toBe(newExpiry.toISOString());
    expect(after.totalRequests).toBe(1);
    expect(after.totalTokensUsed).toBe(usedBefore);
    // In-memory window events survive the reload (carried by id).
    expect(store.findById(sub.id)?.tokenUsageEvents?.length).toBe(1);
  });

  it("extend re-applies the snapshot bindings without re-assigning seats", async () => {
    const sub = makeSub();
    await service.syncSubscription(sub);
    prismaStub.subscription.update.mockClear();

    // Resync with the persisted snapshot (as the DB row would carry it).
    await service.syncSubscription({ ...sub, bindings: JSON.stringify({ antigravity: 7 }) });

    expect(readKeys()[0].bindings).toEqual({ antigravity: 7 });
    // No second seat assignment / snapshot write.
    expect(prismaStub.subscription.update).not.toHaveBeenCalled();
  });

  it("null expiresAt leaves keyExpiresAt unset", async () => {
    const sub = makeSub({ planId: null, expiresAt: null, levels: null });
    await service.syncSubscription(sub);

    const record = readKeys()[0];
    expect(record.keyExpiresAt).toBeUndefined();
  });

  it("expireShadowRecord → status expired, record + usage retained, pools reloaded", async () => {
    const sub = makeSub();
    await service.syncSubscription(sub);
    store.recordUsage(sub.id, 200, { totalTokens: 500 }, "gemini-2.5-pro", "r1", "antigravity");
    store.flush();
    const usedBefore = readKeys()[0].totalTokensUsed;
    reloads.tokenServer.reloadAccessKeys.mockClear();

    service.expireShadowRecord(sub.id);

    const record = readKeys()[0];
    expect(record.status).toBe("expired");
    expect(record.totalTokensUsed).toBe(usedBefore);
    expect(record.key).toBe(sub.backingKeyValue);
    expect(reloads.tokenServer.reloadAccessKeys).toHaveBeenCalledTimes(1);

    // An expired shadow record no longer resolves (session path).
    const resolved = await store.resolveFromRequest(sessionReqFor(sub.id), {});
    expect(resolved.record).toBeNull();
  });

  it("expireShadowRecord on a missing record warns and does not reload", () => {
    service.expireShadowRecord("ghost-sub");
    expect(reloads.tokenServer.reloadAccessKeys).not.toHaveBeenCalled();
  });

  // ── Terminal subscriptions release upstream seat capacity ─────────────────
  // The seat is released by share ACCOUNTING (non-active records' bindings stop
  // counting), not by mutating the terminal record — its bindings stay as history.

  it("expireShadowRecord releases the seat: a NEW plan sync assigns the freed share; the expired record keeps its bindings", async () => {
    // subA (weight 4) fills account 7 to capacity (4 in the test env).
    const subA = makeSub({ id: "sub-full", weight: 4, backingKeyValue: "sub_" + "1".repeat(48) });
    await service.syncSubscription(subA);
    expect(readKeys().find((k: any) => k.id === "sub-full").bindings).toEqual({ antigravity: 7 });
    // 0 free shares → the seat probe finds nothing.
    expect(rosetta.assignSeatForProduct("antigravity", 1, "ultra")).toBeNull();

    service.expireShadowRecord(subA.id);
    const expired = readKeys().find((k: any) => k.id === "sub-full");
    expect(expired.status).toBe("expired");
    expect(expired.bindings).toEqual({ antigravity: 7 }); // history retained

    // The share is free again → a NEW plan sync binds the freed seat.
    expect(rosetta.assignSeatForProduct("antigravity", 1, "ultra")).toBe(7);
    const subB = makeSub({ id: "sub-next", weight: 1, backingKeyValue: "sub_" + "2".repeat(48) });
    await service.syncSubscription(subB);
    const next = readKeys().find((k: any) => k.id === "sub-next");
    expect(next.bindings).toEqual({ antigravity: 7 });
  });

  it("a seat HELD by an active sub still counts (new sync starved + requiresBinding guard intact); after expiry the freed seat is reused and the expired record never resolves", async () => {
    const subA = makeSub({ id: "sub-holder", weight: 4, backingKeyValue: "sub_" + "3".repeat(48) });
    await service.syncSubscription(subA);

    // ACTIVE seats are not double-allocated: account full → the new sub gets NO
    // seat and carries the M13b deny flag (seat-exhaustion guard, not pool access).
    const subB = makeSub({ id: "sub-starved", weight: 1, backingKeyValue: "sub_" + "4".repeat(48) });
    await service.syncSubscription(subB);
    const starved = readKeys().find((k: any) => k.id === "sub-starved");
    expect(starved.bindings).toEqual({});
    expect(starved.requiresBinding).toBe(true);

    // Terminal holder → the whole 4-share seat is reusable by a new sub.
    service.expireShadowRecord(subA.id);
    const subC = makeSub({ id: "sub-reuse", weight: 4, backingKeyValue: "sub_" + "5".repeat(48) });
    await service.syncSubscription(subC);
    expect(readKeys().find((k: any) => k.id === "sub-reuse").bindings).toEqual({ antigravity: 7 });

    // The expired record whose seat was reassigned can NEVER serve again
    // (status gates the resolve path).
    const resolved = await store.resolveFromRequest(sessionReqFor(subA.id), {});
    expect(resolved.record).toBeNull();
  });

  // ── M13b: writer serialization over access-keys.json ──────────────────────

  it("two CONCURRENT plan syncs competing for the last free shares → exactly one gets the seat, never both (no overcommit past capacity)", async () => {
    // Capacity is 4 (BCAI_ACCOUNT_SHARE_CAPACITY=4 in the test env) and the
    // pool has ONE ultra account (id 7). Two weight-3 subscriptions cannot
    // both fit: without serialization both seat computations read "4 free"
    // before either write lands, double-booking the account to 6/4.
    const subA = makeSub({ id: "sub-race-a", weight: 3, backingKeyValue: "sub_" + "a".repeat(48) });
    const subB = makeSub({ id: "sub-race-b", weight: 3, backingKeyValue: "sub_" + "b".repeat(48) });

    await Promise.all([
      service.syncSubscription(subA, { customerEmail: "a@example.com" }),
      service.syncSubscription(subB, { customerEmail: "b@example.com" }),
    ]);

    const keys = readKeys();
    expect(keys).toHaveLength(2);
    const bound = keys.filter((k: any) => Number(k?.bindings?.antigravity) === 7);
    // Exactly ONE winner; the loser is left unbound (logged loudly), NOT
    // double-booked onto the same account.
    expect(bound).toHaveLength(1);
    const totalShares = bound.reduce((sum: number, k: any) => sum + Number(k.weight || 1), 0);
    expect(totalShares).toBeLessThanOrEqual(4); // ACCOUNT_SHARE_CAPACITY (test env)
  });

  it("two CONCURRENT syncs for different subscriptions lose neither write (both records + both seats present)", async () => {
    const subA = makeSub({ id: "sub-par-a", weight: 1, backingKeyValue: "sub_" + "c".repeat(48) });
    const subB = makeSub({ id: "sub-par-b", weight: 1, backingKeyValue: "sub_" + "d".repeat(48) });

    await Promise.all([
      service.syncSubscription(subA, { customerEmail: "a@example.com" }),
      service.syncSubscription(subB, { customerEmail: "b@example.com" }),
    ]);

    const keys = readKeys();
    const ids = keys.map((k: any) => k.id).sort();
    expect(ids).toEqual(["sub-par-a", "sub-par-b"]);
    // Both fit (1+1 ≤ 4) → both seated on account 7, shares accounted exactly.
    for (const key of keys) expect(key.bindings).toEqual({ antigravity: 7 });
  });
});
