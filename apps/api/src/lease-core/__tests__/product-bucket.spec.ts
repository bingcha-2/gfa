import { describe, expect, it } from "vitest";

import {
  modelFamily,
  bucketKey,
  parseBucket,
  bucketFamily,
  bucketLabel,
  bucketsForProduct,
  bucketsForProducts,
  type Product,
} from "../product-bucket";

describe("modelFamily", () => {
  it("classifies Gemini models", () => {
    expect(modelFamily("gemini-3-pro")).toBe("gemini");
    expect(modelFamily("gemini-2.5-flash")).toBe("gemini");
  });

  it("classifies OpenAI/Codex models as gpt", () => {
    expect(modelFamily("gpt-5-codex")).toBe("gpt");
    expect(modelFamily("gpt-5.2")).toBe("gpt");
  });

  it("classifies Claude (and everything else) as claude", () => {
    expect(modelFamily("claude-opus-4-6-thinking")).toBe("claude");
    expect(modelFamily("claude-sonnet-4-6")).toBe("claude");
    expect(modelFamily("some-future-model")).toBe("claude");
  });
});

describe("bucketKey", () => {
  it("prefixes the product so the same model in different products is a distinct bucket", () => {
    // The crux: the old flat "opus" bucket was shared by antigravity + anthropic.
    // Composite keys split it by product so a card covering both never cross-counts.
    expect(bucketKey("antigravity", "claude-opus-4-6")).toBe("antigravity-claude");
    expect(bucketKey("anthropic", "claude-opus-4-6")).toBe("anthropic-claude");
    expect(bucketKey("antigravity", "gemini-3-pro")).toBe("antigravity-gemini");
    expect(bucketKey("codex", "gpt-5-codex")).toBe("codex-gpt");
  });
});

describe("parseBucket (round-trip)", () => {
  it("splits a composite key back into product and family", () => {
    expect(parseBucket("antigravity-claude")).toEqual({
      product: "antigravity",
      family: "claude",
    });
    expect(parseBucket("codex-gpt")).toEqual({ product: "codex", family: "gpt" });
  });

  it("round-trips bucketKey for every product+model", () => {
    const cases: Array<[Product, string]> = [
      ["antigravity", "gemini-3-pro"],
      ["antigravity", "claude-opus-4-6"],
      ["codex", "gpt-5-codex"],
      ["anthropic", "claude-sonnet-4-6"],
    ];
    for (const [product, model] of cases) {
      const key = bucketKey(product, model);
      expect(parseBucket(key)).toEqual({ product, family: modelFamily(model) });
    }
  });
});

describe("bucketFamily", () => {
  it("reads the family from composite and bare-legacy keys alike", () => {
    expect(bucketFamily("antigravity-gemini")).toBe("gemini");
    expect(bucketFamily("anthropic-claude")).toBe("claude");
    expect(bucketFamily("gemini")).toBe("gemini"); // legacy bare family
    expect(bucketFamily("gpt")).toBe("gpt");
  });
});

describe("bucketsForProduct(s)", () => {
  it("antigravity exposes both gemini and claude buckets", () => {
    expect(bucketsForProduct("antigravity")).toEqual([
      "antigravity-gemini",
      "antigravity-claude",
    ]);
  });

  it("single-family products expose one bucket", () => {
    expect(bucketsForProduct("codex")).toEqual(["codex-gpt"]);
    expect(bucketsForProduct("anthropic")).toEqual(["anthropic-claude"]);
  });

  it("flattens + dedupes across products; empty = all products", () => {
    expect(bucketsForProducts(["codex", "antigravity"])).toEqual([
      "codex-gpt",
      "antigravity-gemini",
      "antigravity-claude",
    ]);
    expect(bucketsForProducts([])).toEqual([
      "antigravity-gemini",
      "antigravity-claude",
      "codex-gpt",
      "anthropic-claude",
    ]);
  });
});

describe("bucketLabel", () => {
  it("gives antigravity-claude and anthropic-claude distinct labels", () => {
    expect(bucketLabel("antigravity-claude")).not.toBe(bucketLabel("anthropic-claude"));
  });
});
