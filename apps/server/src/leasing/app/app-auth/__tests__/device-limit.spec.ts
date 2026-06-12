/**
 * device-limit.spec.ts — Milestone 6 device-limit enforcement at client login
 *
 * Coverage (spec item 4):
 *   - at limit + new deviceId → 403 DEVICE_LIMIT_EXCEEDED
 *   - at limit + existing ACTIVE deviceId → succeeds (re-login)
 *   - at limit + reactivating REVOKED device → 403 (counts as adding an active device)
 *   - below limit + new device → succeeds
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as bcrypt from "bcrypt";
import { ForbiddenException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { AppAuthService } from "../app-auth.service";
import { CustomerAuthService } from "../../../account/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../../account/customer-auth/customer-token.service";
import { DeviceService } from "../../../account/device/device.service";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<{
  id: string;
  email: string;
  passwordHash: string;
  status: string;
  tokenVersion: number;
}> = {}) {
  return {
    id: overrides.id ?? "cust-1",
    email: overrides.email ?? "user@example.com",
    passwordHash: overrides.passwordHash ?? "$2b$10$placeholder",
    status: overrides.status ?? "ACTIVE",
    emailVerified: false,
    displayName: null,
    tokenVersion: overrides.tokenVersion ?? 0,
    referralCode: "REFCODE1",
    invitedById: null,
    creditCents: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date()
  };
}

function makeDevice(overrides: Partial<{
  id: string;
  customerId: string;
  deviceId: string;
  status: string;
  sessionJti: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "dev-1",
    customerId: overrides.customerId ?? "cust-1",
    deviceId: overrides.deviceId ?? "device-abc",
    name: null,
    platform: null,
    status: overrides.status ?? "ACTIVE",
    lastSeenAt: null,
    lastIp: null,
    sessionJti: overrides.sessionJti ?? null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date()
  };
}

/**
 * Build service under test with controllable device store and limit.
 *
 * @param devices      existing device rows in the DB
 * @param deviceLimit  the limit returned by effectiveDeviceLimit
 */
async function makeServices(options: {
  devices?: ReturnType<typeof makeDevice>[];
  deviceLimit?: number;
} = {}) {
  process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";

  const hash = await bcrypt.hash("password123", 10);
  const customer = makeCustomer({ passwordHash: hash });
  const devices: ReturnType<typeof makeDevice>[] = options.devices ?? [];
  const deviceLimit = options.deviceLimit ?? 1;

  // Prisma stub
  const prisma = {
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.email === customer.email) return customer;
        if (where.id === customer.id) return customer;
        return null;
      }),
      create: vi.fn(),
      update: vi.fn(async ({ where, data }: any) => ({ ...customer, ...data }))
    },
    device: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.customerId_deviceId) {
          return devices.find(
            d =>
              d.customerId === where.customerId_deviceId.customerId &&
              d.deviceId === where.customerId_deviceId.deviceId
          ) ?? null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const dev = makeDevice({ ...data });
        devices.push(dev);
        return dev;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = devices.findIndex(d => d.id === where.id);
        if (idx === -1) return null;
        devices[idx] = { ...devices[idx], ...data };
        return devices[idx];
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const idx = devices.findIndex(
          d =>
            d.customerId === where.customerId_deviceId.customerId &&
            d.deviceId === where.customerId_deviceId.deviceId
        );
        if (idx === -1) {
          const dev = makeDevice({ ...create });
          devices.push(dev);
          return dev;
        }
        devices[idx] = { ...devices[idx], ...update };
        return devices[idx];
      }),
      count: vi.fn(async ({ where }: any) => {
        return devices.filter(d => {
          if (where?.customerId && d.customerId !== where.customerId) return false;
          if (where?.status && d.status !== where.status) return false;
          return true;
        }).length;
      })
    },
    subscription: {
      findFirst: vi.fn(async () => null), // no active subscription in these tests
      findMany: vi.fn(async () => [])     // effectiveDeviceLimit uses findMany
    }
  };

  const jwtService = new JwtService({});
  const tokenService = new CustomerTokenService(jwtService);

  const emailTokenService = {
    issueToken: vi.fn(async () => "plaintext-stub"),
    consumeToken: vi.fn(async () => null)
  };
  const mailService = {
    sendMail: vi.fn(async () => ({ ok: true }))
  };

  const customerAuthService = new CustomerAuthService(
    prisma as any,
    tokenService,
    emailTokenService as any,
    mailService as any
  );

  // Real DeviceService with prisma stub — but override effectiveDeviceLimit
  // to return a fixed value for predictable tests.
  const deviceService = new DeviceService(prisma as any);
  vi.spyOn(deviceService, "effectiveDeviceLimit").mockResolvedValue(deviceLimit);

  const appAuthService = new AppAuthService(
    prisma as any,
    customerAuthService,
    tokenService,
    deviceService
  );

  return { appAuthService, prisma, devices, customer };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AppAuthService.login — device-limit enforcement", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("at limit + new deviceId → 403 DEVICE_LIMIT_EXCEEDED", async () => {
    // Device limit is 1, one ACTIVE device already exists, new deviceId → reject
    const existingDevice = makeDevice({
      id: "dev-existing",
      customerId: "cust-1",
      deviceId: "existing-device",
      status: "ACTIVE"
    });
    const { appAuthService } = await makeServices({
      devices: [existingDevice],
      deviceLimit: 1
    });

    await expect(
      appAuthService.login({
        email: "user@example.com",
        password: "password123",
        deviceId: "brand-new-device"
      })
    ).rejects.toThrow(ForbiddenException);

    try {
      await appAuthService.login({
        email: "user@example.com",
        password: "password123",
        deviceId: "brand-new-device"
      });
    } catch (err: any) {
      expect(err.response.error).toBe("DEVICE_LIMIT_EXCEEDED");
    }
  });

  it("at limit + existing ACTIVE deviceId → succeeds (re-login allowed)", async () => {
    // Device limit is 1, one ACTIVE device for same deviceId → allow (re-login)
    const existingDevice = makeDevice({
      id: "dev-1",
      customerId: "cust-1",
      deviceId: "same-device",
      status: "ACTIVE",
      sessionJti: "old-jti"
    });
    const { appAuthService } = await makeServices({
      devices: [existingDevice],
      deviceLimit: 1
    });

    // Same deviceId as existing ACTIVE device — should succeed
    const result = await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "same-device"
    });

    expect(result.token).toBeDefined();
  });

  it("at limit + reactivating REVOKED device → 403 DEVICE_LIMIT_EXCEEDED", async () => {
    // Device limit is 1, one ACTIVE device exists, trying to reactivate a REVOKED one
    const activeDevice = makeDevice({
      id: "dev-active",
      customerId: "cust-1",
      deviceId: "active-device",
      status: "ACTIVE"
    });
    const revokedDevice = makeDevice({
      id: "dev-revoked",
      customerId: "cust-1",
      deviceId: "revoked-device",
      status: "REVOKED",
      sessionJti: null
    });
    const { appAuthService } = await makeServices({
      devices: [activeDevice, revokedDevice],
      deviceLimit: 1
    });

    // Trying to re-login on the revoked device when limit=1 and 1 ACTIVE exists
    // The revoked device is NOT currently ACTIVE, so it counts as "adding a new active device"
    await expect(
      appAuthService.login({
        email: "user@example.com",
        password: "password123",
        deviceId: "revoked-device"
      })
    ).rejects.toThrow(ForbiddenException);

    try {
      await appAuthService.login({
        email: "user@example.com",
        password: "password123",
        deviceId: "revoked-device"
      });
    } catch (err: any) {
      expect(err.response.error).toBe("DEVICE_LIMIT_EXCEEDED");
    }
  });

  it("below limit + new device → succeeds", async () => {
    // No devices yet, limit=2 → room for a new device
    const { appAuthService } = await makeServices({
      devices: [],
      deviceLimit: 2
    });

    const result = await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "new-device"
    });

    expect(result.token).toBeDefined();
  });

  it("error message is Chinese text about going to web portal", async () => {
    const existingDevice = makeDevice({
      id: "dev-existing",
      customerId: "cust-1",
      deviceId: "existing-device",
      status: "ACTIVE"
    });
    const { appAuthService } = await makeServices({
      devices: [existingDevice],
      deviceLimit: 1
    });

    try {
      await appAuthService.login({
        email: "user@example.com",
        password: "password123",
        deviceId: "brand-new-device"
      });
    } catch (err: any) {
      expect(err.response.error).toBe("DEVICE_LIMIT_EXCEEDED");
      expect(err.response.message).toContain("设备");
    }
  });
});
