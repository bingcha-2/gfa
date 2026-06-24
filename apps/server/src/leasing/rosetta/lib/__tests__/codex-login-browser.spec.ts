import { describe, expect, it } from "vitest";

import { extractOpenAIEmailCode, extractSmsCode } from "../codex-login-browser";

describe("extractOpenAIEmailCode", () => {
  it("extracts a six digit OpenAI verification code from mailbox text", () => {
    expect(extractOpenAIEmailCode("Your OpenAI verification code is 123456.")).toBe("123456");
  });

  it("prefers a code near OpenAI wording when other numbers are present", () => {
    const text = "Received 2026-06-25. OpenAI code: 654321. Ticket 987654.";
    expect(extractOpenAIEmailCode(text)).toBe("654321");
  });
});

describe("extractSmsCode", () => {
  it("keeps parsing SMS provider responses", () => {
    expect(extractSmsCode("YES|Your OpenAI verification code is: 461668")).toBe("461668");
  });
});
