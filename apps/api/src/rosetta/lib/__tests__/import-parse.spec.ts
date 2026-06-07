import { describe, expect, it } from "vitest";

import {
  collectCodexImportCandidates,
  expandCodexCandidate,
  extractCodexImportFields,
  firstNumber,
  firstString,
  getNumberAt,
  getStringAt,
  parseJsonFromText,
} from "../import-parse";

describe("getStringAt / firstString", () => {
  it("walks a nested path and trims strings", () => {
    expect(getStringAt({ a: { b: "  hi " } }, ["a", "b"])).toBe("hi");
    expect(getStringAt({ a: 1 }, ["a", "b"])).toBe(""); // non-object mid-path
    expect(getStringAt({ a: { b: 5 } }, ["a", "b"])).toBe(""); // non-string leaf
  });
  it("firstString returns the first non-empty match", () => {
    expect(firstString({ x: "", y: "found" }, [["x"], ["y"]])).toBe("found");
    expect(firstString({}, [["x"], ["y"]])).toBe("");
  });
});

describe("getNumberAt / firstNumber", () => {
  it("reads numbers and numeric strings", () => {
    expect(getNumberAt({ a: 42 }, ["a"])).toBe(42);
    expect(getNumberAt({ a: "42" }, ["a"])).toBe(42);
    expect(getNumberAt({ a: "x" }, ["a"])).toBe(0);
    expect(getNumberAt({ a: 1 }, ["a", "b"])).toBe(0);
  });
  it("firstNumber returns the first positive match", () => {
    expect(firstNumber({ a: 0, b: 7 }, [["a"], ["b"]])).toBe(7);
    expect(firstNumber({}, [["a"]])).toBe(0);
  });
});

describe("expandCodexCandidate / collectCodexImportCandidates", () => {
  it("flattens a credentials envelope", () => {
    expect(expandCodexCandidate({ id: 1, credentials: { token: "t" } })).toEqual({ id: 1, credentials: { token: "t" }, token: "t" });
    expect(expandCodexCandidate(null)).toEqual({});
  });
  it("collects from array / {accounts} / {credentials} / single object", () => {
    expect(collectCodexImportCandidates([{ a: 1 }, { b: 2 }])).toHaveLength(2);
    expect(collectCodexImportCandidates({ accounts: [{ a: 1 }] })).toHaveLength(1);
    expect(collectCodexImportCandidates({ credentials: { t: 1 } })[0]).toMatchObject({ t: 1 });
    expect(collectCodexImportCandidates({ email: "x" })).toEqual([{ email: "x" }]);
    expect(collectCodexImportCandidates(null)).toEqual([]);
  });
});

describe("extractCodexImportFields", () => {
  it("pulls identity/token fields and parses a string expiry", () => {
    const f = extractCodexImportFields({
      email: "u@x.com", refresh_token: "rt", access_token: "at",
      expires: "2030-01-01T00:00:00Z", planType: "pro",
    });
    expect(f).toMatchObject({ email: "u@x.com", refreshToken: "rt", accessToken: "at", planType: "pro", enabled: true });
    expect(f.accessTokenExpiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
  });

  it("normalizes a numeric epoch (seconds) expiry to milliseconds", () => {
    const f = extractCodexImportFields({ email: "u@x.com", refreshToken: "rt", exp: 1_700_000_000 });
    expect(f.accessTokenExpiresAt).toBe(1_700_000_000 * 1000);
  });

  it("honors an explicit enabled:false and carries allowlisted extras", () => {
    const f = extractCodexImportFields({ email: "u@x.com", enabled: false, modelQuotaFractions: { codex: 0.5 }, junk: "drop" });
    expect(f.enabled).toBe(false);
    expect(f.extra).toEqual({ modelQuotaFractions: { codex: 0.5 } });
    expect((f.extra as any).junk).toBeUndefined();
  });
});

describe("parseJsonFromText", () => {
  it("parses clean JSON", () => {
    expect(parseJsonFromText('  {"a":1}  ')).toEqual({ a: 1 });
  });
  it("extracts an embedded JSON object from surrounding noise", () => {
    expect(parseJsonFromText('log: here is {"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
  });
  it("handles braces inside strings", () => {
    expect(parseJsonFromText('{"k":"a}b{c"}')).toEqual({ k: "a}b{c" });
  });
  it("returns null for empty or brace-less or unparseable input", () => {
    expect(parseJsonFromText("   ")).toBeNull();
    expect(parseJsonFromText("no braces here")).toBeNull();
    expect(parseJsonFromText("{ broken")).toBeNull();
  });
});
