/**
 * rename-device.dto.spec.ts — DTO validation for PATCH /api/account/devices/:id
 *
 * Contract: { name: string ≤60, nonempty after trim }
 * Mirrors the global ValidationPipe config (whitelist + transform), so the
 * @Transform trim runs before @IsNotEmpty / @MaxLength.
 */

import { describe, it, expect } from "vitest";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { RenameDeviceDto } from "../dto/rename-device.dto";

async function validateName(name: unknown) {
  const dto = plainToInstance(RenameDeviceDto, { name });
  const errors = await validate(dto);
  return { dto, errors };
}

describe("RenameDeviceDto", () => {
  it("accepts a normal name", async () => {
    const { errors } = await validateName("My MacBook");
    expect(errors).toHaveLength(0);
  });

  it("accepts a 60-char name (boundary)", async () => {
    const { errors } = await validateName("x".repeat(60));
    expect(errors).toHaveLength(0);
  });

  it("rejects a 61-char name", async () => {
    const { errors } = await validateName("x".repeat(61));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty("maxLength");
  });

  it("rejects an empty name", async () => {
    const { errors } = await validateName("");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty("isNotEmpty");
  });

  it("rejects a whitespace-only name (empty after trim)", async () => {
    const { errors, dto } = await validateName("   ");
    // Transform trims to "" → IsNotEmpty fails
    expect(dto.name).toBe("");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty("isNotEmpty");
  });

  it("trims surrounding whitespace from a valid name", async () => {
    const { errors, dto } = await validateName("  Work Laptop  ");
    expect(errors).toHaveLength(0);
    expect(dto.name).toBe("Work Laptop");
  });

  it("rejects a non-string name", async () => {
    const { errors } = await validateName(42);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty("isString");
  });

  it("rejects a missing name", async () => {
    const dto = plainToInstance(RenameDeviceDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
