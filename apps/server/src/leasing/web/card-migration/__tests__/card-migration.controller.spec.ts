/**
 * card-migration.controller.spec.ts — route/guard metadata for
 * POST /api/web/bind-card (global prefix "api" + controller "web").
 */
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { RequestMethod } from "@nestjs/common";

import { CardMigrationController } from "../card-migration.controller";
import { CustomerJwtGuard } from "../../customer-auth/customer-jwt.guard";
import { IS_PUBLIC_KEY } from "../../../../shared/auth/public.decorator";

describe("CardMigrationController metadata", () => {
  it("mounts at web/bind-card via POST", () => {
    expect(Reflect.getMetadata("path", CardMigrationController)).toBe("web");
    const handler = CardMigrationController.prototype.bindCard;
    expect(Reflect.getMetadata("path", handler)).toBe("bind-card");
    expect(Reflect.getMetadata("method", handler)).toBe(RequestMethod.POST);
  });

  it("is @Public() (skips admin guard) but enforces CustomerJwtGuard", () => {
    const handler = CardMigrationController.prototype.bindCard;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    const guards = Reflect.getMetadata("__guards__", handler) ?? [];
    expect(guards).toContain(CustomerJwtGuard);
  });
});
