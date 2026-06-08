import { describe, expect, it } from "vitest";

import { isValidBucket } from "../product-bucket";

describe("isValidBucket", () => {
  it("accepts composite <product>-<family> keys the pools actually serve", () => {
    expect(isValidBucket("antigravity-gemini")).toBe(true);
    expect(isValidBucket("antigravity-claude")).toBe(true);
    expect(isValidBucket("codex-gpt")).toBe(true);
    expect(isValidBucket("anthropic-claude")).toBe(true);
  });

  it("rejects bare family keys — the misconfig that silently never enforces", () => {
    expect(isValidBucket("claude")).toBe(false);
    expect(isValidBucket("gpt")).toBe(false);
    expect(isValidBucket("gemini")).toBe(false);
  });

  it("rejects product/family combos that don't exist and junk", () => {
    expect(isValidBucket("antigravity-gpt")).toBe(false); // antigravity serves gemini+claude only
    expect(isValidBucket("codex-claude")).toBe(false);
    expect(isValidBucket("")).toBe(false);
    expect(isValidBucket("nonsense")).toBe(false);
  });
});
