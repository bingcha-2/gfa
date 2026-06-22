/**
 * activation-code.controller.spec.ts — 路由/守卫元数据 + 委托。
 *  - account: POST /api/account/activate-code(@Public + CustomerJwtGuard + SkipThrottle)。
 *  - console: console/activation-codes 生成/列表/停用/导出(ConsoleJwtGuard + Roles)。
 */
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { RequestMethod } from "@nestjs/common";

import { ActivationCodeController } from "../activation-code.controller";
import { ActivationCodeAdminController } from "../activation-code-admin.controller";
import { CustomerJwtGuard } from "../../account/customer-auth/customer-jwt.guard";
import { IS_PUBLIC_KEY } from "../../../shared/auth/public.decorator";

describe("ActivationCodeController (account)", () => {
  it("挂在 account/activate-code POST,@Public + CustomerJwtGuard", () => {
    expect(Reflect.getMetadata("path", ActivationCodeController)).toBe("account");
    const handler = ActivationCodeController.prototype.activate;
    expect(Reflect.getMetadata("path", handler)).toBe("activate-code");
    expect(Reflect.getMetadata("method", handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata("__guards__", handler) ?? []).toContain(CustomerJwtGuard);
  });

  it("委托 service.activate(customerId, code)", () => {
    const svc = { activate: vi.fn().mockResolvedValue({ ok: true }) } as any;
    const ctrl = new ActivationCodeController(svc);
    ctrl.activate({ customerId: "cust-1" } as any, { code: "AC-X" } as any);
    expect(svc.activate).toHaveBeenCalledWith("cust-1", "AC-X");
  });
});

describe("ActivationCodeAdminController (console)", () => {
  it("挂在 console/activation-codes", () => {
    expect(Reflect.getMetadata("path", ActivationCodeAdminController)).toBe("console/activation-codes");
    expect(Reflect.getMetadata("path", ActivationCodeAdminController.prototype.generate)).toBe("/");
    expect(Reflect.getMetadata("path", ActivationCodeAdminController.prototype.disable)).toBe(":id/disable");
  });

  it("generate 委托 service 并带 createdById,记审计", async () => {
    const svc = { generate: vi.fn().mockResolvedValue({ count: 2, batchId: "b1", codes: ["a", "b"] }) } as any;
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as any;
    const ctrl = new ActivationCodeAdminController(svc, audit);
    const dto = { selection: { line: "pool" }, count: 2, name: "x" } as any;
    await ctrl.generate(dto, { user: { id: "op-1" } } as any);
    expect(svc.generate).toHaveBeenCalledWith(expect.objectContaining({ count: 2, createdById: "op-1" }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "GENERATE_ACTIVATION_CODES" }));
  });

  it("disable 委托 service 并记审计", async () => {
    const svc = { disable: vi.fn().mockResolvedValue({ ok: true, status: "DISABLED" }) } as any;
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as any;
    const ctrl = new ActivationCodeAdminController(svc, audit);
    await ctrl.disable("ac-1", { user: { id: "op-1" } } as any);
    expect(svc.disable).toHaveBeenCalledWith("ac-1");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "DISABLE_ACTIVATION_CODE", targetId: "ac-1" }));
  });

  it("export 返回该批次码字符串数组", async () => {
    const svc = { list: vi.fn().mockResolvedValue({ items: [{ code: "AC-1" }, { code: "AC-2" }], total: 2 }) } as any;
    const ctrl = new ActivationCodeAdminController(svc, { log: vi.fn() } as any);
    const res = await ctrl.export(undefined, "b1");
    expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ batchId: "b1" }));
    expect(res.codes).toEqual(["AC-1", "AC-2"]);
  });
});
