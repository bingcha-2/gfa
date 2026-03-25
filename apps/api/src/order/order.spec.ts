import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanDb,
  createTestAccount,
  createTestFamilyGroup,
  createTestRedeemCode,
  disconnectDb,
  getPrisma
} from "../__tests__/helpers";
import { OrderService } from "./order.service";

describe("OrderService", () => {
  let service: OrderService;
  const db = getPrisma();

  beforeAll(() => {
    service = new OrderService(
      db as any,
      {
        verifyAndReserve: async () => null,
        markUsed: async () => null
      } as any,
      {
        findAvailableGroup: async () => null
      } as any,
      {
        add: async () => ({ id: "invite-job" })
      } as any,
      {
        add: async () => ({ id: "replace-job" })
      } as any
    );
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  describe("findByRedeemCode", () => {
    it("should return masked public order payload for a used redeem code", async () => {
      const redeemCode = await createTestRedeemCode(undefined, {
        code: "LOOKUP-CODE-001",
        status: "USED"
      });

      const order = await db.order.create({
        data: {
          orderNo: "GFA-LOOKUP-001",
          redeemCodeId: redeemCode.id,
          userEmail: "lookup.user@gmail.com",
          status: "TASK_QUEUED",
          resultMessage: "Invite task queued"
        }
      });

      const found = await service.findByRedeemCode("lookup-code-001");

      expect(found.orderNo).toBe(order.orderNo);
      expect(found.userEmail).toBe("lo***@gmail.com");
      expect(found.status).toBe("TASK_QUEUED");
      expect(found.resultMessage).toBe("Invite task queued");
    });

    it("should throw when the redeem code has no linked order", async () => {
      await createTestRedeemCode(undefined, {
        code: "LOOKUP-CODE-EMPTY"
      });

      await expect(service.findByRedeemCode("LOOKUP-CODE-EMPTY")).rejects.toThrow(
        "Order not found"
      );
    });

    it("should throw for nonexistent redeem code", async () => {
      await expect(service.findByRedeemCode("MISSING-CODE")).rejects.toThrow(
        "Order not found"
      );
    });
  });

  describe("redeem", () => {
    it("should leave the redeem code RESERVED until the order is completed", async () => {
      const account = await createTestAccount();
      const group = await createTestFamilyGroup(account.id, { availableSlots: 5 });
      const redeemCode = await createTestRedeemCode(undefined, {
        code: "REDEEMCODE000001"
      });
      let markUsedCalls = 0;

      const redeemService = new OrderService(
        db as any,
        {
          verifyAndReserve: async (code: string) => {
            if (code === "REDEEMCODE000001") {
              await db.redeemCode.update({
                where: { id: redeemCode.id },
                data: { status: "RESERVED" }
              });

              return redeemCode;
            }

            return null;
          },
          markUsed: async () => {
            markUsedCalls += 1;
          }
        } as any,
        {
          findAvailableGroup: async () => group.id
        } as any,
        {
          add: async () => ({ id: "invite-job" })
        } as any,
        {
          add: async () => ({ id: "replace-job" })
        } as any
      );

      const result = await redeemService.redeem("REDEEMCODE000001", "buyer@example.com");
      const updatedCode = await db.redeemCode.findUnique({
        where: { id: redeemCode.id }
      });

      expect(result.status).toBe("TASK_QUEUED");
      expect(markUsedCalls).toBe(0);
      expect(updatedCode!.status).toBe("RESERVED");
      expect(updatedCode!.usedAt).toBeNull();
    });
  });
});
