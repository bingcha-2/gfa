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
 * EXPIRED/CANCELLED-order activation (by design):
 *   We intentionally widen the CAS to accept not just PENDING but also EXPIRED
 *   (pending-TTL cron fired first) and CANCELLED (order superseded on re-create,
 *   or user-cancelled, while a stale QR was still scannable). In all three cases
 *   the money was genuinely captured — epay confirming a payment means we owe the
 *   customer the plan regardless of our local bookkeeping. The
 *   PENDING-or-EXPIRED-or-CANCELLED guard is the deliberate policy: never drop a
 *   captured payment.
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
 *   Phase 2 — outside tx: call SubscriptionService.activateForOrder (which
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

/** V2 平台公钥(裸 base64,SPKI),用于回调 RSA-SHA256 验签。 */
function resolvePlatformPublicKey(): string {
  return process.env.EPAY_PLATFORM_PUBLIC_KEY ?? "";
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
  async handleNotify(
    body: Record<string, string>,
    opts?: { skipVerify?: boolean },
  ): Promise<"success" | "fail"> {
    const expectedPid = resolveEpayPid();

    if (!opts?.skipVerify) {
      // Step 0: FAIL-CLOSED on missing config.
      const publicKey = resolvePlatformPublicKey();
      if (!publicKey || !expectedPid) {
        this.logger.error(
          `[epay-callback] REFUSING callback — epay not configured (EPAY_PLATFORM_PUBLIC_KEY ${publicKey ? "set" : "MISSING"}, EPAY_PID ${expectedPid ? "set" : "MISSING"}). Failing closed.`,
        );
        return "fail";
      }

      // Step 1: verify signature (V2 RSA-SHA256, 平台公钥).
      if (!verifySign(body, publicKey)) {
        this.logger.warn(`[epay-callback] invalid signature — body=${JSON.stringify(body)}`);
        return "fail";
      }

      // Step 2: check pid.
      if (body.pid !== expectedPid) {
        this.logger.warn(`[epay-callback] pid mismatch: got="${body.pid}" expected="${expectedPid}"`);
        return "fail";
      }
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

    // Step 4: amount check —— 实付必须 ≥ 订单价(允许多付)。
    // 网关「用户承担手续费」开关开启时,客户实付 = 订单价 + 通道费,回调上报的 money 会大于我们下单
    // 的 amountCents —— 这是合法的,不能当欺诈拒掉(否则客户付了钱订单永远激活不了)。只有「少付」或
    // 「金额非法/缺失(NaN)」才判欺诈。多付的差额即网关代收的手续费,记一条日志便于对账。
    const incomingAmountCents = Math.round(parseFloat(body.money) * 100);
    if (!Number.isFinite(incomingAmountCents) || incomingAmountCents < order.amountCents) {
      this.logger.error(
        `[epay-callback] AMOUNT TOO LOW / INVALID — FRAUD SIGNAL: order="${outTradeNo}" expected>=${order.amountCents} got="${body.money}"`,
      );
      return "fail";
    }
    if (incomingAmountCents > order.amountCents) {
      this.logger.log(
        `[epay-callback] overpayment accepted (gateway fee): order="${outTradeNo}" order=${order.amountCents} paid=${incomingAmountCents} fee=${incomingAmountCents - order.amountCents}`,
      );
    }

    // Step 5 — Phase 1: fast Prisma-only transaction (no file I/O).
    // CAS the order PENDING|EXPIRED|CANCELLED→PAID; only the winner proceeds.
    const referralPercent = resolveReferralPercent();

    let claimed = false;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        // Compare-and-swap: flip to PAID ONLY if still PENDING, EXPIRED or CANCELLED.
        // PENDING is the normal case. EXPIRED/CANCELLED are intentionally accepted:
        // epay confirming TRADE_SUCCESS means money was captured, so a late callback
        // that lost a race against our pending-TTL cron (EXPIRED) or that lands on an
        // order superseded/cancelled while a stale QR was still scannable (CANCELLED)
        // still earns the plan — money is never silently dropped.
        // A concurrent second callback (or an already-PAID row) yields count===0.
        const cas = await tx.planOrder.updateMany({
          where: { outTradeNo, status: { in: ["PENDING", "EXPIRED", "CANCELLED"] } },
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
    // activateForOrder internally calls entitlementSync.syncSubscription and writes
    // the order's config snapshot into Subscription.config (catalog activation).
    let updatedSub: Awaited<ReturnType<SubscriptionService["activateForOrder"]>>;
    try {
      updatedSub = await this.subscriptionService.activateForOrder(order);
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

    // Step 6: return success — sync was already done inside activateForOrder.
    return "success";
  }
}
