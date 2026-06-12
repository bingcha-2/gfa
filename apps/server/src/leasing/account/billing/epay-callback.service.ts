/**
 * epay-callback.service.ts — handle the server-to-server epay payment notify.
 *
 * idempotency contract:
 *   - If the order is already PAID when a callback arrives, return "success"
 *     immediately (pre-tx fast path) without re-activating or re-rewarding.
 *   - The authoritative idempotency guard is a compare-and-swap INSIDE the tx:
 *     updateMany WHERE status="PENDING" → only the FIRST concurrent callback
 *     flips PENDING→PAID (count===1) and proceeds; a racing second callback
 *     sees count===0 and bails as an idempotent success. This prevents two
 *     concurrent callbacks from both activating (a free extra durationDays +
 *     duplicate BILLING notification).
 *   - ReferralReward has @unique planOrderId as a second belt-and-braces guard.
 *
 * EXPIRED-order activation (by design):
 *   The CAS guard matches status="PENDING" only, so a late but validly-signed
 *   TRADE_SUCCESS for an order our reconcile cron has marked EXPIRED will NOT
 *   re-activate here. BUT see below — we intentionally widen the CAS to also
 *   accept EXPIRED because the money was genuinely captured: epay confirming a
 *   payment means we owe the customer the plan even if our pending-TTL fired
 *   first. The PENDING-or-EXPIRED guard is the deliberate policy.
 *
 * callback response contract (epay expectation):
 *   - "success"  — we durably accepted the TRADE_SUCCESS (or it was already PAID,
 *     or a concurrent callback already took it)
 *   - "success"  — signed notification for a non-TRADE_SUCCESS terminal status
 *     (acked without action, stops retries)
 *   - "fail"     — missing/empty epay config, invalid signature, wrong pid,
 *     amount mismatch, unknown order, or a Phase-1 tx error
 *
 * Transaction design (two-phase to avoid Prisma interactive-tx timeout):
 *   Phase 1 — fast Prisma-only transaction: CAS the order PENDING→PAID, create
 *             Notification, create ReferralReward + increment creditCents. No
 *             file I/O inside (sync writes access-keys.json → too slow for a tx).
 *   Phase 2 — outside tx: call SubscriptionService.activateOrExtend (which
 *             internally calls EntitlementSyncService.syncSubscription for
 *             access-keys.json writes). Then update order.subscriptionId.
 *
 * Stranded-payment recovery:
 *   If Phase 2 throws, the order is PAID with subscriptionId=null. We still
 *   return "success" (payment is durable). BillingReconcileService re-drives
 *   such orders idempotently — see that file.
 */
import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { SubscriptionService } from "../../subscription/subscription.service";
import { EntitlementSyncService } from "../../subscription/entitlement-sync.service";
import { verifySign } from "./epay.sign";

function resolveEpayPid(): string {
  return process.env.EPAY_PID ?? "";
}

function resolveEpayKey(): string {
  return process.env.EPAY_KEY ?? "";
}

function resolveReferralPercent(): number {
  const raw = process.env.EPAY_REFERRAL_PERCENT;
  if (!raw) return 10;
  const pct = parseInt(raw, 10);
  return isNaN(pct) || pct < 0 || pct > 100 ? 10 : pct;
}

@Injectable()
export class EpayCallbackService {
  private readonly logger = new Logger(EpayCallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
    private readonly entitlementSync: EntitlementSyncService,
  ) {}

  /**
   * Process an epay payment callback.
   * Returns "success" or "fail" as plain text.
   */
  async handleNotify(body: Record<string, string>): Promise<"success" | "fail"> {
    // Step 0: FAIL-CLOSED on missing config. An empty EPAY_KEY makes every
    // signature forgeable (md5(qs + "") is attacker-computable); an empty
    // EPAY_PID lets a request with no pid field pass the pid check below.
    // Either condition is a misconfiguration that must NEVER fall open.
    const epayKey = resolveEpayKey();
    const expectedPid = resolveEpayPid();
    if (!epayKey || !expectedPid) {
      this.logger.error(
        `[epay-callback] REFUSING callback — epay not configured (EPAY_KEY ${epayKey ? "set" : "MISSING"}, EPAY_PID ${expectedPid ? "set" : "MISSING"}). Failing closed.`,
      );
      return "fail";
    }

    // Step 1: verify signature (constant-time).
    if (!verifySign(body, epayKey)) {
      this.logger.warn(`[epay-callback] invalid signature — body=${JSON.stringify(body)}`);
      return "fail";
    }

    // Step 2: check pid.
    if (body.pid !== expectedPid) {
      this.logger.warn(`[epay-callback] pid mismatch: got="${body.pid}" expected="${expectedPid}"`);
      return "fail";
    }

    // Non-TRADE_SUCCESS statuses that are validly signed:
    // Ack them with "success" to stop epay retries, but don't activate.
    if (body.trade_status !== "TRADE_SUCCESS") {
      this.logger.log(
        `[epay-callback] non-success status="${body.trade_status}" out_trade_no="${body.out_trade_no}" — acking without action`,
      );
      return "success";
    }

    // Step 3: load the order.
    const outTradeNo = body.out_trade_no;
    const order = await this.prisma.planOrder.findUnique({
      where: { outTradeNo },
    });
    if (!order) {
      this.logger.warn(`[epay-callback] unknown out_trade_no="${outTradeNo}"`);
      return "fail";
    }

    // Idempotency fast path: already paid → ack without action. This is an
    // optimization for the common (sequential) replay case; the authoritative
    // guard is the CAS in Phase 1 which handles the concurrent race.
    if (order.status === "PAID") {
      this.logger.log(`[epay-callback] idempotent replay for already-PAID order "${outTradeNo}" — returning success`);
      return "success";
    }

    // Step 4: amount check.
    const incomingAmountCents = Math.round(parseFloat(body.money) * 100);
    if (incomingAmountCents !== order.amountCents) {
      this.logger.error(
        `[epay-callback] AMOUNT MISMATCH — FRAUD SIGNAL: order="${outTradeNo}" expected=${order.amountCents} got=${incomingAmountCents}`,
      );
      return "fail";
    }

    // Step 5 — Phase 1: fast Prisma-only transaction (no file I/O).
    // CAS the order PENDING|EXPIRED→PAID; only the winner proceeds.
    const referralPercent = resolveReferralPercent();

    let claimed = false;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        // Compare-and-swap: flip to PAID ONLY if still PENDING or EXPIRED.
        // PENDING is the normal case. EXPIRED is intentionally accepted: epay
        // confirming TRADE_SUCCESS means money was captured, so a late callback
        // that lost a race against our pending-TTL cron still earns the plan.
        // A concurrent second callback (or an already-PAID row) yields count===0.
        const cas = await tx.planOrder.updateMany({
          where: { outTradeNo, status: { in: ["PENDING", "EXPIRED"] } },
          data: {
            status: "PAID",
            paidAt: new Date(),
            epayTradeNo: body.trade_no ?? null,
            notifyRaw: JSON.stringify(body),
          },
        });
        if (cas.count !== 1) {
          // Lost the race / already taken → no-op, treat as idempotent success.
          return false;
        }

        // Create billing notification.
        await tx.notification.create({
          data: {
            customerId: order.customerId,
            type: "BILLING",
            title: "套餐已开通",
            body: `您的套餐已成功开通，感谢您的订购。`,
          },
        });

        // Referral reward — disabled when EPAY_REFERRAL_PERCENT=0 (no invite payouts).
        if (order.referrerId && referralPercent > 0) {
          const rewardCents = Math.floor(order.amountCents * referralPercent / 100);
          try {
            await tx.referralReward.create({
              data: {
                referrerId: order.referrerId,
                inviteeId: order.customerId,
                planOrderId: order.id,
                amountCents: rewardCents,
                status: "GRANTED",
              },
            });
            await tx.customer.update({
              where: { id: order.referrerId },
              data: { creditCents: { increment: rewardCents } },
            });
            this.logger.log(
              `[epay-callback] referral reward: referrer=${order.referrerId} invitee=${order.customerId} amount=${rewardCents}`,
            );
          } catch (err: any) {
            if (err?.code === "P2002") {
              // planOrderId unique constraint — duplicate callback won the race, ignore.
              this.logger.log(`[epay-callback] duplicate reward attempt for order ${order.id} (P2002) — already granted`);
            } else {
              throw err;
            }
          }
        }
        return true;
      });
    } catch (err: any) {
      this.logger.error(`[epay-callback] transaction failed for out_trade_no="${outTradeNo}": ${err?.message || err}`);
      return "fail";
    }

    if (!claimed) {
      // A concurrent callback already claimed this order; nothing more to do.
      this.logger.log(`[epay-callback] order "${outTradeNo}" already claimed by a concurrent callback — returning success`);
      return "success";
    }

    // Step 5 — Phase 2: activate subscription (outside tx — includes file I/O via sync).
    // activateOrExtend internally calls entitlementSync.syncSubscription.
    let updatedSub: Awaited<ReturnType<SubscriptionService["activateOrExtend"]>>;
    try {
      updatedSub = await this.subscriptionService.activateOrExtend(
        order.customerId,
        order.planId,
        { orderId: order.id },
      );
      // Link subscription id back to the order.
      await this.prisma.planOrder.update({
        where: { id: order.id },
        data: { subscriptionId: updatedSub.id },
      });
    } catch (activateErr: any) {
      // Payment is already captured (PAID committed in Phase 1). We return
      // "success" rather than "fail" NOT to avoid double-charging (an epay
      // notify retry never re-charges the customer) but because the payment is
      // durable and re-driving here is futile — returning "fail" would just
      // make epay retry into the already-PAID short-circuit above, never
      // reaching activation. The order is left PAID + subscriptionId=null for
      // BillingReconcileService to re-drive idempotently.
      this.logger.error(
        `[epay-callback] subscription activation FAILED for order ${order.id} (PAYMENT ALREADY CAPTURED): ${activateErr?.message || activateErr} — reconcile cron will retry`,
      );
      return "success";
    }

    // Step 6: return success — sync was already done inside activateOrExtend.
    return "success";
  }
}
