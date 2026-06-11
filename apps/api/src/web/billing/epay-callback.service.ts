/**
 * epay-callback.service.ts — handle the server-to-server epay payment notify.
 *
 * idempotency contract:
 *   - If the order is already PAID when a callback arrives, return "success"
 *     immediately without re-activating or re-rewarding.
 *   - ReferralReward has @unique planOrderId, so a concurrent duplicate commit
 *     that beats the idempotency check will cause a P2002 which is caught and
 *     treated as already-rewarded.
 *
 * callback response contract (epay expectation):
 *   - "success"  — we durably accepted the TRADE_SUCCESS (or it was already PAID)
 *   - "success"  — signed notification for a non-TRADE_SUCCESS terminal status
 *     (acked without action, stops retries)
 *   - "fail"     — invalid signature, wrong pid, amount mismatch, unknown order,
 *     or any other error
 *
 * Transaction design (two-phase to avoid Prisma interactive-tx timeout):
 *   Phase 1 — fast Prisma-only transaction: mark order PAID, create Notification,
 *             create ReferralReward + increment creditCents. No file I/O inside.
 *   Phase 2 — outside tx: call SubscriptionService.activateOrExtend (which
 *             internally calls EntitlementSyncService.syncSubscription for
 *             access-keys.json writes). Then update order.subscriptionId.
 *   Phase 3 — post-commit: call entitlementSync.syncSubscription again to
 *             guarantee the shadow record is fresh (activateOrExtend already
 *             does this, so the call here is intentionally omitted to avoid
 *             double-sync — the comment and tests document this choice).
 *
 * Atomicity note: marking PAID and creating the reward is atomic in Phase 1.
 * The subscriptionId linkage (Phase 2) is best-effort: if it fails after PAID
 * is committed, the order row has status=PAID but subscriptionId=null. This is
 * visible to operators; the subscription is still active and can be reconciled.
 */
import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";
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
    // Step 1: verify signature (constant-time).
    const epayKey = resolveEpayKey();
    if (!verifySign(body, epayKey)) {
      this.logger.warn(`[epay-callback] invalid signature — body=${JSON.stringify(body)}`);
      return "fail";
    }

    // Step 2: check pid.
    const expectedPid = resolveEpayPid();
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

    // Idempotency: already paid → ack without action.
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
    // Marks order PAID, creates notification, creates referral reward.
    const referralPercent = resolveReferralPercent();

    try {
      await this.prisma.$transaction(async (tx) => {
        // Mark order PAID.
        await tx.planOrder.update({
          where: { outTradeNo },
          data: {
            status: "PAID",
            paidAt: new Date(),
            epayTradeNo: body.trade_no ?? null,
            notifyRaw: JSON.stringify(body),
          },
        });

        // Create billing notification.
        await tx.notification.create({
          data: {
            customerId: order.customerId,
            type: "BILLING",
            title: "套餐已开通",
            body: `您的套餐已成功开通，感谢您的订购。`,
          },
        });

        // Referral reward.
        if (order.referrerId) {
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
      });
    } catch (err: any) {
      this.logger.error(`[epay-callback] transaction failed for out_trade_no="${outTradeNo}": ${err?.message || err}`);
      return "fail";
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
      // Payment is already captured (PAID committed above). Log loudly but
      // don't return "fail" — returning "fail" would cause epay to retry and
      // double-pay. The subscription can be reconciled manually.
      this.logger.error(
        `[epay-callback] subscription activation FAILED for order ${order.id} (PAYMENT ALREADY CAPTURED): ${activateErr?.message || activateErr} — MANUAL RECONCILIATION NEEDED`,
      );
      // Still return "success" so epay doesn't retry (payment is durable).
      return "success";
    }

    // Step 6: return success — sync was already done inside activateOrExtend.
    return "success";
  }
}
