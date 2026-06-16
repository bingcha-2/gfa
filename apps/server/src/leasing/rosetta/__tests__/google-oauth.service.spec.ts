import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../google-api", () => ({
  resolveOAuthCredentials: vi.fn(() => ({ clientId: "cid", clientSecret: "csec" })),
  ANTIGRAVITY_OAUTH_CLIENT_ID: "fallback-id",
  ANTIGRAVITY_OAUTH_CLIENT_SECRET: "fallback-secret",
}));

import { GoogleOAuthService } from "../google-oauth.service";

let ctx: any;
let addAccountChecked: any;
let svc: GoogleOAuthService;

const jwtWith = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const okTokenFetch = (body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  ctx = { dataDir: "/tmp", logger: { log: vi.fn(), warn: vi.fn() }, tokenCache: new Map() };
  addAccountChecked = vi.fn(async () => ({ ok: true, id: 5, isUpdate: false }));
  svc = new GoogleOAuthService(ctx, addAccountChecked);
});
afterEach(() => vi.unstubAllGlobals());

describe("startGoogleOAuthLogin", () => {
  it("returns a login session with an auth URL, and reuses a pending one", async () => {
    const r = await svc.startGoogleOAuthLogin();
    expect(r.ok).toBe(true);
    expect(r.loginId).toBeTruthy();
    expect(r.authUrl).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(r.authUrl).toContain("client_id=cid");
    expect(r.authUrl).toContain("code_challenge=");

    const again = await svc.startGoogleOAuthLogin();
    expect(again.loginId).toBe(r.loginId); // same pending reused
  });
});

describe("getGoogleOAuthLoginStatus / cancel", () => {
  it("reports missing for an unknown loginId", () => {
    expect(svc.getGoogleOAuthLoginStatus("nope")).toMatchObject({ ok: false, status: "missing" });
  });
  it("reports pending for the active session, and cancel clears it", async () => {
    const r = await svc.startGoogleOAuthLogin();
    expect(svc.getGoogleOAuthLoginStatus(r.loginId)).toMatchObject({ ok: true, status: "pending" });
    expect(svc.cancelGoogleOAuthLogin(r.loginId)).toEqual({ ok: true });
    expect(svc.getGoogleOAuthLoginStatus(r.loginId)).toMatchObject({ ok: false, status: "missing" });
  });
  it("cancel returns not-found for a mismatched id", () => {
    expect(svc.cancelGoogleOAuthLogin("nope")).toEqual({ ok: false, error: "login session not found" });
  });
});

describe("submitGoogleOAuthCallback", () => {
  it("rejects when there is no live session", async () => {
    expect(await svc.submitGoogleOAuthCallback("nope", "code")).toMatchObject({ ok: false, status: "missing" });
  });

  it("asks for input when nothing is pasted", async () => {
    const r = await svc.startGoogleOAuthLogin();
    expect(await svc.submitGoogleOAuthCallback(r.loginId, "  ")).toMatchObject({ ok: false, status: "pending" });
  });

  it("fails on a state mismatch", async () => {
    const r = await svc.startGoogleOAuthLogin();
    const out = await svc.submitGoogleOAuthCallback(r.loginId, "http://cb?code=c&state=WRONG");
    expect(out).toMatchObject({ ok: false, status: "failed" });
  });

  it("exchanges the code, saves the account, and completes", async () => {
    const r = await svc.startGoogleOAuthLogin();
    vi.stubGlobal("fetch", okTokenFetch({ refresh_token: "grt", id_token: jwtWith({ email: "g@x.com", name: "G" }) }));

    const out = await svc.submitGoogleOAuthCallback(r.loginId, "auth-code-123");

    expect(out).toMatchObject({ ok: true, status: "completed", email: "g@x.com", accountId: 5, isUpdate: false });
    expect(addAccountChecked).toHaveBeenCalledWith(expect.objectContaining({ email: "g@x.com", refreshToken: "grt", alias: "G" }));
  });

  it("reauthorizes a target account instead of creating a new account", async () => {
    const r = await svc.startGoogleOAuthLogin({ targetAccountId: 12 } as any);
    vi.stubGlobal("fetch", okTokenFetch({
      refresh_token: "new-refresh",
      id_token: jwtWith({ email: "target@example.com", name: "Target" }),
    }));

    const out = await svc.submitGoogleOAuthCallback(r.loginId, "auth-code-123");

    expect(out).toMatchObject({ ok: true, status: "completed", email: "target@example.com", accountId: 12, isUpdate: true });
    expect(addAccountChecked).toHaveBeenCalledWith(expect.objectContaining({
      targetAccountId: 12,
      email: "target@example.com",
      refreshToken: "new-refresh",
      alias: "Target",
    }));
  });

  it("fails when the token response has no refresh_token", async () => {
    const r = await svc.startGoogleOAuthLogin();
    vi.stubGlobal("fetch", okTokenFetch({ id_token: jwtWith({ email: "g@x.com" }) }));
    const out = await svc.submitGoogleOAuthCallback(r.loginId, "auth-code-123");
    expect(out.ok).toBe(false);
    expect(out.status).toBe("failed");
    expect(String(out.error)).toMatch(/refresh_token/);
    expect(addAccountChecked).not.toHaveBeenCalled();
  });

  it("fails when the token endpoint returns a non-200", async () => {
    const r = await svc.startGoogleOAuthLogin();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    const out = await svc.submitGoogleOAuthCallback(r.loginId, "auth-code-123");
    expect(out).toMatchObject({ ok: false, status: "failed" });
    expect(String(out.error)).toMatch(/token exchange failed/);
  });
});
