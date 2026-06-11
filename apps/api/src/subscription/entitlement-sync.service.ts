/**
 * entitlement-sync.service.ts — mirrors Subscription rows into "shadow"
 * AccessKeyRecords in access-keys.json.
 *
 * The whole quota engine (bucket limits, weekly windows, fair-share, billing)
 * keys off record.id == Subscription.id, so a subscription becomes usable by
 * minting a record whose id IS the subscription id and whose key is the
 * subscription's opaque backingKeyValue.
 *
 * Write discipline (single writer, hard requirement):
 *   1. accessKeyStore.flush()        — persist pending in-memory counter deltas
 *                                      so the file read-modify-write keeps them;
 *   2. rosetta.upsertKeyRecord(...)  — THE shared admin writer (atomic write);
 *   3. reload all three pools        — same as rosetta's reloadKeyStores.
 * Steps 1–3 run synchronously (no awaits in between), so the store's debounced
 * flush timer can never interleave and clobber the write.
 *
 * Concurrency (M13b): the WHOLE critical section — seat assignment (which
 * computes free shares by reading the file) through the upsert that consumes
 * those shares and the pool reload — additionally runs under the process-wide
 * access-keys write lock (withAccessKeysWriteLock). Without it, two concurrent
 * purchases both read "1 free share" before either persists, and one upstream
 * account gets double-booked past ACCOUNT_SHARE_CAPACITY.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Subscription } from "@prisma/client";

import { withAccessKeysWriteLock } from "../rosetta/access-key.service";
import { RosettaService } from "../rosetta/rosetta.service";
import { TokenServerService } from "../token-server/token-server.service";
import { RemoteCodexService } from "../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../remote-anthropic/service/remote-anthropic.service";
import { AccessKeyStore } from "../token-server/access-key-store";
import { PrismaService } from "../prisma/prisma.service";

export const VALID_ENTITLEMENT_PRODUCTS = ["antigravity", "codex", "anthropic"] as const;

@Injectable()
export class EntitlementSyncService {
  private readonly logger = new Logger(EntitlementSyncService.name);

  constructor(
    private readonly rosetta: RosettaService,
    @Inject("SHARED_ACCESS_KEY_STORE") private readonly accessKeyStore: AccessKeyStore,
    private readonly tokenServer: TokenServerService,
    private readonly remoteCodex: RemoteCodexService,
    private readonly remoteAnthropic: RemoteAnthropicService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upsert the shadow record for a subscription. Creates it on first sync
   * (auto-assigning upstream seats for plan-backed subs) and refreshes the
   * snapshot-derived fields (limits/weight/window/bindings/expiry) on resync —
   * usage counters and in-memory windows are preserved.
   */
  async syncSubscription(sub: Subscription, opts: { customerEmail?: string } = {}): Promise<void> {
    const products = parseProducts(sub.productEntitlements);
    const bucketLimits = parseObject(sub.bucketLimits);
    // Resolved BEFORE the locked section so the critical section stays free of
    // awaits (an await inside would let other async writers interleave between
    // the seat computation and the write that consumes the seats).
    const customerEmail = opts.customerEmail ?? (await this.lookupCustomerEmail(sub.customerId));

    // The seat assignment + record write + pool reload run as ONE serialized,
    // fully SYNCHRONOUS critical section (see module doc "Concurrency"): the
    // free-share read and the share-consuming write must be atomic w.r.t.
    // every other access-keys.json mutation, or two concurrent purchases
    // double-book the same upstream account past capacity.
    let assignedBindings: Record<string, number> | null = null;
    await withAccessKeysWriteLock(() => {
      const existing = this.accessKeyStore.findById(sub.id);

      let bindings = parseObject(sub.bindings);
      if (!existing && sub.planId) {
        // NEW plan-backed record → auto-assign one open-seat account per product,
        // at the plan's membership level, reusing the card-mint binding logic.
        // A failed product is logged LOUDLY and left unbound (TODO M13 hardening:
        // retry queue / operator alert) — never fail the whole sync, the customer
        // just paid.
        bindings = {};
        const levels = parseObject(sub.levels);
        for (const product of products) {
          const level = String(levels[product] || "").trim();
          if (!level) {
            this.logger.error(
              `[entitlement-sync] subscription ${sub.id}: no membership level configured for product "${product}" — leaving it UNBOUND (plan ${sub.planId})`,
            );
            continue;
          }
          const accountId = this.rosetta.assignSeatForProduct(product, sub.weight, level);
          if (!accountId) {
            this.logger.error(
              `[entitlement-sync] subscription ${sub.id}: seat assignment FAILED for product "${product}" level "${level}" weight ${sub.weight} — no account with free shares; leaving it UNBOUND (TODO M13 hardening)`,
            );
            continue;
          }
          bindings[product] = accountId;
        }
        assignedBindings = bindings;
      }

      // flush → write → reload, synchronously (see module doc).
      this.accessKeyStore.flush();
      const result = this.rosetta.upsertKeyRecord(
        {
          id: sub.id,
          key: sub.backingKeyValue,
          name: `订阅:${customerEmail}`,
          status: "active",
          weight: sub.weight,
          windowMs: sub.windowMs,
          weeklyTokenLimit: sub.weeklyTokenLimit ?? 0,
          bucketLimits: Object.keys(bucketLimits).length > 0 ? bucketLimits : null,
          bindings,
          products,
          // Plan-backed records must HOLD a seat to lease (M13b): when seat
          // assignment failed for every product (binding-less record), the
          // lease path denies instead of falling through to the broad dynamic
          // pool. planId-null subs (migrated legacy cards) are pool cards by
          // design → field left untouched (undefined is skipped by the upsert).
          requiresBinding: sub.planId ? true : undefined,
          // ABSOLUTE expiry (keyExpiresAt() reads it ahead of firstUsedAt+durationMs).
          // null expiry (migrated never-used card) → field stays unset.
          keyExpiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : null,
        },
        { createIfMissing: true },
      );
      if (!result.ok) {
        throw new Error(`[entitlement-sync] shadow record upsert failed for subscription ${sub.id}: ${result.error}`);
      }
      this.reloadPools();
    });

    // Persist the assigned seats back into the subscription snapshot so future
    // resyncs (extend) re-apply the same seats. Outside the lock — the seats
    // are already consumed in the file; this is only the Prisma mirror.
    if (assignedBindings) {
      try {
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { bindings: JSON.stringify(assignedBindings) },
        });
      } catch (err: any) {
        this.logger.error(`[entitlement-sync] subscription ${sub.id}: persisting bindings snapshot failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * Mark a subscription's shadow record expired (store rejects non-active
   * records at resolve time). The record, its usage history AND its bindings
   * are retained — the upstream seat is still released, because share
   * accounting (AccessKeyService.usedShares / boundSharesByAccount) only
   * counts ACTIVE records' bindings. Flipping the status to "expired" is
   * therefore sufficient to free the seat for reassignment; the bindings stay
   * as attribution history and the dead record can never lease again.
   *
   * Intentionally synchronous and NOT behind the write lock: the body is a
   * single flush→upsert→reload sequence with no awaits, which Node's event
   * loop already makes atomic w.r.t. every other writer; callers
   * (SubscriptionService.expire/cancel) rely on the record being expired the
   * moment this returns.
   */
  expireShadowRecord(subscriptionId: string): void {
    this.accessKeyStore.flush();
    const result = this.rosetta.upsertKeyRecord(
      { id: subscriptionId, status: "expired" },
      { createIfMissing: false },
    );
    if (!result.ok) {
      this.logger.warn(`[entitlement-sync] expireShadowRecord: record ${subscriptionId} not found (${result.error})`);
      return;
    }
    this.reloadPools();
  }

  /** Mirror rosetta's reloadKeyStores: all three pools share the store file. */
  private reloadPools(): void {
    this.tokenServer.reloadAccessKeys();
    this.remoteCodex.reloadAccessKeys();
    this.remoteAnthropic.reloadAccessKeys();
  }

  private async lookupCustomerEmail(customerId: string): Promise<string> {
    try {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { email: true },
      });
      return customer?.email || customerId;
    } catch {
      return customerId;
    }
  }
}

function parseProducts(json: string | null): string[] {
  const valid = new Set<string>(VALID_ENTITLEMENT_PRODUCTS);
  try {
    const parsed = JSON.parse(String(json || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => String(p)).filter((p) => valid.has(p));
  } catch {
    return [];
  }
}

function parseObject(json: string | null): Record<string, any> {
  try {
    const parsed = JSON.parse(String(json || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
