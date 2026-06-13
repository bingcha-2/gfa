/**
 * card-migration.service.ts — POST /api/account/bind-card: re-home a legacy card
 * key onto a customer Subscription.
 *
 * The heart of the migration is ID CONTINUITY: the SAME AccessKeyRecord (same
 * id) becomes the subscription's shadow record, so CardTokenUsage rows,
 * FairShareWindow.cardId, and the in-memory rate-limit windows all carry over
 * untouched. Only three things change on the record:
 *   key                  → the subscription's fresh backingKeyValue (the old
 *                          card string stops authenticating immediately —
 *                          byKey re-index on reload),
 *   migratedToCustomerId / migratedAt → provenance,
 *   migratedFromKey      → the old key string, kept ONLY so a re-bind with the
 *                          same card key can answer idempotently (it cannot
 *                          authenticate; the auth index is built from `key`).
 *
 * Crash-ordering: the Prisma rows (Subscription + Notification) and the file
 * write run inside ONE interactive transaction, with the file write LAST —
 * a file-write failure (disk full / permissions, the realistic failure mode)
 * rolls the rows back automatically, so a crash cannot leave a Subscription
 * without its migrated record. The inverse residue (file written, commit
 * failed — vanishingly rare with SQLite) is self-healing: the record carries
 * migratedToCustomerId, so the customer's retry takes the already-bound path,
 * which recreates the missing Subscription row from the record.
 *
 * Concurrency (M13b):
 *   • The whole bind runs under the process-wide access-keys write lock
 *     (withAccessKeysWriteLock), so duplicate concurrent binds serialize: the
 *     loser re-reads the record inside its own lock turn, sees
 *     migratedToCustomerId, and answers 409 / alreadyBound instead of racing
 *     into the tx. A residual unique-violation (P2002 on Subscription.id —
 *     e.g. db/file drift or a row created out-of-band) is caught and mapped
 *     to the same clean conflict answers; it must never surface as a 500.
 *   • Post-commit write barrier: while the tx commit is awaited, a concurrent
 *     store flush (debounce timer / lease-path flush()) can rewrite the file
 *     from an in-memory cache that predates the in-tx write, resurrecting the
 *     old card key. After commit we therefore re-run flush → upsert(migration
 *     fields) → reload as one synchronous sequence: the flush persists any
 *     interim counters, the idempotent upsert re-asserts the migration on top
 *     of whatever is on disk, and the reload makes every pool see it.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Subscription } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { withAccessKeysWriteLock } from "../../rosetta/access-key.service";
import { RosettaService } from "../../rosetta/rosetta.service";
import { AccessKeyStore, type AccessKeyRecord } from "../../token-server/access-key-store";
import { TokenServerService } from "../../token-server/token-server.service";
import { RemoteCodexService } from "../../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../../remote-anthropic/service/remote-anthropic.service";
import { keyExpiresAt } from "../../token-server/token-billing";
import { newBackingKeyValue } from "../../subscription/subscription.service";

const ALL_PRODUCTS = ["antigravity", "codex", "anthropic"] as const;

export interface BindCardResult {
  ok: true;
  alreadyBound?: boolean;
  subscription: {
    id: string;
    expiresAt: string | null;
    products: string[];
    deviceLimit: number;
    planName: null;
  };
}

function migratedCardDeviceLimit(): number {
  const raw = Number(process.env.BCAI_MIGRATED_CARD_DEVICE_LIMIT || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

@Injectable()
export class CardMigrationService {
  private readonly logger = new Logger(CardMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rosetta: RosettaService,
    @Inject("SHARED_ACCESS_KEY_STORE") private readonly accessKeyStore: AccessKeyStore,
    private readonly tokenServer: TokenServerService,
    private readonly remoteCodex: RemoteCodexService,
    private readonly remoteAnthropic: RemoteAnthropicService,
  ) {}

  async bindCard(customerId: string, rawCardKey: string): Promise<BindCardResult> {
    const cardKey = String(rawCardKey || "").trim();
    if (!cardKey) {
      throw new BadRequestException({ error: "CARD_NOT_FOUND", message: "卡密不能为空" });
    }
    // Serialize the ENTIRE bind (validation → tx+file write → reload) against
    // every other access-keys.json writer — see the module doc "Concurrency".
    return withAccessKeysWriteLock(() => this.bindCardLocked(customerId, cardKey));
  }

  private async bindCardLocked(customerId: string, cardKey: string): Promise<BindCardResult> {
    // Persist pending in-memory counter deltas so the migration's file
    // read-modify-write starts from current state (single-writer discipline).
    this.accessKeyStore.flush();

    let record = this.accessKeyStore.findByKey(cardKey);
    if (!record) {
      // The original key string dies at migration (rotated to the backing key),
      // so an idempotent re-bind finds the record via migration provenance.
      record = this.findByMigratedFromKey(cardKey);
      if (!record) {
        throw new NotFoundException({ error: "CARD_NOT_FOUND", message: "卡密不存在" });
      }
    }

    if (record.migratedToCustomerId) {
      if (record.migratedToCustomerId !== customerId) {
        throw new ConflictException({ error: "CARD_ALREADY_BOUND", message: "该卡密已绑定到其他账号" });
      }
      return this.alreadyBoundResponse(customerId, record);
    }

    const status = String(record.status || "active");
    if (status === "expired") {
      throw new BadRequestException({ error: "CARD_EXPIRED", message: "卡密已过期" });
    }
    if (status !== "active") {
      throw new BadRequestException({ error: "CARD_DISABLED", message: "卡密已停用" });
    }
    const expiresIso = keyExpiresAt(record);
    if (expiresIso && Date.parse(expiresIso) <= Date.now()) {
      throw new BadRequestException({ error: "CARD_EXPIRED", message: "卡密已过期" });
    }

    const products = deriveProducts(record, this.accessKeyStore);
    const expiresAt = expiresIso ? new Date(expiresIso) : null; // never-used card → null (no expiry until first use)
    const deviceLimit = migratedCardDeviceLimit();
    const backingKeyValue = newBackingKeyValue();
    const recordId = record.id;
    const weight = Math.max(1, Math.floor(Number(record.weight) || 1));
    const weeklyTokenLimit = Number(record.weeklyTokenLimit || 0) || null;
    const windowMs = Number(record.windowMs || 0) > 0 ? Number(record.windowMs) : undefined;

    const migratedAtIso = new Date().toISOString();
    const migrationFields = {
      id: recordId,
      key: backingKeyValue,
      migratedFromKey: cardKey,
      migratedToCustomerId: customerId,
      migratedAt: migratedAtIso,
    };

    // Prisma rows first, file write LAST, all inside one transaction — see the
    // module doc for the crash-ordering rationale.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscription.create({
          data: {
            id: recordId, // ID CONTINUITY — the record is re-homed, not re-minted
            customerId,
            migratedFromKey: cardKey, // provenance marker: distinguishes card-migrated subs from catalog purchases
            status: "ACTIVE",
            startsAt: new Date(),
            expiresAt,
            productEntitlements: JSON.stringify(products),
            bucketLimits: record!.bucketLimits ? JSON.stringify(record!.bucketLimits) : null,
            bindings: record!.bindings ? JSON.stringify(record!.bindings) : null,
            weight,
            deviceLimit,
            weeklyTokenLimit,
            ...(windowMs ? { windowMs } : {}),
            backingKeyValue,
          },
        });
        await tx.notification.create({
          data: {
            customerId,
            type: "MIGRATION",
            title: "卡密已绑定为订阅",
            body: `卡密已迁移为账号订阅（订阅编号 ${recordId}），原卡密失效，后续请直接登录使用。`,
          },
        });
        // flush → write back-to-back (synchronous pair) so the in-tx file
        // write starts from the freshest counters and nothing can interleave
        // between them.
        this.accessKeyStore.flush();
        const written = this.rosetta.upsertKeyRecord(migrationFields, { createIfMissing: false });
        if (!written.ok) {
          throw new Error(`card migration file write failed for record ${recordId}: ${written.error}`);
        }
      });
    } catch (err: any) {
      const mapped = await this.mapDuplicateBind(err, customerId, recordId);
      if (mapped) return mapped;
      throw err;
    }

    // Post-commit write barrier (synchronous triple — see module doc): a
    // concurrent store flush during the commit await may have rewritten the
    // file from a cache that predates the in-tx write. Flush whatever is
    // pending, re-assert the migration fields on top of the current disk
    // state (idempotent merge), and reload the pools so the old card key dies
    // in every byKey index.
    this.accessKeyStore.flush();
    const reasserted = this.rosetta.upsertKeyRecord(migrationFields, { createIfMissing: false });
    if (!reasserted.ok) {
      // Record vanished mid-flight (operator deletion) — the committed rows
      // stand; log loudly instead of failing a bind the customer already won.
      this.logger.error(
        `bind-card: post-commit re-assert failed for record ${recordId}: ${reasserted.error} — record missing from access-keys.json while its Subscription row exists`,
      );
    }
    this.reloadPools();
    this.logger.log(`bind-card: record ${recordId} migrated to customer ${customerId} (products=${products.join(",")})`);

    return {
      ok: true,
      subscription: {
        id: recordId,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        products,
        deviceLimit,
        planName: null,
      },
    };
  }

  /**
   * Idempotent re-bind by the same customer. If the Subscription row is missing
   * (file-written-but-commit-failed residue), recreate it from the record.
   */
  private async alreadyBoundResponse(customerId: string, record: AccessKeyRecord): Promise<BindCardResult> {
    let sub = await this.prisma.subscription.findUnique({ where: { id: record.id } });
    if (!sub) {
      this.logger.warn(`bind-card: record ${record.id} is migrated but its Subscription row is missing — self-healing`);
      const expiresIso = keyExpiresAt(record);
      sub = await this.prisma.subscription.create({
        data: {
          id: record.id,
          customerId,
          // self-heal of a card-migrated sub → restore the provenance marker.
          migratedFromKey: record.migratedFromKey ?? null,
          status: "ACTIVE",
          startsAt: new Date(),
          expiresAt: expiresIso ? new Date(expiresIso) : null,
          productEntitlements: JSON.stringify(deriveProducts(record, this.accessKeyStore)),
          bucketLimits: record.bucketLimits ? JSON.stringify(record.bucketLimits) : null,
          bindings: record.bindings ? JSON.stringify(record.bindings) : null,
          weight: Math.max(1, Math.floor(Number(record.weight) || 1)),
          deviceLimit: migratedCardDeviceLimit(),
          weeklyTokenLimit: Number(record.weeklyTokenLimit || 0) || null,
          backingKeyValue: String(record.key || newBackingKeyValue()),
        },
      });
    }
    return { ok: true, alreadyBound: true, subscription: summarize(sub) };
  }

  /**
   * Map a unique-violation (P2002 on Subscription.id == record.id) from the
   * bind transaction to a clean conflict answer instead of a 500. The write
   * lock already serializes same-process duplicate binds (the loser's
   * re-validation sees migratedToCustomerId), so reaching this means db/file
   * drift: a Subscription row with the record's id exists while the record is
   * not (yet) marked migrated. Ownership is decided by the record's
   * provenance first, the existing row's customerId second.
   * Returns null when the error is not a unique violation (caller rethrows).
   */
  private async mapDuplicateBind(err: any, customerId: string, recordId: string): Promise<BindCardResult | null> {
    if (String(err?.code || "") !== "P2002") return null;
    const record = this.accessKeyStore.findById(recordId);
    const owner =
      String(record?.migratedToCustomerId || "") ||
      String(
        (await this.prisma.subscription.findUnique({
          where: { id: recordId },
          select: { customerId: true },
        }))?.customerId || "",
      );
    this.logger.warn(
      `bind-card: duplicate bind for record ${recordId} hit the Subscription unique (P2002); owner=${owner || "unknown"} requester=${customerId}`,
    );
    if (owner && owner === customerId) {
      return this.alreadyBoundResponse(customerId, (record ?? ({ id: recordId } as AccessKeyRecord)));
    }
    throw new ConflictException({ error: "CARD_ALREADY_BOUND", message: "该卡密已绑定到其他账号" });
  }

  private findByMigratedFromKey(cardKey: string): AccessKeyRecord | null {
    const keys = this.accessKeyStore.readAll().keys;
    return keys.find((k) => k && String(k.migratedFromKey || "") === cardKey) || null;
  }

  /** Mirror rosetta's reloadKeyStores: all three pools share the store file. */
  private reloadPools(): void {
    this.tokenServer.reloadAccessKeys();
    this.remoteCodex.reloadAccessKeys();
    this.remoteAnthropic.reloadAccessKeys();
  }
}

function summarize(sub: Subscription) {
  let products: string[] = [];
  try {
    const parsed = JSON.parse(sub.productEntitlements || "[]");
    products = Array.isArray(parsed) ? parsed.map((p) => String(p)) : [];
  } catch { /* ignore */ }
  return {
    id: sub.id,
    expiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : null,
    products,
    deviceLimit: sub.deviceLimit,
    planName: null as null,
  };
}

/**
 * Products the migrated subscription is entitled to:
 *   • bound card (any binding, incl. the legacy provider/boundAccountId pair):
 *     union of bindings keys + bucketLimits bucket prefixes (`<product>-<family>`)
 *     + the legacy provider hint;
 *   • pure pool card (no binding at all): its explicit `products` restriction
 *     when present, else all three products (legacy universal card).
 */
function deriveProducts(record: AccessKeyRecord, store: AccessKeyStore): string[] {
  const valid = new Set<string>(ALL_PRODUCTS);
  const set = new Set<string>();

  const bindings = record.bindings && typeof record.bindings === "object" ? record.bindings : {};
  for (const [product, accountId] of Object.entries(bindings)) {
    if (Number(accountId) > 0 && valid.has(product)) set.add(product);
  }
  if (Number(record.boundAccountId || 0) > 0 && record.provider && valid.has(String(record.provider))) {
    set.add(String(record.provider));
  }

  if (store.hasAnyBinding(record)) {
    const bucketLimits = record.bucketLimits && typeof record.bucketLimits === "object" ? record.bucketLimits : {};
    for (const bucket of Object.keys(bucketLimits)) {
      const idx = bucket.indexOf("-");
      if (idx <= 0) continue;
      const product = bucket.slice(0, idx);
      if (valid.has(product)) set.add(product);
    }
    return ALL_PRODUCTS.filter((p) => set.has(p));
  }

  // Pool card — explicit product restriction, else all three.
  const restricted = Array.isArray((record as any).products)
    ? (record as any).products.map((p: unknown) => String(p)).filter((p: string) => valid.has(p))
    : [];
  return restricted.length > 0 ? restricted : [...ALL_PRODUCTS];
}
