/**
 * surface-routes.spec.ts
 *
 * Verifies that all admin controllers expose both legacy and console/ paths,
 * that legacy remote-token/remote-codex/remote-anthropic paths are untouched,
 * that the admin OrderController paths are correct, and that web/app surface
 * skeletons exist.
 *
 * Uses Reflect.getMetadata() to inspect NestJS decorator metadata without
 * booting the full AppModule (which requires Redis).
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";

// ---- Admin controllers ----
import { AuthController } from "../auth/auth.controller";
import { UserController } from "../auth/user.controller";
import { AccountController } from "../../google-family/account/account.controller";
import { FamilyGroupController } from "../../google-family/family-group/family-group.controller";
import { RedeemCodeController } from "../../google-family/redeem-code/redeem-code.controller";
import { TaskController } from "../../google-family/task/task.controller";
import { PhonePoolController } from "../../google-family/phone-pool/phone-pool.controller";
import { SchedulerController } from "../../google-family/scheduler/scheduler.controller";
import { AutomationController } from "../../google-family/automation/automation.controller";
import { AgentAccountController } from "../../google-family/automation/agent-account.controller";
import { Bulk2faController } from "../../google-family/bulk-2fa/bulk-2fa.controller";
import { ExpireScanController } from "../../google-family/expire-scan/expire-scan.controller";
import { AuditLogController } from "../audit-log/audit-log.controller";
import { StatsController } from "../../google-family/stats.controller";
import { QueueController } from "../../google-family/queue.controller";
import { RosettaController } from "../../leasing/rosetta/rosetta.controller";
import { FaqController } from "../faq/faq.controller";

// ---- Remote (must stay untouched) ----
import { TokenServerController } from "../../leasing/token-server/token-server.controller";
import { RemoteCodexController } from "../../leasing/remote-codex/controller/remote-codex.controller";
import { RemoteAnthropicController } from "../../leasing/remote-anthropic/controller/remote-anthropic.controller";

// ---- Order (admin) ----
import { OrderController } from "../../google-family/order/order.controller";

// ---- Surface skeletons ----
import { WebSurfaceController } from "../../leasing/web/web-surface.controller";
import { AppSurfaceController } from "../../leasing/app/app-surface.controller";

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

  // ---- Remote controllers: dual-registered (legacy + app/lease/<provider>) ----

  it("TokenServerController is registered on ['remote-token', 'app/lease/antigravity']", () => {
    expect(Reflect.getMetadata("path", TokenServerController)).toEqual([
      "remote-token",
      "app/lease/antigravity",
    ]);
  });

  it("RemoteCodexController is registered on ['remote-codex', 'app/lease/codex']", () => {
    expect(Reflect.getMetadata("path", RemoteCodexController)).toEqual([
      "remote-codex",
      "app/lease/codex",
    ]);
  });

  it("RemoteAnthropicController is registered on ['remote-anthropic', 'app/lease/anthropic']", () => {
    expect(Reflect.getMetadata("path", RemoteAnthropicController)).toEqual([
      "remote-anthropic",
      "app/lease/anthropic",
    ]);
  });

  // ---- OrderController (admin) ----

  it("OrderController (admin) is registered on ['orders', 'console/orders']", () => {
    expect(Reflect.getMetadata("path", OrderController)).toEqual([
      "orders",
      "console/orders",
    ]);
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
