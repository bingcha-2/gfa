/**
 * device.controller.spec.ts — route/guard metadata + response contracts for
 * the device management endpoints (global prefix "api" + controller "web/devices"):
 *
 *   GET   /api/web/devices            → {devices, deviceLimit}
 *   PATCH /api/web/devices/:id        → {ok:true, device}
 *   POST  /api/web/devices/:id/revoke → {ok:true}
 */
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { RequestMethod } from "@nestjs/common";

import { DeviceController } from "../device.controller";
import { CustomerJwtGuard } from "../../customer-auth/customer-jwt.guard";
import { IS_PUBLIC_KEY } from "../../../auth/public.decorator";

const customer = {
  customerId: "cust-1",
  email: "u@test.com",
  deviceId: undefined,
  jti: "jti-1"
};

describe("DeviceController metadata", () => {
  it("mounts at web/devices with GET /, PATCH :id, POST :id/revoke", () => {
    expect(Reflect.getMetadata("path", DeviceController)).toBe("web/devices");

    const list = DeviceController.prototype.list;
    expect(Reflect.getMetadata("path", list)).toBe("/");
    expect(Reflect.getMetadata("method", list)).toBe(RequestMethod.GET);

    const rename = DeviceController.prototype.rename;
    expect(Reflect.getMetadata("path", rename)).toBe(":id");
    expect(Reflect.getMetadata("method", rename)).toBe(RequestMethod.PATCH);

    const revoke = DeviceController.prototype.revoke;
    expect(Reflect.getMetadata("path", revoke)).toBe(":id/revoke");
    expect(Reflect.getMetadata("method", revoke)).toBe(RequestMethod.POST);
  });

  it("is @Public() (skips admin guard) but enforces CustomerJwtGuard at class level", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, DeviceController)).toBe(true);
    const guards = Reflect.getMetadata("__guards__", DeviceController) ?? [];
    expect(guards).toContain(CustomerJwtGuard);
  });
});

describe("DeviceController response contracts", () => {
  it("GET list passes through {devices, deviceLimit} from the service", async () => {
    const payload = { devices: [{ id: "dev-1" }], deviceLimit: 3 };
    const service = { list: vi.fn(async () => payload) };
    const controller = new DeviceController(service as any);

    const result = await controller.list(customer as any);

    expect(service.list).toHaveBeenCalledWith("cust-1");
    expect(result).toEqual(payload);
  });

  it("PATCH rename wraps the device as {ok:true, device}", async () => {
    const device = { id: "dev-1", deviceId: "d1", name: "New Name" };
    const service = { rename: vi.fn(async () => ({ device })) };
    const controller = new DeviceController(service as any);

    const result = await controller.rename(customer as any, "dev-1", { name: "New Name" });

    expect(service.rename).toHaveBeenCalledWith("cust-1", "dev-1", "New Name");
    expect(result).toEqual({ ok: true, device });
  });

  it("POST revoke returns {ok:true}", async () => {
    const service = { revoke: vi.fn(async () => ({ ok: true })) };
    const controller = new DeviceController(service as any);

    const result = await controller.revoke(customer as any, "dev-1");

    expect(service.revoke).toHaveBeenCalledWith("cust-1", "dev-1");
    expect(result).toEqual({ ok: true });
  });
});
