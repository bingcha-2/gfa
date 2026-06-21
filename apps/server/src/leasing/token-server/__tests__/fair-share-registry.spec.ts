import { describe, it, expect } from "vitest";

import { FairShareRegistry } from "../fair-share-registry";

describe("FairShareRegistry", () => {
  it("registers and reads trackers by provider, last write wins, ignores empty id", () => {
    const reg = new FairShareRegistry();
    const a: any = { tag: "anthropic" };
    const c: any = { tag: "codex" };
    reg.register("anthropic", a);
    reg.register("codex", c);
    reg.register("", { tag: "ignored" } as any); // empty provider id is a no-op

    expect(reg.get("anthropic")).toBe(a);
    expect(reg.get("codex")).toBe(c);
    expect(reg.get("antigravity")).toBeUndefined();
    expect(reg.get("")).toBeUndefined();

    const a2: any = { tag: "anthropic-2" };
    reg.register("anthropic", a2);
    expect(reg.get("anthropic")).toBe(a2);
  });
});
