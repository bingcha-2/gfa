// config-fingerprint.spec.ts — 同配置续费去重的判断键(spec §8)。
// 指纹覆盖「购买意图」:line + 排序后 products + deviceLimit + 用量(号池
// bucketLimits/weeklyTokenLimit)/ levels+weight(绑定);故意 NOT 含 bindings
// (那是座位分配结果,非选配)与 windowMs(锁死,不暴露)。
import { describe, expect, it } from "vitest";

import { configFingerprint, sameConfigFingerprint } from "./config-fingerprint";

describe("sameConfigFingerprint — 号池线", () => {
  const base = {
    line: "pool",
    products: ["anthropic", "codex"],
    bucketLimits: { "anthropic-claude": 150000 },
    weeklyTokenLimit: 750000,
    deviceLimit: 2,
    windowMs: 18_000_000,
  };

  it("完全相同 → 等价", () => {
    expect(sameConfigFingerprint(base, { ...base })).toBe(true);
  });

  it("products 顺序不同(集合相同)→ 等价(排序后比)", () => {
    expect(sameConfigFingerprint(base, { ...base, products: ["codex", "anthropic"] })).toBe(true);
  });

  it("bucketLimits 键顺序不同(值相同)→ 等价(规范化对象)", () => {
    const reordered = {
      ...base,
      bucketLimits: { "anthropic-claude": 150000, "codex-codex": 40000 },
    };
    const original = {
      ...base,
      bucketLimits: { "codex-codex": 40000, "anthropic-claude": 150000 },
    };
    expect(sameConfigFingerprint(reordered, original)).toBe(true);
  });

  it("用量档不同(bucketLimits 不同)→ 不等价", () => {
    expect(
      sameConfigFingerprint(base, { ...base, bucketLimits: { "anthropic-claude": 50000 } }),
    ).toBe(false);
  });

  it("weeklyTokenLimit 不同 → 不等价", () => {
    expect(sameConfigFingerprint(base, { ...base, weeklyTokenLimit: 250000 })).toBe(false);
  });

  it("产品集合不同 → 不等价", () => {
    expect(sameConfigFingerprint(base, { ...base, products: ["anthropic"] })).toBe(false);
  });

  it("deviceLimit 不同 → 不等价", () => {
    expect(sameConfigFingerprint(base, { ...base, deviceLimit: 1 })).toBe(false);
  });

  it("windowMs 不同 → 仍等价(窗口锁死、不暴露,不进指纹)", () => {
    expect(sameConfigFingerprint(base, { ...base, windowMs: 999 })).toBe(true);
  });

  it("号池 vs 绑定(line 不同)→ 不等价", () => {
    const bind = { line: "bind", products: ["anthropic"], levels: { anthropic: "pro" }, weight: 8, deviceLimit: 2, windowMs: 18_000_000 };
    expect(sameConfigFingerprint(base, bind)).toBe(false);
  });
});

describe("sameConfigFingerprint — 绑定线", () => {
  const base = {
    line: "bind",
    products: ["anthropic"],
    levels: { anthropic: "max-20x" },
    bindings: { anthropic: 1234 },
    shareSeats: 8,
    weight: 8,
    deviceLimit: 1,
    windowMs: 18_000_000,
  };

  it("完全相同 → 等价", () => {
    expect(sameConfigFingerprint(base, { ...base })).toBe(true);
  });

  it("bindings 不同(已分配到不同上游号)→ 仍等价(bindings 是分配结果,不进指纹)", () => {
    expect(sameConfigFingerprint(base, { ...base, bindings: { anthropic: 9999 } })).toBe(true);
  });

  it("bindings 一空一有(待分配 vs 已分配)→ 仍等价", () => {
    expect(sameConfigFingerprint({ ...base, bindings: {} }, base)).toBe(true);
  });

  it("bucket/display learning fields differ but bind purchase intent is equivalent", () => {
    const learnedA = {
      ...base,
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyBucketLimits: { "anthropic-claude": 250000 },
      displayBindings: { anthropic: "seat-a" },
      bindings: { anthropic: 1111 },
    };
    const learnedB = {
      ...base,
      bucketLimits: { "anthropic-claude": 90000 },
      weeklyBucketLimits: { "anthropic-claude": 450000 },
      displayBindings: { anthropic: "seat-b" },
      bindings: { anthropic: 2222 },
    };
    expect(sameConfigFingerprint(learnedA, learnedB)).toBe(true);
  });

  it("levels 不同(等级不同)→ 不等价", () => {
    expect(sameConfigFingerprint(base, { ...base, levels: { anthropic: "pro" } })).toBe(false);
  });

  it("weight 不同(共享人数不同)→ 不等价", () => {
    expect(sameConfigFingerprint(base, { ...base, shareSeats: 4, weight: 8 })).toBe(false);
  });

  it("legacy weight fallback remains equivalent to shareSeats", () => {
    expect(sameConfigFingerprint(base, { ...base, shareSeats: undefined, weight: 8 })).toBe(true);
  });

  it("deviceLimit 不同 → 不等价", () => {
    expect(sameConfigFingerprint(base, { ...base, deviceLimit: 2 })).toBe(false);
  });

  it("多产品 levels 键顺序不同(值相同)→ 等价", () => {
    const a = { ...base, products: ["anthropic", "codex"], levels: { anthropic: "pro", codex: "plus" } };
    const b = { ...base, products: ["codex", "anthropic"], levels: { codex: "plus", anthropic: "pro" } };
    expect(sameConfigFingerprint(a, b)).toBe(true);
  });
});

describe("configFingerprint — 健壮性", () => {
  it("缺失字段不抛错,产出稳定字符串", () => {
    expect(typeof configFingerprint({})).toBe("string");
    expect(typeof configFingerprint({ line: "bind" })).toBe("string");
  });
});
