import * as crypto from "crypto";
import { describe, expect, it } from "vitest";

import { base64Url, codeChallenge, decodeJwtPayload } from "../pkce";

describe("base64Url", () => {
  it("encodes bytes url-safe (no +/=)", () => {
    const out = base64Url(Buffer.from([251, 255, 191, 0]));
    expect(out).not.toMatch(/[+/=]/);
    expect(out).toBe(Buffer.from([251, 255, 191, 0]).toString("base64url"));
  });
});

describe("codeChallenge", () => {
  it("is the url-safe SHA-256 of the verifier (S256)", () => {
    const verifier = "test-verifier-123";
    const expected = crypto.createHash("sha256").update(verifier).digest().toString("base64url");
    expect(codeChallenge(verifier)).toBe(expected);
  });
});

describe("decodeJwtPayload", () => {
  it("decodes the payload of a well-formed JWT", () => {
    const payload = { sub: "abc", email: "x@y.z" };
    const seg = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const jwt = `header.${seg}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual(payload);
  });

  it("returns {} for malformed / payload-less tokens", () => {
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
    expect(decodeJwtPayload("a.%%%.c")).toEqual({});
    expect(decodeJwtPayload("")).toEqual({});
  });
});
