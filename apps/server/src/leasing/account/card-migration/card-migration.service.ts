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
import {
  legacySeatFromBucketLimits,
  rowToConfig,
  subscriptionToLimitRecord,
} from "../../subscription/subscription-config";

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
      // 「转化即删」后老卡 key 在内存/文件都没了 → 幂等重绑改查 DB 的迁移痕迹
      // (Subscription.migratedFromKey)。命中即按已绑/冲突应答,不再依赖文件影子。
      const migratedSub = await this.prisma.subscription.findFirst({ where: { migratedFromKey: cardKey } });
      if (migratedSub) {
        if (migratedSub.customerId !== customerId) {
          throw new ConflictException({ error: "CARD_ALREADY_BOUND", message: "该卡密已绑定到其他账号" });
        }
        return { ok: true, alreadyBound: true, subscription: summarize(migratedSub) };
      }
      // 兼容历史:迁移前/中残留的文件影子仍带 migratedFromKey 时,走老路径自愈。
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
    const migratedConfig = migratedCardConfig(record, products, deviceLimit, weight, weeklyTokenLimit, windowMs);

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
            config: JSON.stringify(migratedConfig),
            weight,
            deviceLimit,
            weeklyTokenLimit,
            ...(windowMs ? { windowMs } : {}),
            backingKeyValue,
          },
        });
        // 把这张卡的历史用量(小时聚合)归属到账户(ID continuity:accessKeyId == recordId == 订阅 id)。
        await tx.cardUsageHourly.updateMany({
          where: { accessKeyId: recordId },
          data: { customerId },
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

    // 转化即删去影子(替代原"提交后重新断言影子"屏障):先 flush 结算提交期间可能产生的增量
    // (单写者纪律),再把迁移出来的订阅按「与 boot 完全一致」的方式(rowToConfig +
    // subscriptionToLimitRecord)注册进内存订阅索引,同时把文件影子卡的实时限流窗口平移到订阅
    // record,然后物理删除影子卡。migrate... 内部全程同步、与并发 flush 互斥;删除以最终 flush
    // 落盘,reloadPools 让各池重读到"无影子"的文件。重启后由 boot 的 hydrate + 窗口重建接管。
    this.accessKeyStore.flush();
    const subRow = await this.prisma.subscription.findUnique({ where: { id: recordId } });
    if (subRow) {
      const limitRecord = subscriptionToLimitRecord({
        id: subRow.id,
        customerId: subRow.customerId,
        priority: subRow.priority,
        backingKeyValue: subRow.backingKeyValue ?? undefined,
        status: subRow.status,
        expiresAt: subRow.expiresAt,
        config: rowToConfig(subRow as any),
      });
      this.accessKeyStore.migrateCardRecordToSubscription(limitRecord as any);
    } else {
      // 刚提交的行查不到(理论不该发生)—— 退回只删影子,避免老卡 key 残留。
      this.logger.error(`bind-card: post-commit subscription ${recordId} not found — cannot de-shadow cleanly`);
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
          config: JSON.stringify(migratedCardConfig(
            record,
            deriveProducts(record, this.accessKeyStore),
            migratedCardDeviceLimit(),
            Math.max(1, Math.floor(Number(record.weight) || 1)),
            Number(record.weeklyTokenLimit || 0) || null,
            Number(record.windowMs || 0) > 0 ? Number(record.windowMs) : undefined,
          )),
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

function migratedCardConfig(
  record: AccessKeyRecord,
  products: string[],
  deviceLimit: number,
  weight: number,
  weeklyTokenLimit: number | null,
  windowMs?: number,
): Record<string, unknown> {
  const bucketLimits = objectCopy(record.bucketLimits);
  const displayBindings = displayBindingsForMigratedCard(record);
  const shareSeats = legacySeatFromBucketLimits(bucketLimits);
  const common = {
    products,
    bucketLimits,
    ...(weeklyTokenLimit ? { weeklyTokenLimit } : {}),
    deviceLimit,
    ...(windowMs ? { windowMs } : {}),
    shareSeats,
    shareCapacity: 8,
    legacyDisplay: true,
  };

  if (Object.keys(displayBindings).length > 0) {
    return {
      line: "bind",
      ...common,
      levels: objectCopy((record as any).levels),
      bindings: displayBindings,
      displayBindings,
      assignmentPolicy: "preferred-dynamic",
      weight,
    };
  }

  return {
    line: "pool",
    ...common,
    weight,
  };
}

function displayBindingsForMigratedCard(record: AccessKeyRecord): Record<string, number> {
  const out: Record<string, number> = {};
  const bindings = record.bindings && typeof record.bindings === "object" ? record.bindings : {};
  for (const [product, accountId] of Object.entries(bindings)) {
    const id = Number(accountId);
    if (Number.isFinite(id) && id > 0) out[product] = id;
  }
  const legacyId = Number(record.boundAccountId || 0);
  const provider = String(record.provider || "");
  if (legacyId > 0 && provider && !(provider in out)) out[provider] = legacyId;
  return out;
}

function objectCopy(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

/**
 * Products the migrated subscription is entitled to:
 *   • bound card (any binding, incl. the legacy provider/boundAccountId pair):
 *     ONLY the products it actually binds a real account for (bindings keys with
 *     value>0, plus the legacy provider hint). bucketLimits are NOT consulted —
 *     on a bound card the non-bound buckets are placeholder caps of 1 (a "blocked"
 *     marker), and unioning their prefixes would mis-read those as entitlements,
 *     making the failover `serves` gate match a product the card has no account
 *     for → spurious 409/429. A genuine "bind X + metered-sell Y" card is modeled
 *     as a POOL card (no binding, real bucketLimits), which takes the else branch.
 *   • pure pool card (no binding at all): explicit `products` restriction wins;
 *     else derive from bucketLimits — a bucket with a REAL cap (>1) means the
 *     product is sold (cap of 1 is the "blocked" placeholder, same convention as
 *     bound cards). bucketLimits present but every cap a placeholder → [] (sells
 *     nothing). ONLY a card with no bucketLimits at all is the legacy universal
 *     card → all three.
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
    // 绑定卡只服务实际绑了号的产品(bindings/provider)。不并入 bucketLimits 桶前缀:
    // 绑定卡上非绑定产品的 bucketLimits 都是占位 1(封死),并入会把它们误判成「开通」。
    return ALL_PRODUCTS.filter((p) => set.has(p));
  }

  // Pool card. Explicit `products` restriction wins.
  const restricted = Array.isArray((record as any).products)
    ? (record as any).products.map((p: unknown) => String(p)).filter((p: string) => valid.has(p))
    : [];
  if (restricted.length > 0) return restricted;

  // Else derive from bucketLimits: a bucket with a REAL cap (>1) means the product
  // is sold; cap of 1 is the "blocked" placeholder (don't count it). If buckets are
  // present but all placeholders, the card sells nothing → []. No buckets at all =
  // legacy universal card → all three.
  const bucketLimits = record.bucketLimits && typeof record.bucketLimits === "object" ? record.bucketLimits : {};
  const bucketKeys = Object.keys(bucketLimits);
  if (bucketKeys.length > 0) {
    for (const bucket of bucketKeys) {
      const idx = bucket.indexOf("-");
      if (idx <= 0) continue;
      const product = bucket.slice(0, idx);
      if (Number((bucketLimits as Record<string, number>)[bucket]) > 1 && valid.has(product)) set.add(product);
    }
    return ALL_PRODUCTS.filter((p) => set.has(p)); // may be [] when every cap is a placeholder
  }
  return [...ALL_PRODUCTS];
}
