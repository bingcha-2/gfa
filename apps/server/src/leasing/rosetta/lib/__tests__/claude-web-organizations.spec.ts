import { describe, expect, it } from "vitest";

import { waitForClaudeOrganizationsFromPage } from "../playwright-oauth";

function makePage(fetches: Array<{ status: number; text: string }>, cookieBatches: any[][], events: string[]) {
  let fetchIndex = 0;
  let cookieIndex = 0;
  return {
    evaluate: async () => {
      events.push("organizations");
      const result = fetches[Math.min(fetchIndex, fetches.length - 1)];
      fetchIndex += 1;
      return result;
    },
    context: () => ({
      cookies: async () => {
        const result = cookieBatches[Math.min(cookieIndex, cookieBatches.length - 1)];
        cookieIndex += 1;
        return result;
      },
    }),
    url: () => "https://claude.ai/new",
    title: async () => "Claude",
    textContent: async () => "Welcome to Claude",
    waitForTimeout: async (ms: number) => {
      events.push(`wait:${ms}`);
    },
  } as any;
}

describe("waitForClaudeOrganizationsFromPage", () => {
  it("waits for the login session to settle before low-frequency organization checks", async () => {
    const events: string[] = [];
    const page = makePage(
      [
        {
          status: 403,
          text: JSON.stringify({
            type: "error",
            error: { type: "permission_error", details: { error_code: "account_session_invalid" } },
          }),
        },
        {
          status: 200,
          text: JSON.stringify([{ uuid: "org-1", name: "Org One", capabilities: ["chat"] }]),
        },
      ],
      [
        [],
        [{ name: "sessionKey", value: "sk-ant-sid02-new", domain: ".claude.ai" }],
      ],
      events,
    );

    const result = await waitForClaudeOrganizationsFromPage(page, {
      previousSessionKey: "sk-ant-sid02-old",
      settleMs: 10,
      retryDelayMs: 10,
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      diagnostics: {
        hasSessionKey: true,
        sessionKeyChanged: true,
        url: "https://claude.ai/new",
      },
    });
    expect(result.organizations?.[0]).toMatchObject({ uuid: "org-1", name: "Org One" });
    expect(events).toEqual(["wait:10", "organizations", "wait:10", "organizations"]);
  });
});
