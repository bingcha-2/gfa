import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptKey, encryptKey, keyHint } from "./key-vault";

const KEK = "a".repeat(64);

describe("key-vault", () => {
  const prev = process.env.GATEWAY_KEY_KEK;
  beforeEach(() => {
    process.env.GATEWAY_KEY_KEK = KEK;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.GATEWAY_KEY_KEK;
    else process.env.GATEWAY_KEY_KEK = prev;
  });

  it("round-trips and never stores plaintext", () => {
    const plain = "tc-example-key-1234567890";
    const enc = encryptKey(plain);
    expect(enc).not.toContain(plain);
    expect(decryptKey(enc)).toBe(plain);
  });

  it("uses a fresh nonce per encryption", () => {
    expect(encryptKey("tc-same")).not.toBe(encryptKey("tc-same"));
  });

  it("rejects tampered ciphertext", () => {
    const buf = Buffer.from(encryptKey("tc-abc"), "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptKey(buf.toString("base64"))).toThrow();
  });

  it("fails closed when the KEK is missing or the wrong size", () => {
    delete process.env.GATEWAY_KEY_KEK;
    expect(() => encryptKey("x")).toThrow(/not configured/);
    process.env.GATEWAY_KEY_KEK = "abcd";
    expect(() => encryptKey("x")).toThrow(/32 bytes/);
  });

  it("masks all but the last 4 characters", () => {
    expect(keyHint("tc-secretvalue-a1b2")).toBe("****a1b2");
  });
});
