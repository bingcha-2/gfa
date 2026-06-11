/**
 * app-auth.service.spec.ts
 *
 * Tests for AppAuthService: Device upsert on login, heartbeat, logout.
 *
 * Coverage (spec item 5):
 *   - login creates Device row with sessionJti
 *   - second login same deviceId updates (does NOT duplicate)
 *   - REVOKED device re-login reactivates to ACTIVE
 *   - heartbeat updates lastSeenAt
 *   - heartbeat with stale jti → DEVICE_REVOKED
 *   - logout clears sessionJti
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as bcrypt from "bcrypt";
import { ForbiddenException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { AppAuthService } from "../app-auth.service";
import { CustomerAuthService } from "../../../web/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../../web/customer-auth/customer-token.service";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<{
  id: string;
  email: string;
  passwordHash: string;
  status: string;
  emailVerified: boolean;
  displayName: string | null;
  tokenVersion: number;
  referralCode: string;
  invitedById: string | null;
  creditCents: number;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "cust-1",
    email: overrides.email ?? "user@example.com",
    passwordHash: overrides.passwordHash ?? "$2b$10$placeholder",
    status: overrides.status ?? "ACTIVE",
    emailVerified: overrides.emailVerified ?? false,
    displayName: overrides.displayName ?? null,
    tokenVersion: overrides.tokenVersion ?? 0,
    referralCode: overrides.referralCode ?? "REFCODE1",
    invitedById: overrides.invitedById ?? null,
    creditCents: overrides.creditCents ?? 0,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date()
  };
}

function makeDevice(overrides: Partial<{
  id: string;
  customerId: string;
  deviceId: string;
  name: string | null;
  platform: string | null;
  status: string;
  lastSeenAt: Date | null;
  lastIp: string | null;
  sessionJti: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "dev-1",
    customerId: overrides.customerId ?? "cust-1",
    deviceId: overrides.deviceId ?? "device-abc",
    name: overrides.name ?? null,
    platform: overrides.platform ?? null,
    status: overrides.status ?? "ACTIVE",
    lastSeenAt: overrides.lastSeenAt ?? null,
    lastIp: overrides.lastIp ?? null,
    sessionJti: overrides.sessionJti ?? null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date()
  };
}

/**
 * Build a full AppAuthService with mocked Prisma and real CustomerAuthService.
 */
async function makeAppAuthService(options: {
  customer?: ReturnType<typeof makeCustomer>;
  devices?: ReturnType<typeof makeDevice>[];
} = {}) {
  process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";

  const hash = await bcrypt.hash("password123", 10);
  const customer = options.customer ?? makeCustomer({ passwordHash: hash });
  const devices: ReturnType<typeof makeDevice>[] = options.devices ?? [];

  // Prisma stub
  const prisma = {
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.email) return where.email === customer.email ? customer : null;
        if (where.id) return where.id === customer.id ? customer : null;
        if (where.referralCode) return null; // not needed here
        return null;
      }),
      create: vi.fn(),
      update: vi.fn(async ({ where, data }: any) => {
        const c = { ...customer, ...data };
        if (data.tokenVersion?.increment != null) {
          c.tokenVersion = customer.tokenVersion + data.tokenVersion.increment;
        }
        return c;
      })
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
      })
    },
    subscription: {
      findFirst: vi.fn(async () => null) // no subscriptions in these tests
    }
  };

  const jwtService = new JwtService({});
  const tokenService = new CustomerTokenService(jwtService);
  const customerAuthService = new CustomerAuthService(prisma as any, tokenService);
  const appAuthService = new AppAuthService(prisma as any, customerAuthService, tokenService);

  return { appAuthService, tokenService, prisma, customer, devices };
}

// ── login ─────────────────────────────────────────────────────────────────────

describe("AppAuthService.login", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("creates a Device row with sessionJti on first login", async () => {
    const { appAuthService, prisma } = await makeAppAuthService();

    const result = await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "device-abc",
      deviceName: "My Mac"
    });

    expect(result.token).toBeDefined();
    expect(result.tokenExpiresAt).toBeInstanceOf(Date);
    expect(result.account.email).toBe("user@example.com");

    // Device was created (not updated) since no existing device
    expect(prisma.device.create).toHaveBeenCalledOnce();
    const createData = prisma.device.create.mock.calls[0][0].data;
    expect(createData.deviceId).toBe("device-abc");
    expect(createData.name).toBe("My Mac");
    expect(createData.sessionJti).toBeTruthy();
  });

  it("second login with same deviceId updates (does not create duplicate)", async () => {
    const existingDevice = makeDevice({
      customerId: "cust-1",
      deviceId: "device-abc",
      sessionJti: "old-jti",
      status: "ACTIVE"
    });
    const { appAuthService, prisma } = await makeAppAuthService({
      devices: [existingDevice]
    });

    await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "device-abc"
    });

    // Should update, not create
    expect(prisma.device.create).not.toHaveBeenCalled();
    expect(prisma.device.update).toHaveBeenCalledOnce();

    // sessionJti should be updated (new login → new jti)
    const updateData = prisma.device.update.mock.calls[0][0].data;
    expect(updateData.sessionJti).toBeTruthy();
    expect(updateData.sessionJti).not.toBe("old-jti");
  });

  it("REVOKED device re-login reactivates to ACTIVE", async () => {
    const revokedDevice = makeDevice({
      customerId: "cust-1",
      deviceId: "device-abc",
      status: "REVOKED",
      sessionJti: "revoked-jti"
    });
    const { appAuthService, prisma } = await makeAppAuthService({
      devices: [revokedDevice]
    });

    await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "device-abc"
    });

    // Should update with status ACTIVE
    const updateData = prisma.device.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("ACTIVE");
  });

  it("token payload includes deviceId and typ=user-session", async () => {
    const { appAuthService, tokenService } = await makeAppAuthService();

    const result = await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "device-xyz"
    });

    const payload = tokenService.verify(result.token);
    expect(payload).not.toBeNull();
    expect(payload!.typ).toBe("user-session");
    expect(payload!.deviceId).toBe("device-xyz");
    expect(payload!.jti).toBeTruthy();
  });

  it("subscription is null when no subscription exists", async () => {
    const { appAuthService } = await makeAppAuthService();

    const result = await appAuthService.login({
      email: "user@example.com",
      password: "password123",
      deviceId: "device-abc"
    });

    expect(result.subscription).toBeNull();
  });
});

// ── heartbeat ─────────────────────────────────────────────────────────────────

describe("AppAuthService.heartbeat", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("updates lastSeenAt and returns ok:true for valid session", async () => {
    const device = makeDevice({
      customerId: "cust-1",
      deviceId: "device-abc",
      status: "ACTIVE",
      sessionJti: "live-jti",
      lastSeenAt: new Date("2026-01-01T00:00:00Z")
    });
    const { appAuthService, prisma } = await makeAppAuthService({
      devices: [device]
    });

    const result = await appAuthService.heartbeat({
      customerId: "cust-1",
      jti: "live-jti",
      tokenDeviceId: "device-abc",
      deviceId: "device-abc"
    });

    expect(result.ok).toBe(true);
    expect(result.device.status).toBe("ACTIVE");

    // lastSeenAt was updated
    expect(prisma.device.update).toHaveBeenCalledOnce();
    const updateData = prisma.device.update.mock.calls[0][0].data;
    expect(updateData.lastSeenAt).toBeInstanceOf(Date);
    expect(updateData.lastSeenAt.getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00Z").getTime()
    );
  });

  it("stale jti (logged in elsewhere) → DEVICE_REVOKED (403)", async () => {
    const device = makeDevice({
      customerId: "cust-1",
      deviceId: "device-abc",
      status: "ACTIVE",
      sessionJti: "new-jti-after-second-login" // different from token jti
    });
    const { appAuthService } = await makeAppAuthService({ devices: [device] });

    await expect(
      appAuthService.heartbeat({
        customerId: "cust-1",
        jti: "old-jti-from-first-login",
        tokenDeviceId: "device-abc",
        deviceId: "device-abc"
      })
    ).rejects.toThrow(ForbiddenException);

    try {
      await appAuthService.heartbeat({
        customerId: "cust-1",
        jti: "old-jti-from-first-login",
        tokenDeviceId: "device-abc",
        deviceId: "device-abc"
      });
    } catch (err: any) {
      expect(err.response.error).toBe("DEVICE_REVOKED");
    }
  });

  it("REVOKED device status → DEVICE_REVOKED even with matching jti", async () => {
    const device = makeDevice({
      customerId: "cust-1",
      deviceId: "device-abc",
      status: "REVOKED",
      sessionJti: "matching-jti"
    });
    const { appAuthService } = await makeAppAuthService({ devices: [device] });

    await expect(
      appAuthService.heartbeat({
        customerId: "cust-1",
        jti: "matching-jti",
        tokenDeviceId: "device-abc",
        deviceId: "device-abc"
      })
    ).rejects.toThrow(ForbiddenException);
  });

  it("missing device → SESSION_INVALID (401)", async () => {
    const { appAuthService } = await makeAppAuthService({ devices: [] });

    await expect(
      appAuthService.heartbeat({
        customerId: "cust-1",
        jti: "some-jti",
        tokenDeviceId: "unknown-device",
        deviceId: "unknown-device"
      })
    ).rejects.toMatchObject({ response: { error: "SESSION_INVALID" } });
  });
});

// ── logout ────────────────────────────────────────────────────────────────────

describe("AppAuthService.logout", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-customer-secret-that-is-32-chars-long!!";
  });

  it("clears sessionJti (device row kept, status stays ACTIVE)", async () => {
    const device = makeDevice({
      customerId: "cust-1",
      deviceId: "device-abc",
      status: "ACTIVE",
      sessionJti: "active-jti"
    });
    const { appAuthService, prisma } = await makeAppAuthService({
      devices: [device]
    });

    const result = await appAuthService.logout({
      customerId: "cust-1",
      deviceId: "device-abc"
    });

    expect(result.ok).toBe(true);
    expect(prisma.device.update).toHaveBeenCalledOnce();
    const updateData = prisma.device.update.mock.calls[0][0].data;
    expect(updateData.sessionJti).toBeNull();
    // status not changed by logout
    expect(updateData.status).toBeUndefined();
  });

  it("logout for unknown device is a no-op (returns ok:true)", async () => {
    const { appAuthService, prisma } = await makeAppAuthService({ devices: [] });

    const result = await appAuthService.logout({
      customerId: "cust-1",
      deviceId: "ghost-device"
    });

    expect(result.ok).toBe(true);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });
});
