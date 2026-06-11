import { describe, expect, it, vi } from "vitest";

import { CodexModelCatalog } from "../../remote-codex/codex-model-catalog";
import { AntigravityModelCatalog } from "../../token-server/antigravity-model-catalog";

describe("CodexModelCatalog", () => {
  it("exposes the seed model list with display names and bucket", () => {
    const catalog = new CodexModelCatalog();
    const keys = catalog.list().map((m) => m.key);
    expect(keys).toContain("gpt-5-codex");
    expect(keys).toContain("gpt-5.1-codex-max");
    const info = catalog.list().find((m) => m.key === "gpt-5-codex")!;
    expect(info.displayName).toBe("GPT-5 Codex");
    expect(info.bucket).toBe("codex");
  });

  it("classifies any model into the codex bucket", () => {
    const catalog = new CodexModelCatalog();
    expect(catalog.classify("gpt-5-codex")).toBe("codex");
    expect(catalog.classify("some-future-model")).toBe("codex");
  });

  it("merges upstream models on refresh", async () => {
    const fetcher = vi.fn().mockResolvedValue(["gpt-6-codex", "gpt-5-codex"]);
    const catalog = new CodexModelCatalog({ fetcher });

    await catalog.refresh(async () => ({ token: "access-token", proxyUrl: "http://p:1" }));

    const keys = catalog.list().map((m) => m.key);
    expect(keys).toContain("gpt-6-codex"); // new upstream model added
    expect(keys).toContain("gpt-5-codex"); // seed retained
    // fetcher receives the account's exit proxy so the catalog fetch pins egress IP
    expect(fetcher).toHaveBeenCalledWith("access-token", "http://p:1");
  });

  it("keeps the seed list when refresh fails", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const catalog = new CodexModelCatalog({ fetcher });

    await catalog.refresh(async () => ({ token: "access-token" })); // must not throw

    expect(catalog.list().map((m) => m.key)).toContain("gpt-5-codex");
  });
});

describe("AntigravityModelCatalog", () => {
  it("classifies gemini vs opus buckets", () => {
    const catalog = new AntigravityModelCatalog();
    expect(catalog.classify("gemini-2.5-pro")).toBe("gemini");
    expect(catalog.classify("claude-opus-4-6-thinking")).toBe("opus");
  });

  it("observes models discovered from client-reported quota keys", () => {
    const catalog = new AntigravityModelCatalog();
    catalog.observe(["gemini-3-pro", "claude-sonnet-4-6"]);
    const keys = catalog.list().map((m) => m.key);
    expect(keys).toContain("gemini-3-pro");
    expect(keys).toContain("claude-sonnet-4-6");
  });
});
