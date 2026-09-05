import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingAdminService } from "../billing-admin.service";
import { DeviceService } from "../../../account/device/device.service";

describe("editing subscription device limits", () => {
  let row: any;
  let prisma: any;
  let sync: any;
  let service: BillingAdminService;

  beforeEach(() => {
    row = {
      id: "sub-1", customerId: "customer-1", deviceLimit: 1, expiresAt: null,
      config: JSON.stringify({ line: "bind", products: ["codex"], deviceLimit: 1, bindings: { codex: 11 }, usdQuotaByProduct: { codex: { fiveHour: 100, weekly: 500 } } }),
      windowState: JSON.stringify({ usdUsageByProduct: { codex: { used5h: 23, usedWeekly: 87 } } }),
    };
    prisma = { subscription: {
      findUnique: vi.fn(async () => structuredClone(row)),
      findMany: vi.fn(async () => [row, { deviceLimit: 2 }]),
      update: vi.fn(async ({ data }) => { Object.assign(row, data); return structuredClone(row); }),
    } };
    sync = { syncSubscription: vi.fn().mockResolvedValue(undefined) };
    service = new BillingAdminService(prisma, {} as any, {} as any, sync);
  });

  it("updates config, effective login limit and runtime without touching usage or expiry", async () => {
    const before = structuredClone(row);
    const result = await service.updateSubscription(row.id, { deviceLimit: 3 });
    expect(result.previousDeviceLimit).toBe(1);
    expect(row.deviceLimit).toBe(3);
    expect(JSON.parse(row.config)).toEqual({ ...JSON.parse(before.config), deviceLimit: 3 });
    expect(row.windowState).toBe(before.windowState);
    expect(row.expiresAt).toBeNull();
    expect(sync.syncSubscription).toHaveBeenCalledWith(expect.objectContaining({ deviceLimit: 3, config: row.config }));
    const devices = new DeviceService(prisma);
    expect(await devices.effectiveDeviceLimit(row.customerId)).toBe(3);
    await service.updateSubscription(row.id, { deviceLimit: 1 });
    expect(await devices.effectiveDeviceLimit(row.customerId)).toBe(2);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, "3", null, true])("rejects invalid device count %s without writes", async (deviceLimit) => {
    await expect(service.updateSubscription(row.id, { deviceLimit: deviceLimit as any })).rejects.toThrow("可用设备数");
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(sync.syncSubscription).not.toHaveBeenCalled();
  });

  it("restores both stored device fields and runtime after sync failure", async () => {
    const before = structuredClone(row);
    sync.syncSubscription.mockRejectedValueOnce(new Error("sync failed"));
    await expect(service.updateSubscription(row.id, { deviceLimit: 4 })).rejects.toThrow("sync failed");
    expect(row).toEqual(before);
    expect(sync.syncSubscription).toHaveBeenLastCalledWith(before);
  });

  it("preserves device limit on expiry-only edits", async () => {
    await service.updateSubscription(row.id, { expiresAt: "2030-01-01T00:00:00Z" });
    expect(row.deviceLimit).toBe(1);
    expect(JSON.parse(row.config).deviceLimit).toBe(1);
  });
});
