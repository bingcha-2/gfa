/**
 * app-surface.controller.spec.ts — desktop client surface (/api/app/*).
 *
 * health 是公开探针;referralSummary 委托 ReferralService.getSummary(当前客户),
 * 由 CustomerJwtGuard + @CurrentCustomer 提供 customerId(此处直接传入桩 CustomerUser)。
 */
import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";

import { AppSurfaceController } from "../app-surface.controller";

describe("AppSurfaceController", () => {
  it("health → { surface: 'app', status: 'ok' }", () => {
    const controller = new AppSurfaceController({} as any);
    expect(controller.health()).toEqual({ surface: "app", status: "ok" });
  });

  it("referralSummary 委托 ReferralService.getSummary(当前客户),原样返回", async () => {
    const summary = {
      referralCode: "ABCD1234",
      referralLink: "http://localhost:3000/account/register?ref=ABCD1234",
      invitees: [],
      rewards: { totalCents: 0, grantedCount: 0 },
      creditCents: 0,
    };
    const referral = { getSummary: vi.fn().mockResolvedValue(summary) };
    const controller = new AppSurfaceController(referral as any);

    const res = await controller.referralSummary({ customerId: "cust-1", email: "a@b.c" } as any);

    expect(referral.getSummary).toHaveBeenCalledWith("cust-1");
    expect(res).toBe(summary);
  });
});
