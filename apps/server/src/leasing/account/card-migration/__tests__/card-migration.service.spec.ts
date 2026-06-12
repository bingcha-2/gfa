/**
 * card-migration.service.spec.ts — bind-card migration against the real Prisma
 * test db + a real RosettaService writer + the real shared AccessKeyStore over
 * a tmp access-keys.json.
 *
 * The invariant under test: the SAME record (same id) is re-homed onto a
 * Subscription — usage counters, firstUsedAt, windows, and CardTokenUsage
 * attribution all carry over; only key/migrated* change.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CardMigrationService } from "../card-migration.service";
import { RosettaService } from "../../../rosetta/rosetta.service";
import { AccessKeyStore } from "../../../token-server/access-key-store";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let accessKeysPath: string;
let store: AccessKeyStore;
let rosetta: RosettaService;
let service: CardMigrationService;

function writeKeys(keys: any[]) {
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys, updatedAt: "" }, null, 2));
}

function readKeys(): any[] {
  return JSON.parse(fs.readFileSync(accessKeysPath, "utf8")).keys;
}

/** A well-used bound card: counters, firstUsedAt, window config, bindings. */
function usedCard(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "card-legacy-1",
    key: "BCAI-AAAA-BBBB",
    name: "老卡",
    status: "active",
    firstUsedAt: "2026-05-01T00:00:00.000Z",
    durationMs: 365 * DAY_MS,
    windowMs: 18_000_000,
    weeklyTokenLimit: 5_000_000,
    weight: 2,
    bucketLimits: { "antigravity-gemini": 1_000_000, "codex-gpt": 500_000 },
    bindings: { antigravity: 7, codex: 3 },
    totalRequests: 42,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCachedInputTokens: 100,
    totalRawTokensUsed: 1500,
    totalTokensUsed: 1450,
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  await prisma.cardTokenUsage.deleteMany();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "card-migration-"));
  accessKeysPath = path.join(tmpDir, "access-keys.json");
  writeKeys([]);

  rosetta = new RosettaService({ dataDir: tmpDir });
  store = new AccessKeyStore(accessKeysPath);
  service = new CardMigrationService(
    prisma as any,
    rosetta,
    store,
    { reloadAccessKeys: vi.fn(() => store.reload()) } as any,
    { reloadAccessKeys: vi.fn() } as any,
    { reloadAccessKeys: vi.fn() } as any,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BCAI_MIGRATED_CARD_DEVICE_LIMIT;
});

afterAll(async () => {
  await cleanCustomerTables();
  await prisma.cardTokenUsage.deleteMany();
  await disconnectCustomerDb();
});

describe("CardMigrationService.bindCard — migration", () => {
  it("re-homes the SAME record: Subscription.id == record id, key rotated, everything else byte-identical", async () => {
    const card = usedCard();
    writeKeys([card]);
    store.reload();
    const customer = await createTestCustomer();

    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");

    expect(result.ok).toBe(true);
    expect(result.subscription.id).toBe(card.id);
    expect(result.subscription.planName).toBeNull();

    const sub = await prisma.subscription.findUnique({ where: { id: card.id } });
    expect(sub).toBeTruthy();
    expect(sub!.customerId).toBe(customer.id);
    expect(sub!.planId).toBeNull();
    expect(sub!.status).toBe("ACTIVE");
    expect(sub!.backingKeyValue).toMatch(/^sub_[0-9a-f]{48}$/);
    expect(sub!.weight).toBe(2);
    expect(sub!.weeklyTokenLimit).toBe(5_000_000);
    expect(sub!.windowMs).toBe(18_000_000);
    expect(JSON.parse(sub!.bindings!)).toEqual({ antigravity: 7, codex: 3 });

    const after = readKeys()[0];
    // Rotated/added fields…
    expect(after.key).toBe(sub!.backingKeyValue);
    expect(after.migratedToCustomerId).toBe(customer.id);
    expect(after.migratedAt).toBeTruthy();
    expect(after.migratedFromKey).toBe("BCAI-AAAA-BBBB");
    // …and EVERYTHING else byte-identical (counters, firstUsedAt, windows, bindings).
    const { key: _k1, migratedToCustomerId: _m1, migratedAt: _m2, migratedFromKey: _m3, ...afterRest } = after;
    const { key: _k2, ...beforeRest } = card;
    expect(afterRest).toEqual(beforeRest);
  });

  it("old key string no longer finds the record; the new backing key does (byKey re-index)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();

    await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    const backing = readKeys()[0].key;

    // findByKey is the bind-card redemption lookup — it must keep working
    // (the card-string RUNTIME credential is gone; key VALUES still index).
    expect(store.findByKey("BCAI-AAAA-BBBB")).toBeNull();
    expect(store.findByKey(backing)?.id).toBe("card-legacy-1");
    // Neither key string is a runtime lease credential anymore.
    const oldAuth = await store.resolveFromRequest({ headers: { "x-access-key": "BCAI-AAAA-BBBB" } } as any, {});
    expect(oldAuth.record).toBeNull();
    expect(oldAuth.error).toBe("Missing access key");
    const newAuth = await store.resolveFromRequest({ headers: { authorization: `Bearer ${backing}` } } as any, {});
    expect(newAuth.record).toBeNull();
    expect(newAuth.error).toBe("Invalid access key");
  });

  it("expiresAt == keyExpiresAt(record) for a used card; null for a never-used card", async () => {
    const card = usedCard();
    writeKeys([card]);
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    const expected = new Date(Date.parse(card.firstUsedAt) + card.durationMs).toISOString();
    expect(result.subscription.expiresAt).toBe(expected);

    // Never-used card (no firstUsedAt) → null expiry until first use.
    writeKeys([usedCard({ id: "card-fresh", key: "BCAI-FRESH-0000", firstUsedAt: undefined })]);
    store.reload();
    const customer2 = await createTestCustomer();
    const fresh = await service.bindCard(customer2.id, "BCAI-FRESH-0000");
    expect(fresh.subscription.expiresAt).toBeNull();
    expect((await prisma.subscription.findUnique({ where: { id: "card-fresh" } }))!.expiresAt).toBeNull();
  });

  it("derives products from bindings + bucket prefixes for a bound card", async () => {
    writeKeys([usedCard()]); // bindings antigravity+codex, buckets antigravity+codex
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    expect(result.subscription.products).toEqual(["antigravity", "codex"]);
  });

  it("a bucketLimits prefix for an unbound product still counts into the union", async () => {
    writeKeys([usedCard({
      bindings: { antigravity: 7 },
      bucketLimits: { "antigravity-gemini": 1, "anthropic-claude": 2 },
    })]);
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    expect(result.subscription.products).toEqual(["antigravity", "anthropic"]);
  });

  it("a legacy provider/boundAccountId hint counts as a binding", async () => {
    writeKeys([usedCard({ bindings: undefined, bucketLimits: undefined, provider: "codex", boundAccountId: 9 })]);
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    expect(result.subscription.products).toEqual(["codex"]);
  });

  it("a pool card (no bindings at all) gets all three products", async () => {
    writeKeys([usedCard({ bindings: undefined, bucketLimits: undefined })]);
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    expect(result.subscription.products).toEqual(["antigravity", "codex", "anthropic"]);
  });

  it("a pool card with an explicit products restriction keeps it", async () => {
    writeKeys([usedCard({ bindings: undefined, bucketLimits: undefined, products: ["anthropic"] })]);
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    expect(result.subscription.products).toEqual(["anthropic"]);
  });

  it("deviceLimit comes from BCAI_MIGRATED_CARD_DEVICE_LIMIT (default 3)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();
    const result = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    expect(result.subscription.deviceLimit).toBe(3);

    process.env.BCAI_MIGRATED_CARD_DEVICE_LIMIT = "5";
    writeKeys([usedCard({ id: "card-2", key: "BCAI-CCCC-DDDD" })]);
    store.reload();
    const customer2 = await createTestCustomer();
    const result2 = await service.bindCard(customer2.id, "BCAI-CCCC-DDDD");
    expect(result2.subscription.deviceLimit).toBe(5);
  });

  it("creates a MIGRATION notification", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();
    await service.bindCard(customer.id, "BCAI-AAAA-BBBB");

    const notifications = await prisma.notification.findMany({ where: { customerId: customer.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("MIGRATION");
    expect(notifications[0].title).toBe("卡密已绑定为订阅");
  });

  it("migrated* fields persist through serialize→reload round-trips", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();
    await service.bindCard(customer.id, "BCAI-AAAA-BBBB");

    // Force a store-side write (serializable()) then reload from disk.
    store.recordUsage("card-legacy-1", 200, { totalTokens: 10 }, "gemini-2.5-pro", "rt-1", "antigravity");
    store.flush();
    store.reload();

    const record = readKeys()[0];
    expect(record.migratedToCustomerId).toBe(customer.id);
    expect(record.migratedAt).toBeTruthy();
    expect(record.migratedFromKey).toBe("BCAI-AAAA-BBBB");
    expect(store.findById("card-legacy-1")?.migratedToCustomerId).toBe(customer.id);
  });

  it("usage continuity: a CardTokenUsage row inserted pre-bind stays associated (same id)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();
    await prisma.cardTokenUsage.create({
      data: {
        accessKeyId: "card-legacy-1", modelKey: "gemini-2.5-pro", bucket: "antigravity-gemini",
        status: 200, inputTokens: 100, outputTokens: 50, totalTokens: 150,
      },
    });

    await service.bindCard(customer.id, "BCAI-AAAA-BBBB");

    const sub = await prisma.subscription.findUnique({ where: { id: "card-legacy-1" } });
    const rows = await prisma.cardTokenUsage.findMany({ where: { accessKeyId: sub!.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].totalTokens).toBe(150);
  });
});

describe("CardMigrationService.bindCard — idempotency and errors", () => {
  it("re-bind by the SAME customer with the old key is idempotent (no second sub)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();

    const first = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    const again = await service.bindCard(customer.id, "BCAI-AAAA-BBBB");

    expect(again.ok).toBe(true);
    expect(again.alreadyBound).toBe(true);
    expect(again.subscription.id).toBe(first.subscription.id);
    expect(await prisma.subscription.count()).toBe(1);
    expect(await prisma.notification.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("bind by a DIFFERENT customer → 409 CARD_ALREADY_BOUND", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const owner = await createTestCustomer();
    const intruder = await createTestCustomer();
    await service.bindCard(owner.id, "BCAI-AAAA-BBBB");

    await expect(service.bindCard(intruder.id, "BCAI-AAAA-BBBB")).rejects.toMatchObject({
      status: 409,
      response: { error: "CARD_ALREADY_BOUND" },
    });
  });

  it("unknown card → 404 CARD_NOT_FOUND", async () => {
    const customer = await createTestCustomer();
    await expect(service.bindCard(customer.id, "BCAI-NOPE-NOPE")).rejects.toMatchObject({
      status: 404,
      response: { error: "CARD_NOT_FOUND" },
    });
  });

  it("disabled card → 400 CARD_DISABLED", async () => {
    writeKeys([usedCard({ status: "disabled" })]);
    store.reload();
    const customer = await createTestCustomer();
    await expect(service.bindCard(customer.id, "BCAI-AAAA-BBBB")).rejects.toMatchObject({
      status: 400,
      response: { error: "CARD_DISABLED" },
    });
  });

  it("expired card (status or keyExpiresAt past) → 400 CARD_EXPIRED", async () => {
    writeKeys([usedCard({ status: "expired" })]);
    store.reload();
    const customer = await createTestCustomer();
    await expect(service.bindCard(customer.id, "BCAI-AAAA-BBBB")).rejects.toMatchObject({
      status: 400,
      response: { error: "CARD_EXPIRED" },
    });

    // Time-expired but status still "active".
    writeKeys([usedCard({ id: "card-old", key: "BCAI-OLD-0000", firstUsedAt: "2020-01-01T00:00:00.000Z", durationMs: 1000 })]);
    store.reload();
    await expect(service.bindCard(customer.id, "BCAI-OLD-0000")).rejects.toMatchObject({
      status: 400,
      response: { error: "CARD_EXPIRED" },
    });
  });

  it("two CONCURRENT binds of one card by DIFFERENT customers → one success, one clean 409 (never a 500/PK leak)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const alice = await createTestCustomer();
    const bob = await createTestCustomer();

    const results = await Promise.allSettled([
      service.bindCard(alice.id, "BCAI-AAAA-BBBB"),
      service.bindCard(bob.id, "BCAI-AAAA-BBBB"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser gets the SAME clean conflict a sequential duplicate gets.
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      response: { error: "CARD_ALREADY_BOUND" },
    });

    // Exactly one Subscription, owned by the winner.
    const subs = await prisma.subscription.findMany();
    expect(subs).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<any>).value.subscription.id).toBe("card-legacy-1");
  });

  it("two CONCURRENT binds by the SAME customer → one migration, the other idempotent alreadyBound (no 500, single sub + notification)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();

    const results = await Promise.allSettled([
      service.bindCard(customer.id, "BCAI-AAAA-BBBB"),
      service.bindCard(customer.id, "BCAI-AAAA-BBBB"),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const values = (results as PromiseFulfilledResult<any>[]).map((r) => r.value);
    expect(values.filter((v) => v.alreadyBound).length).toBe(1);
    expect(values.every((v) => v.subscription.id === "card-legacy-1")).toBe(true);

    expect(await prisma.subscription.count()).toBe(1);
    expect(await prisma.notification.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("P2002 drift (Subscription row already exists for the record id) maps to 409 / alreadyBound — never a 500", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const owner = await createTestCustomer();
    const intruder = await createTestCustomer();
    // Drift: the row exists (e.g. created out-of-band) while the record is NOT
    // marked migrated — the pre-checks pass and the tx hits the id unique.
    await prisma.subscription.create({
      data: {
        id: "card-legacy-1",
        customerId: owner.id,
        planId: null,
        status: "ACTIVE",
        startsAt: new Date(),
        expiresAt: null,
        productEntitlements: JSON.stringify(["antigravity"]),
        weight: 1,
        deviceLimit: 3,
        backingKeyValue: "sub_" + "e".repeat(48),
      },
    });

    await expect(service.bindCard(intruder.id, "BCAI-AAAA-BBBB")).rejects.toMatchObject({
      status: 409,
      response: { error: "CARD_ALREADY_BOUND" },
    });

    const again = await service.bindCard(owner.id, "BCAI-AAAA-BBBB");
    expect(again.ok).toBe(true);
    expect(again.alreadyBound).toBe(true);
    expect(again.subscription.id).toBe("card-legacy-1");
    expect(await prisma.subscription.count()).toBe(1);
  });

  it("a concurrent STALE store flush mid-bind cannot resurrect the old card key (post-commit barrier re-asserts + preserves interim usage)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();

    // Simulate the race the review found: right after the IN-TX file write
    // (before commit/reload), a lease-path flush() rewrites the file from the
    // store's still-stale in-memory cache (old key, no migration fields).
    const realUpsert = rosetta.upsertKeyRecord.bind(rosetta);
    const spy = vi.spyOn(rosetta, "upsertKeyRecord").mockImplementation((fields: any, options?: any) => {
      const result = realUpsert(fields, options);
      if (spy.mock.calls.length === 1) {
        store.recordUsage("card-legacy-1", 200, { totalTokens: 5 }, "gemini-2.5-pro", "clobber-1", "antigravity");
        store.flush(); // stale cache → resurrects the old key on disk
      }
      return result;
    });
    try {
      await service.bindCard(customer.id, "BCAI-AAAA-BBBB");
    } finally {
      spy.mockRestore();
    }

    // The barrier re-asserted the migration on disk…
    const after = readKeys()[0];
    expect(after.migratedToCustomerId).toBe(customer.id);
    expect(after.migratedFromKey).toBe("BCAI-AAAA-BBBB");
    expect(after.key).toMatch(/^sub_[0-9a-f]{48}$/);
    // …WITHOUT losing the usage the stale flush carried (42 base + 1 interim).
    expect(after.totalRequests).toBe(43);

    // Old key is dead in the reloaded index; the backing key still indexes
    // (bind-card redemption path — findByKey).
    expect(store.findByKey("BCAI-AAAA-BBBB")).toBeNull();
    expect(store.findByKey(after.key)?.id).toBe("card-legacy-1");
  });

  it("a failing file write rolls back the Subscription + Notification rows (no orphans)", async () => {
    writeKeys([usedCard()]);
    store.reload();
    const customer = await createTestCustomer();
    // Sabotage the single writer: replacing the file with a directory makes the
    // atomic rename fail inside the transaction.
    fs.rmSync(accessKeysPath);
    fs.mkdirSync(accessKeysPath);

    await expect(service.bindCard(customer.id, "BCAI-AAAA-BBBB")).rejects.toThrow();

    expect(await prisma.subscription.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});
