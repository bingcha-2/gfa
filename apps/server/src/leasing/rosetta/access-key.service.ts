// Access-key (卡密) domain: card CRUD, share/weight accounting, account bindings,
// auto-seat assignment. Extracted from RosettaService —
// behavior-preserving (method bodies verbatim, this.dataDir/this.accessKeysFile
// rebound to the shared RosettaContext). boundCardCounts + clearBindingsForAccount
// are public because the account domain services call them.

import * as crypto from "crypto";
import * as path from "path";

import { bucketsForProducts, isValidBucket } from "../lease-core/product-bucket";
import { getModelQuotaFraction } from "../token-server/lease-scheduler";
import {
  ACCOUNT_SHARE_CAPACITY,
  DEFAULT_KEY_WINDOW_MS,
  UNIVERSAL_BILLING,
  recentBucketUsage,
  resetWindowIfExpired,
} from "../token-server/token-billing";
import { accessKeyExpiresAt, cardWeight, maskKey, newAccessKeyValue, recentTokenUsage } from "./lib/access-key-util";
import type { RosettaContext } from "./lib/context";
import { nowIso, readJson, writeJson } from "./lib/store";

// ── access-keys.json write lock ──────────────────────────────────────────────
// Process-wide promise-chain mutex serializing every COMPOUND read→mutate→write
// critical section over access-keys.json. Node's single thread already makes
// each individual synchronous mutation in this service atomic; the lock exists
// for callers whose critical section spans `await`s or composes several calls:
//   • EntitlementSyncService.syncSubscription — the free-share computation
//     (assignSeatForProduct reads the file) and the upsert that consumes those
//     shares must be atomic, or two concurrent purchases double-book the same
//     upstream account past ACCOUNT_SHARE_CAPACITY;
//   • CardMigrationService.bindCard — the duplicate-bind check, the Prisma tx
//     (with the file re-home write inside), and the post-commit reload must not
//     interleave with other writers;
//   • the admin cleanup sweeps below — so they can never observe (and delete)
//     a record mid-migration while a locked section is parked on an await.
// IN-PROCESS ONLY: the deployment is single-instance; running multiple API
// processes over one dataDir needs a real cross-process lock (out of scope).
let accessKeysWriteChain: Promise<unknown> = Promise.resolve();

export function withAccessKeysWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = accessKeysWriteChain.then(fn);
  // Keep the chain alive when fn rejects — the CALLER sees the rejection via
  // `run`; the next queued section must still get its turn.
  accessKeysWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export class AccessKeyService {
  constructor(private readonly ctx: RosettaContext) {}

  listAccessKeys(query: { search?: string }) {
    const data = this.ctx.accessKeysFile.read();
    const term = String(query.search || "").trim().toLowerCase();
    // accountId → email 解析缓存:绑定卡需 join 三个账号池文件,逐卡逐产品读会重复
    // 打开同一个 json,这里按 provider 缓存「id→email」表,整次 list 只读一遍每个池。
    const emailCache = new Map<string, Map<number, string>>();
    const keys = (Array.isArray(data.keys) ? data.keys : [])
      .filter((key: any) => {
        if (!term) return true;
        return [key.id, key.key, key.name, key.status, key.sessionClientId]
          .some((value) => String(value || "").toLowerCase().includes(term));
      })
      .map((key: any) => {
        // 绑定映射:只保留 accountId>0 的项,推导卡类型与可用产品。
        const bindings = (key.bindings && typeof key.bindings === "object" ? key.bindings : {}) as Record<string, number>;
        const boundProducts = Object.keys(bindings).filter((p) => Number(bindings[p]) > 0);
        // 卡类型:绑定非空 = 绑定卡(bound);否则 = 万能卡(pool,自动开放全部产品)。
        const cardType: "pool" | "bound" = boundProducts.length > 0 ? "bound" : "pool";

        // 「额度」列数据:复用 getAccessKeyLimits 的算法 —— 万能卡列全部产品桶,绑定卡
        // 仅列已绑产品对应的桶;used 来自当前窗口的 recentBucketUsage;limit 来自
        // bucketLimits 覆盖(0 = 无限/未设)。在 record 的浅拷贝上算,避免 resetWindowIfExpired
        // 改动 accessKeysFile 缓存里的对象。
        // Per-card window usage comes from the authoritative in-memory store when
        // available (events no longer live in the JSON file); fall back to the
        // file record otherwise (e.g. tests / store not wired). Shallow-copy so
        // resetWindowIfExpired inside the read can't mutate the cached object.
        const authRecord = this.ctx.accessKeyStore?.findById(String(key.id || "")) || key;
        const usageRecord = { ...authRecord };
        const now = Date.now();
        const bucketUsage = recentBucketUsage(usageRecord, now);
        const customLimits = (key.bucketLimits && typeof key.bucketLimits === "object" ? key.bucketLimits : {}) as Record<string, number>;
        const buckets = bucketsForProducts(boundProducts).map((bucket: string) => {
          const custom = Number(customLimits[bucket] || 0);
          return {
            bucket,
            label: UNIVERSAL_BILLING.bucketLabel(bucket),
            used: bucketUsage.get(bucket) || 0,
            limit: custom > 0 ? custom : 0, // 0 = 无限/未设
          };
        });

        // 绑定卡明细:每个绑定产品 → { product, accountId, accountEmail }(email join 账号池文件)。
        const bindingsDetail =
          cardType === "bound"
            ? boundProducts.map((product) => {
                const accountId = Number(bindings[product]);
                return { product, accountId, accountEmail: this.resolveAccountEmail(product, accountId, emailCache) };
              })
            : [];

        return {
          id: String(key.id || ""),
          name: String(key.name || ""),
          fullKey: String(key.key || ""),
          key: maskKey(key.key),
          status: String(key.status || "active"),
          totalRequests: Number(key.totalRequests || 0),
          totalTokensUsed: Number(key.totalTokensUsed || 0),
          recentWindowTokens: recentTokenUsage(authRecord),
          windowMs: Number(key.windowMs || key.tokenWindowMs || DEFAULT_KEY_WINDOW_MS),
          weeklyTokenLimit: Number(key.weeklyTokenLimit || 0),
          // 周/5h 换算比设置框(0 = 留空 → 走「后台学习 > 全局默认」)。
          weeklyRatio: Number(key.weeklyRatio || 0),
          durationMs: Number(key.durationMs || 0),
          provider: String(key.provider || ""),
          boundAccountId: Number(key.boundAccountId || 0),
          bindings,
          bucketLimits: customLimits,
          weight: cardWeight(key),
          // ── 重设计新增字段(供卡密页「类型」「额度」列与绑定明细)──
          cardType,
          buckets,
          bindingsDetail,
          // 账号份额容量(全局常量,绑定卡「份额 n/N」的 N)——避免前端硬编码。
          shareCapacity: ACCOUNT_SHARE_CAPACITY,
          createdAt: String(key.createdAt || ""),
          lastUsedAt: String(key.lastUsedAt || ""),
          expiresAt: accessKeyExpiresAt(key),
          sessionClientId: String(key.sessionClientId || ""),
          sessionExpiresAt: String(key.sessionExpiresAt || ""),
        };
      });

    return { ok: true, keys };
  }

  /** Resolve an account's email within a provider pool, memoized per list call. */
  private resolveAccountEmail(
    provider: string,
    accountId: number,
    cache: Map<string, Map<number, string>>,
  ): string {
    if (!(accountId > 0)) return "";
    let byId = cache.get(provider);
    if (!byId) {
      byId = new Map<number, string>();
      const pool = readJson(this.poolFileFor(provider), { accounts: [] });
      for (const account of Array.isArray(pool.accounts) ? pool.accounts : []) {
        byId.set(Number(account.id), String(account.email || ""));
      }
      cache.set(provider, byId);
    }
    return byId.get(accountId) || "";
  }

  createAccessKey(payload: any) {
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];

    // Batch minting: count > 1 creates N independent cards sharing the same
    // limits. An explicit id/key only applies to a single card (count 1).
    const count = Math.max(1, Math.min(200, Number(payload?.count) || 1));

    // Products the card is sold for; each auto-binds one open-seat account at
    // mint time. Pre-assign all seats so the batch is atomic (no half-mint when
    // a pool runs out).
    const products: string[] = Array.isArray(payload?.products)
      ? payload.products
          .map((p: unknown) => String(p))
          .filter((p: string) => p === "codex" || p === "antigravity" || p === "anthropic")
      : [];
    // Membership level (planType) chosen per product — REQUIRED for every
    // selected product. Auto-bind only considers accounts of the exact level.
    const levels: Record<string, string> =
      payload?.levels && typeof payload.levels === "object" ? payload.levels : {};
    // Share weight (份额): 1 = 拼车 (default), 4 = 独享.
    const weight = cardWeight({ weight: payload?.weight });
    // 可选:每个产品手动指定要绑定的账号(accountIds[product] > 0)。指定后整批卡都
    // 绑到该账号(管理员显式选择,镜像 bindAccessKey 的宽松策略:只校验份额容量,不校
    // 验等级/出池/配额);留空则回退到原有的自动分配空位逻辑。
    const accountIds: Record<string, number> =
      payload?.accountIds && typeof payload.accountIds === "object" ? payload.accountIds : {};
    const seatPlan: Record<string, number[]> = {};
    for (const product of products) {
      const label = product === "codex" ? "Codex" : product === "anthropic" ? "Anthropic" : "Antigravity";
      const level = String(levels[product] || "").trim();
      if (!level) return { ok: false, error: `请为 ${label} 选择会员等级` };
      const manualId = Number(accountIds[product] || 0);
      if (manualId > 0) {
        const pool = readJson(this.poolFileFor(product), { accounts: [] });
        const account = (Array.isArray(pool.accounts) ? pool.accounts : []).find(
          (a: any) => Number(a.id) === manualId,
        );
        if (!account) return { ok: false, error: `所选 ${label} 账号不存在` };
        // 整批 count 张卡都绑到这个号,合计需要 count*weight 份,不能超过容量。
        const used = this.usedShares(product, manualId, "");
        const need = count * weight;
        if (used + need > ACCOUNT_SHARE_CAPACITY) {
          return {
            ok: false,
            error: `所选 ${label} 账号(${account.email || "#" + manualId})份额不足：已用 ${used}/${ACCOUNT_SHARE_CAPACITY} 份，本次需 ${need} 份`,
          };
        }
        seatPlan[product] = new Array(count).fill(manualId);
      } else {
        const seats = this.autoAssignSeats(product, count, weight, level);
        if (!seats) {
          return {
            ok: false,
            error: `${label} ${level} 等级可用账号不足（无配额充足且份额足够的号），请增加该等级账号`,
          };
        }
        seatPlan[product] = seats;
      }
    }

    const created: any[] = [];
    for (let i = 0; i < count; i++) {
      const single = count === 1;
      const bindings: Record<string, number> = {};
      for (const product of products) bindings[product] = seatPlan[product][i];
      const record = {
        id: String((single && payload?.id) || `card_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`),
        key: String((single && payload?.key) || newAccessKeyValue()),
        name: String(payload?.name || ""),
        status: String(payload?.status || "active"),
        durationMs: Number(payload?.durationMs || 60 * 60 * 1000),
        // 每卡上限改为按模型设(bucketLimits,经「模型限额」弹窗配置),不再有全局
        // tokenWindowLimit/windowLimit。新卡留空即无封顶(万能卡=无限)。
        // Per-card rate-limit window duration (configurable hours/days, set at
        // creation). Drives the fixed-period reset in resetWindowIfExpired().
        windowMs: Math.max(0, Number(payload?.windowMs || 0)) || DEFAULT_KEY_WINDOW_MS,
        // Weekly (long) window limit — second tier of rate limiting (0 = unlimited).
        weeklyTokenLimit: Math.max(0, Number(payload?.weeklyTokenLimit || 0)),
        // 周/5h 换算比覆盖(0 = 留空,走后台学习/全局默认 R)。派生周上限 = 5h上限 × R。
        weeklyRatio: Math.max(0, Number(payload?.weeklyRatio || 0)),
        weight,
        ...(products.length ? { bindings } : {}),
        // Universal cards can also select products (restrict available services).
        // Empty products = all products available.
        ...(!products.length && Array.isArray(payload?.products) && payload.products.length
          ? { products: payload.products.map((p: unknown) => String(p)).filter((p: string) => p === 'codex' || p === 'antigravity' || p === 'anthropic') }
          : {}),
        createdAt: nowIso(),
      };
      keys.push(record);
      created.push(record);
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    const publicKeys = created.map((record) => this.publicAccessKey(record));
    return { ok: true, key: publicKeys[0], keys: publicKeys, totalKeys: keys.length };
  }

  updateAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };
    for (const field of ["name", "status", "durationMs", "windowMs", "weeklyTokenLimit", "weeklyRatio"]) {
      if (payload[field] !== undefined) record[field] =
        (field.endsWith("Ms") || field.endsWith("Limit") || field === "weeklyRatio")
          ? Number(payload[field])
          : String(payload[field]);
    }
    // 份额(weight):支持编辑改份额;clamp 1..ACCOUNT_SHARE_CAPACITY(=8),复用 cardWeight。
    if (payload.weight !== undefined) record.weight = cardWeight({ weight: payload.weight });
    // Per-bucket custom limits: merge provided values, delete keys set to 0/null.
    // Keys must be real composite <product>-<family> buckets — a bare-family key
    // ("claude") would set a cap that the enforce lookup (composite) never sees,
    // so it silently never trips. Drop any invalid key instead of persisting it.
    if (payload.bucketLimits !== undefined && typeof payload.bucketLimits === "object") {
      const existing = (record.bucketLimits && typeof record.bucketLimits === "object") ? { ...record.bucketLimits } : {};
      for (const [bucket, value] of Object.entries(payload.bucketLimits)) {
        const num = Number(value);
        if (isValidBucket(bucket) && Number.isFinite(num) && num > 0) {
          existing[bucket] = num;
        } else {
          delete existing[bucket];
        }
      }
      record.bucketLimits = Object.keys(existing).length > 0 ? existing : undefined;
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  /**
   * Return per-bucket limits and current-window usage for a single card.
   * Used by the admin console "limits" dialog.
   */
  getAccessKeyLimits(cardId: string) {
    const id = String(cardId || "");
    if (!id) return { ok: false, error: "id 不能为空" };

    const data = this.ctx.accessKeysFile.read();
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((k: any) => String(k.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };

    const now = Date.now();

    // Usage from the authoritative in-memory store (events no longer in the file);
    // config (limits/bindings) still from the file record. Shallow-copy so the
    // window reset can't mutate the cached/store object.
    const usageRecord = { ...(this.ctx.accessKeyStore?.findById(id) || record) };
    resetWindowIfExpired(usageRecord, now);
    const bucketUsage: Map<string, number> = recentBucketUsage(usageRecord, now);
    const customLimits = (record.bucketLimits && typeof record.bucketLimits === "object") ? record.bucketLimits : {};

    const products = record.bindings && typeof record.bindings === "object"
      ? Object.keys(record.bindings).filter((p) => Number(record.bindings[p]) > 0)
      : [];
    // 每模型上限只来自 bucketLimits;未设 = 无限(无全局基准、无 ×系数)。
    const buckets = bucketsForProducts(products).map((bucket: string) => {
      const customValue = Number(customLimits[bucket] || 0);
      return {
        bucket,
        label: UNIVERSAL_BILLING.bucketLabel(bucket),
        customLimit: customValue > 0 ? customValue : null,
        defaultLimit: 0, // 无全局基准:未设 = 无限
        effectiveLimit: customValue > 0 ? customValue : 0,
        used: bucketUsage.get(bucket) || 0,
      };
    });

    return {
      ok: true,
      id,
      name: String(record.name || ""),
      bucketLimits: customLimits,
      buckets,
    };
  }

  /**
   * Single-writer record upsert for the account system (subscription shadow
   * records + bind-card migration). Merges the provided fields onto the
   * existing record — preserving every unspecified field (usage counters,
   * firstUsedAt, bindings, session state) byte-for-byte — or appends a new
   * record when absent (createIfMissing). `null` deletes a field; `undefined`
   * is skipped. Uses the exact same read→mutate→atomic-write path as every
   * admin mutation in this service, so access-keys.json keeps ONE writer.
   */
  upsertKeyRecord(
    fields: { id: string } & Record<string, unknown>,
    options: { createIfMissing?: boolean } = {},
  ): { ok: boolean; created?: boolean; error?: string } {
    const id = String(fields.id || "");
    if (!id) return { ok: false, error: "id 不能为空" };
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let record = keys.find((key: any) => String(key.id) === id);
    let created = false;
    if (!record) {
      if (!options.createIfMissing) return { ok: false, error: "卡密不存在" };
      record = { id, createdAt: nowIso() };
      keys.push(record);
      created = true;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (field === "id" || value === undefined) continue;
      if (value === null) delete record[field];
      else record[field] = value;
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, created };
  }

  /**
   * Auto-assign ONE upstream seat for a product at the given membership level —
   * the same best-fit share-packing logic card minting uses (autoAssignSeats),
   * exposed for subscription shadow-record creation. Returns the accountId or
   * null when no account of that level has `weight` free shares.
   */
  assignSeatForProduct(product: string, weight: number, level: string): number | null {
    if (product !== "codex" && product !== "antigravity" && product !== "anthropic") return null;
    const lvl = String(level || "").trim();
    if (!lvl) return null;
    const seats = this.autoAssignSeats(product, 1, cardWeight({ weight }), lvl);
    return seats ? seats[0] : null;
  }

  deleteAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const filtered = keys.filter((key: any) => String(key.id) !== id);
    if (filtered.length === keys.length) return { ok: false, error: "卡密不存在" };
    writeJson(filePath, { ...data, keys: filtered, updatedAt: nowIso() });
    return { ok: true, totalKeys: filtered.length };
  }

  // ── Static card → account binding ───────────────────────────────────────
  // A card may be bound to exactly one upstream account; an account holds at
  // most MAX_CARDS_PER_ACCOUNT cards (= users). Binding is provider-scoped: the
  // antigravity and codex pools allocate ids independently, so (provider, id) is
  // the real key. See AccessKeyStore.boundAccountIdFor / LeaseService.leaseToken.

  /**
   * Live-record predicate for share accounting — the EXACT predicate the lease
   * side uses for "can this record serve" (AccessKeyStore.cardsBoundToAccount /
   * validateRecord): status unset or "active". A terminal record (expired /
   * disabled / …) keeps its bindings as HISTORY — the lease path refuses to
   * serve it — but its shares no longer occupy capacity. That is what releases
   * an upstream seat when a subscription goes terminal: no record mutation, the
   * accounting simply stops counting it.
   */
  private isLiveKey(key: any): boolean {
    return !key?.status || key.status === "active";
  }

  /**
   * Shares already consumed on an account (sum of LIVE bound cards' weights),
   * excluding `excludeId`. Non-active records don't count (see isLiveKey).
   */
  private usedShares(provider: string, accountId: number, excludeId = ""): number {
    const data = readJson(path.join(this.ctx.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let used = 0;
    for (const key of keys) {
      if (this.isLiveKey(key) && String(key.id) !== excludeId && this.keyBoundAccount(key, provider) === accountId) {
        used += cardWeight(key);
      }
    }
    return used;
  }

  /** Resolve a card's bound account in a pool: bindings map first, legacy fallback. */
  private keyBoundAccount(key: any, provider: string): number {
    const fromMap = Number(key?.bindings?.[provider] || 0);
    if (fromMap > 0) return fromMap;
    return String(key?.provider || "") === provider ? Number(key?.boundAccountId || 0) : 0;
  }

  /** Count cards bound to each account id within a pool. */
  boundCardCounts(provider: string): Map<number, number> {
    const data = readJson(path.join(this.ctx.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const counts = new Map<number, number>();
    for (const key of keys) {
      const accountId = this.keyBoundAccount(key, provider);
      if (accountId > 0) counts.set(accountId, (counts.get(accountId) || 0) + 1);
    }
    return counts;
  }

  bindAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const provider = String(payload?.provider || "").trim();
    const accountId = Number(payload?.accountId || 0);
    if (!provider) return { ok: false, error: "provider 不能为空" };
    if (!(accountId > 0)) return { ok: false, error: "accountId 无效" };

    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };

    // Count peers already bound to this (provider, account), excluding this card
    // so a re-bind / no-op is idempotent and never trips the limit.
    // Capacity is by SHARES (份): used (excluding this card) + this card's weight ≤ ACCOUNT_SHARE_CAPACITY.
    const need = cardWeight(record);
    const used = this.usedShares(provider, accountId, id);
    if (used + need > ACCOUNT_SHARE_CAPACITY) {
      return {
        ok: false,
        error: `该账号份额不足（已用 ${used}/${ACCOUNT_SHARE_CAPACITY} 份，本卡需 ${need} 份），无法绑定`,
      };
    }

    record.bindings = { ...(record.bindings || {}), [provider]: accountId };
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  unbindAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const provider = String(payload?.provider || "").trim();
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };
    if (provider) {
      if (record.bindings) delete record.bindings[provider];
      if (String(record.provider || "") === provider) {
        record.provider = "";
        record.boundAccountId = 0;
      }
    } else {
      record.bindings = {};
      record.provider = "";
      record.boundAccountId = 0;
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  /**
   * 一次性设置一张卡的全部绑定(绑定弹窗"保存"用)。bindings 是期望的最终映射:
   * { codex?: accountId, antigravity?: accountId };某 provider 缺省或 ≤0 = 设为池子
   * (不绑)。先校验每个要绑的号份额够(排除本卡自身),全部通过才一次性写入 ——
   * 避免前端分别调 bind/unbind 并发读写同一个 json 打架。
   */
  setAccessKeyBindings(payload: any) {
    const id = String(payload?.id || "");
    const desired: Record<string, number> =
      payload?.bindings && typeof payload.bindings === "object" ? payload.bindings : {};
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };

    const need = cardWeight(record);
    const nextBindings: Record<string, number> = {};
    for (const provider of ["codex", "antigravity", "anthropic"]) {
      const accountId = Number(desired[provider] || 0);
      if (!(accountId > 0)) continue; // 该 provider → 池子模式(不绑)
      // 份额:目标号已用(排除本卡) + 本卡份额 ≤ ACCOUNT_SHARE_CAPACITY。
      const used = this.usedShares(provider, accountId, id);
      if (used + need > ACCOUNT_SHARE_CAPACITY) {
        const label = provider === "codex" ? "Codex" : provider === "anthropic" ? "Claude" : "Antigravity";
        return {
          ok: false,
          error: `${label} 所选账号份额不足（已用 ${used}/${ACCOUNT_SHARE_CAPACITY} 份，本卡需 ${need} 份）`,
        };
      }
      nextBindings[provider] = accountId;
    }
    record.bindings = nextBindings; // {} = 纯池子卡
    // 清掉历史单绑字段,避免与 bindings 冲突。
    record.provider = "";
    record.boundAccountId = 0;
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  /** Clear bindings that point at a deleted account, so no card is orphaned. */
  clearBindingsForAccount(provider: string, accountId: number) {
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let changed = false;
    for (const key of keys) {
      if (this.keyBoundAccount(key, provider) === accountId) {
        if (key.bindings) delete key.bindings[provider];
        if (String(key.provider || "") === provider) {
          key.provider = "";
          key.boundAccountId = 0;
        }
        changed = true;
      }
    }
    if (changed) writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
  }

  /** Account-pool file for a provider. */
  private poolFileFor(provider: string): string {
    const fileName =
      provider === "codex" ? "codex-accounts.json" : provider === "anthropic" ? "anthropic-accounts.json" : "accounts.json";
    return path.join(this.ctx.dataDir, fileName);
  }

  /**
   * Shares consumed per account in a pool (sum of LIVE bound cards' weights).
   * Non-active records don't count (see isLiveKey) — this is what frees a
   * terminal subscription's seat for autoAssignSeats without touching the
   * record itself.
   */
  boundSharesByAccount(provider: string): Map<number, number> {
    const data = readJson(path.join(this.ctx.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const m = new Map<number, number>();
    for (const key of keys) {
      if (!this.isLiveKey(key)) continue;
      const acc = this.keyBoundAccount(key, provider);
      if (acc > 0) m.set(acc, (m.get(acc) || 0) + cardWeight(key));
    }
    return m;
  }

  /**
   * "配额未耗尽" — does the account still have upstream quota to lease?
   * Unknown (no snapshot yet, e.g. a freshly imported account) counts as
   * available so new accounts are bindable; only a KNOWN, fully-drained window
   * excludes it. Codex quota is account-level (the "codex" key); antigravity is
   * per-model, so it's exhausted only when EVERY known model window is drained.
   * getModelQuotaFraction already treats a passed reset time as refilled.
   */
  private accountHasQuota(provider: string, account: any): boolean {
    if (provider === "codex" || provider === "anthropic") {
      // Account-level single-window quota. codex stores it under the "codex" key;
      // the anthropic PRODUCT hosts the "claude" MODEL, whose window is stored under
      // the "claude" model key (kept model-level on rename). Map product→model key.
      const modelKey = provider === "anthropic" ? "claude" : provider;
      const f = getModelQuotaFraction(account, modelKey);
      return f === null || f > 0;
    }
    const fractions = account?.modelQuotaFractions;
    if (!fractions || typeof fractions !== "object") return true; // unknown → assume ok
    const models = Object.keys(fractions);
    if (!models.length) return true;
    return models.some((model) => {
      const f = getModelQuotaFraction(account, model);
      return f === null || f > 0;
    });
  }

  /**
   * Can a card be auto-bound to this account? Mirrors the lease-time eligibility
   * for a BOUND card (enabled + token + provider-specific eligibility) AND the
   * mint-time policy: exact membership-level (planType) match + quota not
   * exhausted.
   *
   * 注意:这里是「绑定卡」的自动分配,故意 NOT 看 poolEnabled。入池/出池只决定一个号要
   * 不要参与「池子卡」的租号轮换(见 lease-service.availableAccounts),与「能不能被绑定」
   * 无关——入池号、出池号都可被自动分配绑定。绑定卡运行时本就无视 poolEnabled
   * (boundAccountId 钉号绕过),自动分配与之保持一致。
   */
  private isAccountBindable(provider: string, account: any, level: string): boolean {
    if (account?.enabled === false) return false;
    if (!(account?.refreshToken || account?.accessToken)) return false;
    if (provider === "antigravity" && !String(account?.projectId || "").trim()) return false;
    if (String(account?.planType || "") !== level) return false;
    return this.accountHasQuota(provider, account);
  }

  /**
   * Auto-assign accounts for `count` cards each consuming `weight` shares,
   * spreading across accounts (most free shares first). Only accounts of the
   * requested membership `level` that are currently bindable (enabled, has a
   * token, eligible, quota not exhausted) are candidates. Returns one accountId
   * per card, or null if no such account has room — callers treat null as "该
   * 等级可用号不足, add more first" and do NOT mint.
   */
  private autoAssignSeats(provider: string, count: number, weight: number, level: string): number[] | null {
    const pool = readJson(this.poolFileFor(provider), { accounts: [] });
    const accounts = (Array.isArray(pool.accounts) ? pool.accounts : []).filter(
      (a: any) => this.isAccountBindable(provider, a, level),
    );
    const shares = this.boundSharesByAccount(provider);
    const remaining: { id: number; free: number }[] = accounts.map((a: any) => ({
      id: Number(a.id),
      free: ACCOUNT_SHARE_CAPACITY - (shares.get(Number(a.id)) || 0),
    }));
    const assigned: number[] = [];
    for (let i = 0; i < count; i++) {
      // Best-fit: among accounts that still have room (free >= weight), pick the
      // one with the SMALLEST free (tightest fit, tie-break by id). This packs
      // 拼车 cards tightly and keeps whole accounts free for 独享 (4-share) cards,
      // instead of scattering across the emptiest accounts.
      const fit = remaining
        .filter((r) => r.free >= weight)
        .sort((a, b) => a.free - b.free || a.id - b.id)[0];
      if (!fit) return null; // 没有号还剩 `weight` 份
      fit.free -= weight;
      assigned.push(fit.id);
    }
    return assigned;
  }

  /**
   * Delete access-key records that are time-expired or have an explicit
   * "expired" status, while preserving records that back active customer
   * subscriptions or belong to migrated legacy cards.
   *
   * A record MUST NOT be deleted if any of the following are true:
   *   1. Its id is present in `subscriptionIds` — it is a subscription shadow
   *      record; expiry of such records is managed by EntitlementSyncService,
   *      not admin cleanup.
   *   2. It has `migratedToCustomerId` set — it is a migrated legacy card whose
   *      CardTokenUsage history is keyed to this record; deleting it orphans
   *      the customer's usage attribution.
   *
   * Runs under the access-keys write lock so a sweep can never land inside
   * another writer's in-flight critical section (e.g. delete a card mid
   * bind-card migration, before its migratedToCustomerId guard is persisted).
   */
  cleanupExpiredKeys(subscriptionIds: ReadonlySet<string> = new Set()) {
    return withAccessKeysWriteLock(() => this.cleanupExpiredKeysLocked(subscriptionIds));
  }

  private cleanupExpiredKeysLocked(subscriptionIds: ReadonlySet<string>) {
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const now = Date.now();
    const filtered = keys.filter((key: any) => {
      // Never delete subscription shadow records — their expiry lifecycle is
      // owned by EntitlementSyncService, not admin maintenance.
      if (subscriptionIds.has(String(key.id || ""))) return true;
      // Never delete migrated-card records — they carry CardTokenUsage history
      // attribution and their backing key may still be active.
      if (key.migratedToCustomerId) return true;

      // Explicitly expired status
      if (String(key.status || "").toLowerCase() === "expired") return false;
      // Compute expiresAt from firstUsedAt + durationMs
      if (key.firstUsedAt && Number(key.durationMs || 0) > 0) {
        const expiresAt = Date.parse(key.firstUsedAt) + Number(key.durationMs);
        if (expiresAt <= now) return false;
      }
      return true;
    });
    const deleted = keys.length - filtered.length;
    if (deleted > 0) {
      writeJson(filePath, { ...data, keys: filtered, updatedAt: nowIso() });
    }
    return { ok: true, deleted };
  }

  /**
   * Delete access-key records that have no bound session client (i.e., no
   * `sessionClientId`), while preserving records that back customer
   * subscriptions or belong to migrated legacy cards.
   *
   * Subscription shadow records intentionally have NO sessionClientId — the
   * session-lease path bypasses the per-card session mechanism entirely.
   * Deleting them would instantly 403 every active paid customer.
   *
   * A record MUST NOT be deleted if any of the following are true:
   *   1. Its id is present in `subscriptionIds` — it is a subscription shadow
   *      record and must never be removed by admin cleanup.
   *   2. It has `migratedToCustomerId` set — it is a migrated legacy card that
   *      belongs to a customer and whose key has been rotated to a `sub_…`
   *      backing value; the per-card session mechanism does not apply to it.
   *
   * Runs under the access-keys write lock (same rationale as cleanupExpiredKeys).
   */
  cleanupUnboundKeys(subscriptionIds: ReadonlySet<string> = new Set()) {
    return withAccessKeysWriteLock(() => this.cleanupUnboundKeysLocked(subscriptionIds));
  }

  private cleanupUnboundKeysLocked(subscriptionIds: ReadonlySet<string>) {
    const filePath = path.join(this.ctx.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const filtered = keys.filter((key: any) => {
      // Never delete subscription shadow records — they have no sessionClientId
      // by design; deleting them kills every active subscription.
      if (subscriptionIds.has(String(key.id || ""))) return true;
      // Never delete migrated-card records — they belong to a customer and
      // were never part of the per-card session mechanism.
      if (key.migratedToCustomerId) return true;

      const clientId = String(key.sessionClientId || "").trim();
      return clientId.length > 0;
    });
    const deleted = keys.length - filtered.length;
    if (deleted > 0) {
      writeJson(filePath, { ...data, keys: filtered, updatedAt: nowIso() });
    }
    return { ok: true, deleted };
  }

  publicAccessKey(key: any) {
    return this.listAccessKeys({}).keys.find((item: { id: string }) => item.id === String(key.id)) || {
      id: String(key.id || ""),
      fullKey: String(key.key || ""),
      key: maskKey(key.key),
      name: String(key.name || ""),
      status: String(key.status || "active"),
    };
  }
}
