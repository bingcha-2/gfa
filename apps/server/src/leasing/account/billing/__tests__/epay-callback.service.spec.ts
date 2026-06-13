/**
 * epay-callback.service.spec.ts — unit tests for EpayCallbackService.
 *
 * All Prisma and subscription dependencies are mocked to isolate billing logic.
 * Covers: happy path, idempotency, security (bad sign/pid/amount/unknown order),
 * referral rewards (with and without referrerId), and post-commit sync call order.
 */
import "reflect-metadata";
import * as crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EpayCallbackService } from "../epay-callback.service";
import { signParams } from "../epay.sign";

// ─── Constants ────────────────────────────────────────────────────────────────
// 平台密钥对(模拟 zhunfu):平台私钥签回调,平台公钥(EPAY_PLATFORM_PUBLIC_KEY)验签。
const _platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PLATFORM_PRIV_B64 = _platform.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const PLATFORM_PUB_B64 = _platform.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const EPAY_PID = "1001";

// ─── Mock builders ────────────────────────────────────────────────────────────

function makeMockPrisma(overrides: Record<string, any> = {}) {
  const defaultReferralReward = {
    create: vi.fn().mockResolvedValue({ id: "rr-1" }),
  };
  const defaultCustomer = {
    update: vi.fn().mockResolvedValue({}),
  };
  const defaultNotification = {
    create: vi.fn().mockResolvedValue({}),
  };
  const defaultPlanOrder = {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  };

  // The $transaction mock runs the callback with a "tx" proxy
  // that mirrors the mock functions above. updateMany is the CAS used to
  // claim the order PENDING→PAID; default count:1 means "this caller won".
  const txProxy = {
    planOrder: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    notification: { create: vi.fn().mockResolvedValue({}) },
    referralReward: { create: vi.fn().mockResolvedValue({ id: "rr-1" }) },
    customer: { update: vi.fn().mockResolvedValue({}) },
  };

  return {
    planOrder: defaultPlanOrder,
    referralReward: defaultReferralReward,
    customer: defaultCustomer,
    notification: defaultNotification,
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(txProxy)),
    _txProxy: txProxy,
    ...overrides,
  } as any;
}

function makeSubscriptionService(sub: any = { id: "sub-1" }) {
  // Phase-2 activation goes through activateForOrder (routes plan vs catalog order).
  return {
    activateForOrder: vi.fn().mockResolvedValue(sub),
  } as any;
}

function makeEntitlementSync() {
  return {
    syncSubscription: vi.fn().mockResolvedValue(undefined),
  } as any;
}

/** Build a valid signed callback body. */
function validBody(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    pid: EPAY_PID,
    trade_no: "epay-trade-123",
    out_trade_no: "gfa-order-1",
    money: "9.90",
    trade_status: "TRADE_SUCCESS",
    ...overrides,
  };
  // sign AFTER applying overrides
  const sign = signParams(base, PLATFORM_PRIV_B64);
  return { ...base, sign_type: "RSA", sign };
}

/** A PENDING catalog order matching the body. */
const pendingOrder = {
  id: "order-db-1",
  customerId: "cust-1",
  catalogVersion: 1,
  config: JSON.stringify({ line: "pool", products: ["antigravity"] }),
  outTradeNo: "gfa-order-1",
  amountCents: 990, // matches money=9.90
  status: "PENDING",
  referrerId: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EpayCallbackService.handleNotify — happy path", () => {
  let prisma: any;
  let subService: any;
  let syncService: any;
  let service: EpayCallbackService;

  beforeEach(() => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", PLATFORM_PUB_B64);
    vi.stubEnv("EPAY_PID", EPAY_PID);

    prisma = makeMockPrisma();
    subService = makeSubscriptionService();
    syncService = makeEntitlementSync();
    service = new EpayCallbackService(prisma, subService, syncService);

    // Default: order is PENDING
    prisma.planOrder.findUnique.mockResolvedValue(pendingOrder);

    // tx.planOrder.update returns the updated order
    prisma._txProxy.planOrder.update.mockResolvedValue(pendingOrder);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 'success' for valid TRADE_SUCCESS callback", async () => {
    const body = validBody();
    const result = await service.handleNotify(body);
    expect(result).toBe("success");
  });

  it("calls activateForOrder with the order (customerId/config/id carried through)", async () => {
    await service.handleNotify(validBody());
    expect(subService.activateForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pendingOrder.id,
        customerId: pendingOrder.customerId,
        catalogVersion: pendingOrder.catalogVersion,
      }),
    );
  });

  it("creates a BILLING notification inside the transaction", async () => {
    await service.handleNotify(validBody());
    expect(prisma._txProxy.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: pendingOrder.customerId,
          type: "BILLING",
        }),
      }),
    );
  });

  it("calls activateForOrder AFTER the transaction commits (post-commit activation)", async () => {
    // Design: Phase 1 = fast tx (PAID + notification + reward), Phase 2 = activateForOrder outside tx.
    // Verify activateForOrder is called AFTER $transaction resolves.
    const callOrder: string[] = [];
    prisma.$transaction.mockImplementation(async (fn: any) => {
      // Preserve the callback's return value (the CAS "claimed" boolean) so the
      // service proceeds to Phase 2; just record commit ordering.
      const claimed = await fn(prisma._txProxy);
      callOrder.push("tx-committed");
      return claimed;
    });
    // Also need planOrder.update for the subscriptionId linkage
    prisma.planOrder.update = vi.fn().mockResolvedValue({});
    subService.activateForOrder.mockImplementation(async () => {
      callOrder.push("activate-called");
      return { id: "sub-1" };
    });

    await service.handleNotify(validBody());

    const txIdx = callOrder.indexOf("tx-committed");
    const activateIdx = callOrder.indexOf("activate-called");
    expect(txIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(txIdx); // activation AFTER tx commit
  });
});

describe("EpayCallbackService.handleNotify — idempotency", () => {
  let prisma: any;
  let subService: any;
  let syncService: any;
  let service: EpayCallbackService;

  beforeEach(() => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", PLATFORM_PUB_B64);
    vi.stubEnv("EPAY_PID", EPAY_PID);

    prisma = makeMockPrisma();
    subService = makeSubscriptionService();
    syncService = makeEntitlementSync();
    service = new EpayCallbackService(prisma, subService, syncService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 'success' for an already-PAID order without re-activating", async () => {
    prisma.planOrder.findUnique.mockResolvedValue({ ...pendingOrder, status: "PAID" });

    const result = await service.handleNotify(validBody());
    expect(result).toBe("success");
    // No transaction should have been started
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(subService.activateForOrder).not.toHaveBeenCalled();
    expect(syncService.syncSubscription).not.toHaveBeenCalled();
  });

  it("idempotent replay: P2002 on referral reward is swallowed (already rewarded)", async () => {
    vi.stubEnv("EPAY_REFERRAL_PERCENT", "10");
    const orderWithReferrer = { ...pendingOrder, referrerId: "referrer-1" };
    prisma.planOrder.findUnique.mockResolvedValue(orderWithReferrer);
    prisma._txProxy.planOrder.update.mockResolvedValue(orderWithReferrer);

    // Simulate P2002 unique constraint violation on second attempt
    const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    prisma._txProxy.referralReward.create.mockRejectedValueOnce(p2002);

    const result = await service.handleNotify(validBody());
    expect(result).toBe("success"); // Not "fail" — P2002 swallowed
    expect(subService.activateForOrder).toHaveBeenCalledOnce();
  });
});

describe("EpayCallbackService.handleNotify — referral rewards", () => {
  let prisma: any;
  let subService: any;
  let syncService: any;
  let service: EpayCallbackService;

  beforeEach(() => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", PLATFORM_PUB_B64);
    vi.stubEnv("EPAY_PID", EPAY_PID);
    vi.stubEnv("EPAY_REFERRAL_PERCENT", "10");

    prisma = makeMockPrisma();
    subService = makeSubscriptionService();
    syncService = makeEntitlementSync();
    service = new EpayCallbackService(prisma, subService, syncService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates ReferralReward with correct amountCents and increments referrer creditCents", async () => {
    const orderWithReferrer = { ...pendingOrder, referrerId: "referrer-1" };
    prisma.planOrder.findUnique.mockResolvedValue(orderWithReferrer);
    prisma._txProxy.planOrder.update.mockResolvedValue(orderWithReferrer);

    await service.handleNotify(validBody());

    // 10% of 990 = 99
    expect(prisma._txProxy.referralReward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referrerId: "referrer-1",
          inviteeId: "cust-1",
          amountCents: 99,
          status: "GRANTED",
        }),
      }),
    );
    expect(prisma._txProxy.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "referrer-1" },
        data: { creditCents: { increment: 99 } },
      }),
    );
  });

  it("does NOT create ReferralReward when order has no referrerId", async () => {
    prisma.planOrder.findUnique.mockResolvedValue(pendingOrder); // referrerId: null
    prisma._txProxy.planOrder.update.mockResolvedValue(pendingOrder);

    await service.handleNotify(validBody());

    expect(prisma._txProxy.referralReward.create).not.toHaveBeenCalled();
    expect(prisma._txProxy.customer.update).not.toHaveBeenCalled();
  });

  it("uses floored integer for reward (Math.floor): 10% of 999 = 99", async () => {
    const order = { ...pendingOrder, amountCents: 999, referrerId: "referrer-1" };
    // Need matching money in body
    const bodyFor999 = ((): Record<string, string> => {
      const base: Record<string, string> = {
        pid: EPAY_PID,
        trade_no: "epay-999",
        out_trade_no: "gfa-order-1",
        money: "9.99",
        trade_status: "TRADE_SUCCESS",
      };
      return { ...base, sign_type: "RSA", sign: signParams(base, PLATFORM_PRIV_B64) };
    })();

    prisma.planOrder.findUnique.mockResolvedValue(order);
    prisma._txProxy.planOrder.update.mockResolvedValue(order);

    await service.handleNotify(bodyFor999);

    expect(prisma._txProxy.referralReward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountCents: 99 }), // floor(999 * 10 / 100) = 99
      }),
    );
  });
});

describe("EpayCallbackService.handleNotify — security", () => {
  let prisma: any;
  let subService: any;
  let syncService: any;
  let service: EpayCallbackService;

  beforeEach(() => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", PLATFORM_PUB_B64);
    vi.stubEnv("EPAY_PID", EPAY_PID);

    prisma = makeMockPrisma();
    subService = makeSubscriptionService();
    syncService = makeEntitlementSync();
    service = new EpayCallbackService(prisma, subService, syncService);

    prisma.planOrder.findUnique.mockResolvedValue(pendingOrder);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 'fail' for tampered sign", async () => {
    const body = { ...validBody(), sign: "00000000000000000000000000000000" };
    const result = await service.handleNotify(body);
    expect(result).toBe("fail");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("returns 'fail' for wrong pid", async () => {
    const bodyWithBadPid = ((): Record<string, string> => {
      const base: Record<string, string> = {
        pid: "9999", // wrong pid but signed correctly with test key
        trade_no: "epay-trade-123",
        out_trade_no: "gfa-order-1",
        money: "9.90",
        trade_status: "TRADE_SUCCESS",
      };
      return { ...base, sign_type: "RSA", sign: signParams(base, PLATFORM_PRIV_B64) };
    })();
    const result = await service.handleNotify(bodyWithBadPid);
    expect(result).toBe("fail");
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("returns 'fail' for amount mismatch (fraud signal)", async () => {
    // Valid sign but money doesn't match order's amountCents
    const fraudBody = ((): Record<string, string> => {
      const base: Record<string, string> = {
        pid: EPAY_PID,
        trade_no: "epay-trade-123",
        out_trade_no: "gfa-order-1",
        money: "1.00", // 100 cents, not 990
        trade_status: "TRADE_SUCCESS",
      };
      return { ...base, sign_type: "RSA", sign: signParams(base, PLATFORM_PRIV_B64) };
    })();
    const result = await service.handleNotify(fraudBody);
    expect(result).toBe("fail");
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("returns 'fail' for unknown out_trade_no", async () => {
    prisma.planOrder.findUnique.mockResolvedValue(null);
    const result = await service.handleNotify(validBody());
    expect(result).toBe("fail");
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("returns 'success' (ack) for validly-signed non-TRADE_SUCCESS status", async () => {
    // A signed TRADE_CLOSED should be ack'd to stop retries, but no activation
    const closedBody = ((): Record<string, string> => {
      const base: Record<string, string> = {
        pid: EPAY_PID,
        trade_no: "epay-trade-123",
        out_trade_no: "gfa-order-1",
        money: "9.90",
        trade_status: "TRADE_CLOSED",
      };
      return { ...base, sign_type: "RSA", sign: signParams(base, PLATFORM_PRIV_B64) };
    })();
    const result = await service.handleNotify(closedBody);
    expect(result).toBe("success");
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("activateForOrder failure after tx commit does NOT cause 'fail' (money already captured)", async () => {
    // Design: Phase 1 (tx) commits PAID, Phase 2 (activateForOrder) fails.
    // Since payment is durably captured, we still return "success" to stop epay retries.
    subService.activateForOrder.mockRejectedValue(new Error("seat assignment failed"));
    const result = await service.handleNotify(validBody());
    // Payment was captured; activation failed; must still return "success" to avoid duplicate charge
    expect(result).toBe("success");
  });

  it("returns 'fail' for array sign (param pollution) without throwing", async () => {
    // sign=a&sign=b parses to an array; verifySign must not 500 on .toLowerCase().
    const body: any = { ...validBody(), sign: ["aaa", "bbb"] };
    const result = await service.handleNotify(body);
    expect(result).toBe("fail");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });
});

describe("EpayCallbackService.handleNotify — fail-closed on missing config", () => {
  let prisma: any;
  let subService: any;
  let syncService: any;
  let service: EpayCallbackService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    subService = makeSubscriptionService();
    syncService = makeEntitlementSync();
    service = new EpayCallbackService(prisma, subService, syncService);
    prisma.planOrder.findUnique.mockResolvedValue(pendingOrder);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 'fail' and does nothing when EPAY_PLATFORM_PUBLIC_KEY is empty (can't verify)", async () => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", "");
    vi.stubEnv("EPAY_PID", EPAY_PID);
    // 空公钥 → Step 0 直接 fail-closed,根本到不了验签;哪怕 body 签名有效也照拒。
    const result = await service.handleNotify(validBody());
    expect(result).toBe("fail");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("returns 'fail' and does nothing when EPAY_PID is empty (pid= bypass)", async () => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", PLATFORM_PUB_B64);
    vi.stubEnv("EPAY_PID", "");
    // An attacker omitting pid (so pid==="" passes the pid check) must be blocked.
    const base: Record<string, string> = {
      pid: "",
      trade_no: "epay-trade-123",
      out_trade_no: "gfa-order-1",
      money: "9.90",
      trade_status: "TRADE_SUCCESS",
    };
    const body = { ...base, sign_type: "RSA", sign: signParams(base, PLATFORM_PRIV_B64) };
    const result = await service.handleNotify(body);
    expect(result).toBe("fail");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });
});

describe("EpayCallbackService.handleNotify — concurrent CAS", () => {
  let prisma: any;
  let subService: any;
  let syncService: any;
  let service: EpayCallbackService;

  beforeEach(() => {
    vi.stubEnv("EPAY_PLATFORM_PUBLIC_KEY", PLATFORM_PUB_B64);
    vi.stubEnv("EPAY_PID", EPAY_PID);
    prisma = makeMockPrisma();
    subService = makeSubscriptionService();
    syncService = makeEntitlementSync();
    service = new EpayCallbackService(prisma, subService, syncService);
    prisma.planOrder.findUnique.mockResolvedValue(pendingOrder);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("loser of the CAS (count===0) returns 'success' without activating or notifying", async () => {
    // Simulate a concurrent callback having already flipped the row: CAS matches nothing.
    prisma._txProxy.planOrder.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.handleNotify(validBody());
    expect(result).toBe("success");
    // No side effects: notification not created, activation not run.
    expect(prisma._txProxy.notification.create).not.toHaveBeenCalled();
    expect(subService.activateForOrder).not.toHaveBeenCalled();
  });

  it("winner of the CAS (count===1) proceeds to notify + activate", async () => {
    prisma._txProxy.planOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.handleNotify(validBody());
    expect(result).toBe("success");
    expect(prisma._txProxy.notification.create).toHaveBeenCalledOnce();
    expect(subService.activateForOrder).toHaveBeenCalledOnce();
  });

  it("CAS WHERE clause restricts to PENDING|EXPIRED|CANCELLED statuses", async () => {
    // EXPIRED/CANCELLED are intentionally accepted: a captured payment must never be
    // dropped, even if our pending-TTL fired (EXPIRED) or the order was superseded /
    // user-cancelled (CANCELLED) while a stale QR was still scannable.
    await service.handleNotify(validBody());
    const casArg = prisma._txProxy.planOrder.updateMany.mock.calls[0][0];
    expect(casArg.where.outTradeNo).toBe("gfa-order-1");
    expect(casArg.where.status).toEqual({ in: ["PENDING", "EXPIRED", "CANCELLED"] });
    expect(casArg.data.status).toBe("PAID");
  });
});
