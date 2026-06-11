/**
 * epay.sign.spec.ts — exhaustive pure-unit tests for sign/verify.
 */
import * as crypto from "crypto";
import { describe, expect, it } from "vitest";

import { signParams, verifySign } from "../epay.sign";

const KEY = "testkey123";

/** Reference md5 computed in the test itself (no magic strings). */
function md5(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex").toLowerCase();
}

describe("signParams", () => {
  it("produces md5(sorted_k=v pairs + KEY), lowercased", () => {
    const params = { b: "2", a: "1" };
    // ASCII sort: a < b → "a=1&b=2"
    const expected = md5("a=1&b=2" + KEY);
    expect(signParams(params, KEY)).toBe(expected);
  });

  it("excludes 'sign' and 'sign_type' from input string", () => {
    const params = { b: "2", a: "1", sign: "old-sign", sign_type: "MD5" };
    const expected = md5("a=1&b=2" + KEY);
    expect(signParams(params, KEY)).toBe(expected);
  });

  it("excludes empty-value entries", () => {
    const params = { a: "1", b: "", c: "3" };
    // b excluded; a < c → "a=1&c=3"
    const expected = md5("a=1&c=3" + KEY);
    expect(signParams(params, KEY)).toBe(expected);
  });

  it("sorts keys strictly by ASCII order", () => {
    // Capital letters sort before lowercase in ASCII
    const params = { z: "z", A: "A", a: "a" };
    // ASCII: "A"(65) < "a"(97) < "z"(122)
    const expected = md5("A=A&a=a&z=z" + KEY);
    expect(signParams(params, KEY)).toBe(expected);
  });

  it("uses raw values without url-encoding special chars", () => {
    const params = { url: "https://example.com/path?q=1&x=2" };
    const expected = md5("url=https://example.com/path?q=1&x=2" + KEY);
    expect(signParams(params, KEY)).toBe(expected);
  });

  it("returns 32-char lowercase hex string", () => {
    const result = signParams({ a: "1" }, KEY);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it("known fixture: {pid:'1001', type:'alipay', money:'9.90'} → deterministic hash", () => {
    const params = { pid: "1001", type: "alipay", money: "9.90" };
    // keys sorted: money < pid < type
    const expected = md5("money=9.90&pid=1001&type=alipay" + KEY);
    expect(signParams(params, KEY)).toBe(expected);
  });
});

describe("verifySign", () => {
  it("returns true for a correctly signed params object", () => {
    const params = { a: "1", b: "2" };
    const sign = signParams(params, KEY);
    expect(verifySign({ ...params, sign }, KEY)).toBe(true);
  });

  it("returns false when sign is tampered", () => {
    const params = { a: "1", b: "2" };
    expect(verifySign({ ...params, sign: "00000000000000000000000000000000" }, KEY)).toBe(false);
  });

  it("returns false when sign has wrong length (length-mismatch short-circuit)", () => {
    const params = { a: "1", b: "2" };
    expect(verifySign({ ...params, sign: "short" }, KEY)).toBe(false);
  });

  it("returns false when sign is missing entirely", () => {
    const params = { a: "1", b: "2" };
    // sign is undefined → empty string
    expect(verifySign(params as any, KEY)).toBe(false);
  });

  it("returns false when a param value is tampered", () => {
    const params = { a: "1", b: "2" };
    const sign = signParams(params, KEY);
    expect(verifySign({ a: "1", b: "TAMPERED", sign }, KEY)).toBe(false);
  });

  it("returns false (no throw) when given extreme inputs", () => {
    expect(verifySign({ sign: "" }, KEY)).toBe(false);
    expect(verifySign({ sign: "x".repeat(32) }, KEY)).toBe(false);
    // sign_type excluded from computation — changing it does not change result
    const params = { a: "1", sign_type: "MD5" };
    const sign = signParams(params, KEY);
    expect(verifySign({ ...params, sign }, KEY)).toBe(true);
  });
});
