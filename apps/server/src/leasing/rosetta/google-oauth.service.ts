// Google OAuth login domain (Antigravity account pool). Extracted from
// RosettaService — behavior-preserving (method bodies verbatim, this.dataDir/
// this.logger/this.tokenCache rebound to the shared RosettaContext).
//
// NOTE: completeGoogleOAuthLogin (the private worker behind submitGoogleOAuthCallback)
// creates/updates an Antigravity account by calling the account domain's
// addAccountChecked(...). That method lives on RosettaService (the account
// domain), not on RosettaContext nor in lib/. To keep this service decoupled
// while preserving behavior, the facade injects addAccountChecked as a
// constructor dependency. See the report accompanying this extraction.

import * as crypto from "crypto";

import {
  resolveOAuthCredentials,
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
} from "./google-api";
import type { RosettaContext } from "./lib/context";
import { base64Url, codeChallenge, decodeJwtPayload } from "./lib/pkce";

const GOOGLE_OAUTH_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_SCOPES = "openid email profile https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const GOOGLE_OAUTH_REDIRECT_URI = "http://localhost:1456/auth/callback";

type CodexOAuthPending = {
  loginId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authUrl: string;
  expiresAt: number;
  status: "pending" | "completed" | "failed";
  email?: string;
  error?: string;
  isUpdate?: boolean;
  targetAccountId?: number;
};

/** Pending Google OAuth login (Antigravity account pool). Same shape as Codex. */
type GoogleOAuthPending = CodexOAuthPending;

/**
 * Cross-domain dependency: persists an Antigravity account (writes accounts.json
 * + probes the token) and reports whether it was an update. Implemented by the
 * account domain (RosettaService.addAccountChecked) and injected by the facade.
 */
export type AddAccountChecked = (payload: any) => Promise<any>;

export class GoogleOAuthService {
  private googleOAuthPending: GoogleOAuthPending | null = null;

  constructor(
    private readonly ctx: RosettaContext,
    private readonly addAccountChecked: AddAccountChecked,
  ) {}

  async startGoogleOAuthLogin(options: { targetAccountId?: number } = {}) {
    const existing = this.googleOAuthPending;
    if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
      return {
        ok: true,
        loginId: existing.loginId,
        authUrl: existing.authUrl,
        redirectUri: existing.redirectUri,
        expiresAt: existing.expiresAt,
      };
    }
    this.closeGoogleOAuthPending();
    const targetAccountId = Number(options.targetAccountId || 0);

    const oauth = resolveOAuthCredentials();
    const codeVerifier = base64Url(crypto.randomBytes(32));
    const state = base64Url(crypto.randomBytes(32));
    const loginId = base64Url(crypto.randomBytes(18));
    const redirectUri = GOOGLE_OAUTH_REDIRECT_URI;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      scope: GOOGLE_OAUTH_SCOPES,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state,
    });

    const pending: GoogleOAuthPending = {
      loginId,
      state,
      codeVerifier,
      redirectUri,
      authUrl: `${GOOGLE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`,
      expiresAt: Date.now() + GOOGLE_OAUTH_TIMEOUT_MS,
      status: "pending",
      targetAccountId: targetAccountId > 0 ? targetAccountId : undefined,
    };

    (pending as any).clientId = oauth.clientId;
    (pending as any).clientSecret = oauth.clientSecret;
    this.googleOAuthPending = pending;
    return {
      ok: true,
      loginId,
      authUrl: pending.authUrl,
      redirectUri,
      expiresAt: pending.expiresAt,
    };
  }

  getGoogleOAuthLoginStatus(loginId: string) {
    const pending = this.googleOAuthPending;
    if (!pending || pending.loginId !== loginId) return { ok: false, status: "missing", error: "login session not found" };
    if (pending.status === "pending" && pending.expiresAt <= Date.now()) {
      pending.status = "failed";
      pending.error = "OAuth login timed out";
      this.closeGoogleOAuthPending(false);
    }
    return {
      ok: true,
      status: pending.status,
      loginId: pending.loginId,
      email: pending.email || "",
      error: pending.error || "",
      isUpdate: Boolean(pending.isUpdate),
      expiresAt: pending.expiresAt,
    };
  }

  cancelGoogleOAuthLogin(loginId: string) {
    if (this.googleOAuthPending?.loginId !== loginId) return { ok: false, error: "login session not found" };
    this.closeGoogleOAuthPending();
    return { ok: true };
  }

  async submitGoogleOAuthCallback(loginId: string, rawInput: string) {
    const pending = this.googleOAuthPending;
    if (!pending || pending.loginId !== loginId) {
      return { ok: false, status: "missing", error: "登录会话不存在或已过期，请重新发起 OAuth 登录" };
    }
    if (pending.status !== "pending" || pending.expiresAt <= Date.now()) {
      pending.status = "failed";
      pending.error = pending.error || "OAuth 登录会话已失效，请重新发起";
      this.closeGoogleOAuthPending(false);
      return { ok: false, status: "failed", error: pending.error };
    }

    const input = String(rawInput || "").trim();
    if (!input) return { ok: false, status: "pending", error: "请粘贴回调 URL 或授权码 code" };

    let code = "";
    let state = "";
    try {
      const url = new URL(input);
      code = (url.searchParams.get("code") || "").trim();
      state = (url.searchParams.get("state") || "").trim();
    } catch {
      if (input.includes("code=")) {
        const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input.replace(/^[#&?]+/, "");
        const params = new URLSearchParams(query);
        code = (params.get("code") || "").trim();
        state = (params.get("state") || "").trim();
      } else {
        code = input;
      }
    }

    if (!code) return { ok: false, status: "pending", error: "未能从输入中解析出授权码 code" };
    if (state && state !== pending.state) {
      pending.status = "failed";
      pending.error = "OAuth state 不匹配，可能是会话串了，请重新发起登录";
      this.closeGoogleOAuthPending(false);
      return { ok: false, status: "failed", error: pending.error };
    }

    try {
      const result = await this.completeGoogleOAuthLogin(pending, code);
      this.closeGoogleOAuthPending(false);
      return { ok: true, status: "completed", email: result.email, isUpdate: result.isUpdate, accountId: result.accountId };
    } catch (error) {
      pending.status = "failed";
      pending.error = error instanceof Error ? error.message : "OAuth 完成失败";
      this.closeGoogleOAuthPending(false);
      return { ok: false, status: "failed", error: pending.error };
    }
  }

  private async completeGoogleOAuthLogin(pending: GoogleOAuthPending, code: string) {
    const clientId = (pending as any).clientId || ANTIGRAVITY_OAUTH_CLIENT_ID;
    const clientSecret = (pending as any).clientSecret || ANTIGRAVITY_OAUTH_CLIENT_SECRET;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    });
    const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google token exchange failed: ${response.status} ${text.slice(0, 300)}`);

    const tokenData = JSON.parse(text);
    const refreshToken = String(tokenData.refresh_token || "").trim();
    if (!refreshToken) throw new Error("Google token response did not include a refresh_token (需 prompt=consent + access_type=offline)");

    // Decode id_token to get email
    const profile = decodeJwtPayload(String(tokenData.id_token || ""));
    const email = String(profile.email || "").trim();
    if (!email) throw new Error("Google token response did not include an email");

    // Save account via addAccountChecked (writes to accounts.json + probes token)
    const result = await this.addAccountChecked({
      targetAccountId: pending.targetAccountId,
      email,
      refreshToken,
      alias: profile.name || "",
    });
    if (!result.ok) throw new Error(String(result.error || "Failed to save Antigravity account"));

    pending.status = "completed";
    pending.email = email;
    pending.isUpdate = Boolean(result.isUpdate || pending.targetAccountId);
    return {
      email,
      isUpdate: Boolean(result.isUpdate || pending.targetAccountId),
      accountId: pending.targetAccountId || result.id,
    };
  }

  private closeGoogleOAuthPending(clearCompleted = true) {
    const pending = this.googleOAuthPending;
    if (!pending) return;
    if (clearCompleted) this.googleOAuthPending = null;
  }
}
