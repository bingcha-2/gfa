import { describe, expect, it, vi } from "vitest";

import {
  extractClaudeVerificationCode,
  fetchClaudeVerificationCode,
} from "../claude-verification-code";

describe("extractClaudeVerificationCode", () => {
  it("extracts the six digit code from a Claude magic-link code page", () => {
    const text = "Use verification code to continue Enter this verification code where you first tried to sign in 654321 Copy Code";

    expect(extractClaudeVerificationCode(text)).toBe("654321");
  });
});

describe("fetchClaudeVerificationCode", () => {
  it("fetches the latest mail link and opens it in the requested AdsPower profile", async () => {
    const fetchMagicLink = vi.fn(async () => ({
      ok: true,
      url: "https://claude.ai/magic-link#token:email",
      subject: "Secure link to log in to Claude.ai",
      date: "2026-07-05T05:00:12.766Z",
    }));
    const openMagicLinkInBrowser = vi.fn(async () => ({
      ok: true,
      code: "123456",
      startedProfile: false,
    }));

    await expect(fetchClaudeVerificationCode({
      email: "mail-user@example.com",
      password: "mail-password",
      adspowerProfileId: "k1e8c364",
      sinceMs: 123,
      waitMs: 1_200,
    }, {
      fetchMagicLink,
      openMagicLinkInBrowser,
      })).resolves.toMatchObject({
      ok: true,
      code: "123456",
      source: "mail-password",
      subject: "Secure link to log in to Claude.ai",
      date: "2026-07-05T05:00:12.766Z",
      adspowerProfileId: "k1e8c364",
      startedProfile: false,
    });

    expect(fetchMagicLink).toHaveBeenCalledWith({
      email: "mail-user@example.com",
      password: "mail-password",
      sinceMs: 123,
      waitMs: 1_200,
      proxyUrl: undefined,
    });
    expect(openMagicLinkInBrowser).toHaveBeenCalledWith({
      adspowerProfileId: "k1e8c364",
      email: "mail-user@example.com",
      magicLinkUrl: "https://claude.ai/magic-link#token:email",
      timeoutMs: expect.any(Number),
      closeCodeTab: true,
    });
  });
});
