/**
 * subscription-expiry.service.ts — hourly cron that enacts natural expiry on
 * Subscription rows.
 *
 * Why: a shadow record self-expires inside the lease engine (keyExpiresAt), but
 * the Subscription ROW would stay ACTIVE forever — the portal keeps showing an
 * active plan and the resolver keeps mapping session tokens to a dead record.
 * This cron closes that gap: ACTIVE + expiresAt in the past → status EXPIRED +
 * shadow record expired (frees the upstream seat).
 *
 * Properties:
 *   - Idempotent: the where-clause excludes already-EXPIRED/CANCELLED rows, and
 *     the per-row CAS re-checks status AND expiry so a renewal that lands
 *     mid-batch is never clobbered.
 *   - Batch-bounded (EXPIRY_BATCH_LIMIT per tick) with per-sub failure
 *     isolation: one bad row is logged and skipped, the rest proceed.
 *   - Guarded by an in-flight flag against overlapping cron runs.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { EntitlementSyncService } from "./entitlement-sync.service";

/** Safety cap on how many due subscriptions we expire per tick. */
const EXPIRY_BATCH_LIMIT = 200;

@Injectable()
export class SubscriptionExpiryService {
  private readonly logger = new Logger(SubscriptionExpiryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlementSync: EntitlementSyncService,
  ) {}

  /** Hourly tick. Also callable directly (tests / manual ops). */
  @Cron(CronExpression.EVERY_HOUR)
  async expireDue(): Promise<{ expired: number; failed: number }> {
    if (this.running) {
      this.logger.debug("[subscription-expiry] skipping: previous run still in progress");
      return { expired: 0, failed: 0 };
    }
    this.running = true;
    let expired = 0;
    let failed = 0;
    try {
      // `lt` never matches NULL, so never-used migrated cards (expiresAt null)
      // are structurally excluded until their first-use resync arms a date.
      const due = await this.prisma.subscription.findMany({
        where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
        select: { id: true, customerId: true, expiresAt: true },
        orderBy: { expiresAt: "asc" },
        take: EXPIRY_BATCH_LIMIT,
      });
      if (due.length === 0) return { expired, failed };

      this.logger.log(`[subscription-expiry] ${due.length} subscription(s) due for expiry`);

      for (const sub of due) {
        try {
          // CAS: only flip if STILL active and STILL past expiry — a renewal
          // racing this batch (expiry moved into the future) wins.
          const cas = await this.prisma.subscription.updateMany({
            where: { id: sub.id, status: "ACTIVE", expiresAt: { lt: new Date() } },
            data: { status: "EXPIRED" },
          });
          if (cas.count !== 1) continue;
          this.entitlementSync.expireShadowRecord(sub.id);
          expired += 1;
        } catch (err: any) {
          failed += 1;
          // Either the CAS threw (row untouched → retried next tick) or the
          // shadow write threw (row already EXPIRED; the record cannot serve
          // leases anyway — keyExpiresAt mirrors the same past date — and its
          // status self-expires on the next resolve attempt).
          this.logger.error(
            `[subscription-expiry] failed to expire subscription ${sub.id} (customer ${sub.customerId}): ${err?.message || err}`,
          );
        }
      }
      if (expired > 0 || failed > 0) {
        this.logger.log(`[subscription-expiry] expired ${expired} subscription(s), ${failed} failure(s)`);
      }
      return { expired, failed };
    } catch (err: any) {
      this.logger.error(`[subscription-expiry] cron failed: ${err?.message || err}`);
      return { expired, failed };
    } finally {
      this.running = false;
    }
  }
}
