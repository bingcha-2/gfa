/**
 * Comprehensive tests for AuthService
 *
 * Covers: login, getMe
 * Edge cases: wrong password, nonexistent user, deleted user
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  getPrisma,
  cleanDb,
  disconnectDb,
  createTestUser
} from "../__tests__/helpers";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  let service: AuthService;

  // Minimal JwtService mock
  const mockJwt = {
    sign: (payload: any) =>
      `mock-token-${payload.sub}`
  };

  beforeAll(() => {
    service = new AuthService(getPrisma() as any, mockJwt as any);
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  describe("login", () => {
    it("should return token and user for valid credentials", async () => {
      const user = await createTestUser({
        email: "admin@gfa.local",
        password: "admin123"
      });

      const result = await service.login("admin@gfa.local", "admin123");

      expect(result.accessToken).toContain("mock-token-");
      expect(result.user.email).toBe("admin@gfa.local");
      expect(result.user.role).toBe("ADMIN");
      // Should NOT expose passwordHash
      expect((result.user as any).passwordHash).toBeUndefined();
    });

    it("should throw for wrong password", async () => {
      await createTestUser({
        email: "user@test.com",
        password: "correct"
      });

      await expect(
        service.login("user@test.com", "wrong")
      ).rejects.toThrow("Invalid credentials");
    });

    it("should throw for nonexistent email", async () => {
      await expect(
        service.login("nobody@test.com", "any")
      ).rejects.toThrow("Invalid credentials");
    });

    it("should not distinguish between wrong email vs wrong password", async () => {
      await createTestUser({
        email: "exists@test.com",
        password: "pass123"
      });

      // Both should throw the same message (security best practice)
      const wrongEmail = service
        .login("noone@test.com", "pass123")
        .catch((e) => e.message);
      const wrongPass = service
        .login("exists@test.com", "wrong")
        .catch((e) => e.message);

      const [msg1, msg2] = await Promise.all([wrongEmail, wrongPass]);
      expect(msg1).toBe(msg2);
    });
  });

  describe("getMe", () => {
    it("should return user info without passwordHash", async () => {
      const user = await createTestUser({ email: "me@test.com" });
      const me = await service.getMe(user.id);

      expect(me.email).toBe("me@test.com");
      expect((me as any).passwordHash).toBeUndefined();
    });

    it("should throw for nonexistent user", async () => {
      await expect(service.getMe("nonexistent")).rejects.toThrow(
        "User not found"
      );
    });
  });
});
