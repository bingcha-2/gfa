/**
 * surface-routes.spec.ts
 *
 * Verifies that all admin controllers are registered ONLY under console/
 * (legacy bare aliases removed), that the lease controllers are registered
 * ONLY under app/lease/* (legacy /remote-* aliases removed), that the admin
 * OrderController paths are correct, and that account/app surface skeletons
 * exist.
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

// ---- Lease (desktop client) ----
import { TokenServerController } from "../../leasing/token-server/token-server.controller";
import { RemoteCodexController } from "../../leasing/remote-codex/controller/remote-codex.controller";
import { RemoteAnthropicController } from "../../leasing/remote-anthropic/controller/remote-anthropic.controller";

// ---- Order (admin) ----
import { OrderController } from "../../google-family/order/order.controller";

// ---- Surface skeletons ----
import { AccountSurfaceController } from "../../leasing/account/account-surface.controller";
import { AppSurfaceController } from "../../leasing/app/app-surface.controller";

// ---- Public decorator key ----
import { IS_PUBLIC_KEY } from "../auth/public.decorator";

describe("Surface route normalization — controller path metadata", () => {
  // ---- Admin controllers: console/ only (bare legacy aliases removed) ----

  it.each([
    ["AuthController", AuthController, "console/auth"],
    ["UserController", UserController, "console/users"],
    ["AccountController", AccountController, "console/accounts"],
    ["FamilyGroupController", FamilyGroupController, "console/family-groups"],
    ["RedeemCodeController", RedeemCodeController, "console/redeem-codes"],
    ["TaskController", TaskController, "console/tasks"],
    ["PhonePoolController", PhonePoolController, "console/phone-pool"],
    ["SchedulerController", SchedulerController, "console/scheduler"],
    ["AutomationController", AutomationController, "console/automation"],
    [
      "AgentAccountController",
      AgentAccountController,
      "console/agent-accounts",
    ],
    ["Bulk2faController", Bulk2faController, "console/bulk-2fa"],
    ["ExpireScanController", ExpireScanController, "console/expire-scan"],
    ["AuditLogController", AuditLogController, "console/audit-logs"],
    ["StatsController", StatsController, "console/stats"],
    ["QueueController", QueueController, "console/debug"],
    ["RosettaController", RosettaController, "console/rosetta"],
    ["FaqController", FaqController, "console/faq"],
    ["OrderController", OrderController, "console/orders"],
  ] as const)(
    "%s is registered ONLY on its console/ path",
    (_name, Controller, expectedPath) => {
      expect(Reflect.getMetadata("path", Controller)).toBe(expectedPath);
    }
  );

  // ---- Lease controllers: app/lease/* only (/remote-* aliases removed) ----

  it("TokenServerController is registered only on 'app/lease/antigravity'", () => {
    expect(Reflect.getMetadata("path", TokenServerController)).toBe(
      "app/lease/antigravity"
    );
  });

  it("RemoteCodexController is registered only on 'app/lease/codex'", () => {
    expect(Reflect.getMetadata("path", RemoteCodexController)).toBe(
      "app/lease/codex"
    );
  });

  it("RemoteAnthropicController is registered only on 'app/lease/anthropic'", () => {
    expect(Reflect.getMetadata("path", RemoteAnthropicController)).toBe(
      "app/lease/anthropic"
    );
  });

  // ---- OrderController (admin) method-level paths under console/orders ----
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

  // ---- Account surface skeleton ----

  it("AccountSurfaceController path is 'account'", () => {
    expect(Reflect.getMetadata("path", AccountSurfaceController)).toBe(
      "account"
    );
  });

  it("AccountSurfaceController.health is marked @Public()", () => {
    const proto = AccountSurfaceController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.health)).toBe(true);
  });

  it("AccountSurfaceController.health path is 'health'", () => {
    const proto = AccountSurfaceController.prototype;
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
