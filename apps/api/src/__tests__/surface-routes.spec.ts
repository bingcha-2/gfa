/**
 * surface-routes.spec.ts
 *
 * Verifies that all admin controllers expose both legacy and console/ paths,
 * that legacy remote-token/remote-codex/remote-anthropic paths are untouched,
 * that the OrderController split is correct, and that web/app surface skeletons exist.
 *
 * Uses Reflect.getMetadata() to inspect NestJS decorator metadata without
 * booting the full AppModule (which requires Redis).
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";

// ---- Admin controllers ----
import { AuthController } from "../auth/auth.controller";
import { UserController } from "../auth/user.controller";
import { AccountController } from "../account/account.controller";
import { FamilyGroupController } from "../family-group/family-group.controller";
import { RedeemCodeController } from "../redeem-code/redeem-code.controller";
import { TaskController } from "../task/task.controller";
import { PhonePoolController } from "../phone-pool/phone-pool.controller";
import { SchedulerController } from "../scheduler/scheduler.controller";
import { AutomationController } from "../automation/automation.controller";
import { AgentAccountController } from "../automation/agent-account.controller";
import { Bulk2faController } from "../bulk-2fa/bulk-2fa.controller";
import { ExpireScanController } from "../expire-scan/expire-scan.controller";
import { AuditLogController } from "../audit-log/audit-log.controller";
import { StatsController } from "../stats.controller";
import { QueueController } from "../queue.controller";
import { RosettaController } from "../rosetta/rosetta.controller";
import { FaqController } from "../faq/faq.controller";

// ---- Remote (must stay untouched) ----
import { TokenServerController } from "../token-server/token-server.controller";
import { RemoteCodexController } from "../remote-codex/controller/remote-codex.controller";
import { RemoteAnthropicController } from "../remote-anthropic/controller/remote-anthropic.controller";

// ---- Order split ----
import { OrderController } from "../order/order.controller";
import { OrderPublicController } from "../order/order-public.controller";

// ---- Surface skeletons ----
import { WebSurfaceController } from "../web/web-surface.controller";
import { AppSurfaceController } from "../app/app-surface.controller";

// ---- Public decorator key ----
import { IS_PUBLIC_KEY } from "../auth/public.decorator";

describe("Surface route normalization — controller path metadata", () => {
  // ---- Admin controllers: dual-registered ----

  it.each([
    ["AuthController", AuthController, ["auth", "console/auth"]],
    ["UserController", UserController, ["users", "console/users"]],
    ["AccountController", AccountController, ["accounts", "console/accounts"]],
    [
      "FamilyGroupController",
      FamilyGroupController,
      ["family-groups", "console/family-groups"],
    ],
    [
      "RedeemCodeController",
      RedeemCodeController,
      ["redeem-codes", "console/redeem-codes"],
    ],
    ["TaskController", TaskController, ["tasks", "console/tasks"]],
    [
      "PhonePoolController",
      PhonePoolController,
      ["phone-pool", "console/phone-pool"],
    ],
    [
      "SchedulerController",
      SchedulerController,
      ["scheduler", "console/scheduler"],
    ],
    [
      "AutomationController",
      AutomationController,
      ["automation", "console/automation"],
    ],
    [
      "AgentAccountController",
      AgentAccountController,
      ["agent-accounts", "console/agent-accounts"],
    ],
    ["Bulk2faController", Bulk2faController, ["bulk-2fa", "console/bulk-2fa"]],
    [
      "ExpireScanController",
      ExpireScanController,
      ["admin/expire-scan", "console/expire-scan"],
    ],
    [
      "AuditLogController",
      AuditLogController,
      ["audit-logs", "console/audit-logs"],
    ],
    ["StatsController", StatsController, ["stats", "console/stats"]],
    ["QueueController", QueueController, ["debug", "console/debug"]],
    ["RosettaController", RosettaController, ["rosetta", "console/rosetta"]],
    ["FaqController", FaqController, ["faq", "console/faq"]],
  ] as const)(
    "%s is registered on both legacy and console/ paths",
    (_name, Controller, expectedPaths) => {
      const paths = Reflect.getMetadata("path", Controller);
      expect(paths).toEqual(expectedPaths);
    }
  );

  // ---- Remote controllers: must stay single-string, untouched ----

  it("TokenServerController stays on 'remote-token'", () => {
    expect(Reflect.getMetadata("path", TokenServerController)).toBe(
      "remote-token"
    );
  });

  it("RemoteCodexController stays on 'remote-codex'", () => {
    expect(Reflect.getMetadata("path", RemoteCodexController)).toBe(
      "remote-codex"
    );
  });

  it("RemoteAnthropicController stays on 'remote-anthropic'", () => {
    expect(Reflect.getMetadata("path", RemoteAnthropicController)).toBe(
      "remote-anthropic"
    );
  });

  // ---- OrderController split ----

  it("OrderController (admin) is registered on ['orders', 'console/orders']", () => {
    expect(Reflect.getMetadata("path", OrderController)).toEqual([
      "orders",
      "console/orders",
    ]);
  });

  it("OrderPublicController is registered on 'public'", () => {
    expect(Reflect.getMetadata("path", OrderPublicController)).toBe("public");
  });

  // Final URLs under controller "public" must be identical to the legacy
  // method-level "public/..." paths on the old combined controller.
  it.each([
    ["redeem", "redeem"],
    ["findByOrderNo", "orders/:orderNo"],
    ["findByRedeemCode", "orders/by-code/:code"],
    ["swapAccount", "swap-account"],
    ["swapByEmail", "swap-by-email"],
    ["findSwapStatus", "swap-status/:orderNo"],
    ["subscriptionSwap", "subscription-swap"],
    ["checkMigration", "check-migration"],
    ["selfMigrate", "self-migrate"],
  ] as const)(
    "OrderPublicController.%s method path is '%s'",
    (method, expectedPath) => {
      const proto = OrderPublicController.prototype as Record<string, any>;
      expect(Reflect.getMetadata("path", proto[method])).toBe(expectedPath);
    }
  );

  it.each([
    ["redeem"],
    ["findByOrderNo"],
    ["findByRedeemCode"],
    ["swapAccount"],
    ["swapByEmail"],
    ["findSwapStatus"],
    ["subscriptionSwap"],
    ["checkMigration"],
    ["selfMigrate"],
  ] as const)("OrderPublicController.%s is marked @Public()", (method) => {
    const proto = OrderPublicController.prototype as Record<string, any>;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto[method])).toBe(true);
  });

  // Final admin URLs under ["orders", "console/orders"] must be identical to
  // the legacy method-level "orders..." paths on the old combined controller.
  it.each([
    ["findAll", "/"], // @Get() with no arg → Nest stores "/"
    ["findOne", ":id"],
    ["replaceMember", ":id/replace-member"],
    ["retryOrder", ":id/retry"],
  ] as const)(
    "OrderController.%s method path is '%s'",
    (method, expectedPath) => {
      const proto = OrderController.prototype as Record<string, any>;
      expect(Reflect.getMetadata("path", proto[method])).toBe(expectedPath);
    }
  );

  // ---- Web surface skeleton ----

  it("WebSurfaceController path is 'web'", () => {
    expect(Reflect.getMetadata("path", WebSurfaceController)).toBe("web");
  });

  it("WebSurfaceController.health is marked @Public()", () => {
    const proto = WebSurfaceController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.health)).toBe(true);
  });

  it("WebSurfaceController.health path is 'health'", () => {
    const proto = WebSurfaceController.prototype;
    expect(Reflect.getMetadata("path", proto.health)).toBe("health");
  });

  // ---- App surface skeleton ----

  it("AppSurfaceController path is 'app'", () => {
    expect(Reflect.getMetadata("path", AppSurfaceController)).toBe("app");
  });

  it("AppSurfaceController.health is marked @Public()", () => {
    const proto = AppSurfaceController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.health)).toBe(true);
  });

  it("AppSurfaceController.health path is 'health'", () => {
    const proto = AppSurfaceController.prototype;
    expect(Reflect.getMetadata("path", proto.health)).toBe("health");
  });
});
