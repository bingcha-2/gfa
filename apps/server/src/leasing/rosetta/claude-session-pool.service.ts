// 白号登录号池 (Claude Session Pool): claude.ai sessionKey cookie 账号池。
// 与 OAuth 号池(anthropic-accounts.json)互不干扰;这里存的是 web 登录态(sessionKey),
// 用于客户端 MITM 层 Cookie 注入实现"借号"。每个号绑一个静态出口代理(一号一 IP)。
//
// 状态(status)不由服务端验证(claude.ai 在 Cloudflare 后,服务端任何非浏览器 TLS 指纹都被 403),
// 改为【客户端实测回报】驱动:
//   - unverified:刚入池,还没被任何客户端用过
//   - usable    :客户端注入后实测能用(report ok)
//   - unusable  :客户端实测不能用(report fail) —— 不再下发
// 租约(lease)只挑 enabled + 有代理 + status ∈ {unverified, usable} 的号,按使用人数升序分配。

import * as path from "path";

import type { RosettaContext } from "./lib/context";
import { nowIso, readJson, toSocks5ProxyUrl, writeJson } from "./lib/store";

type SessionStatus = "unverified" | "usable" | "unusable";

export class ClaudeSessionPoolService {
  constructor(private readonly ctx: RosettaContext) {}

  private filePath() {
    return path.join(this.ctx.dataDir, "claude-session-pool.json");
  }

  // ── 列表(不回传 sessionKey/password 明文) ─────────────────────────────
  listAccounts() {
    const data = readJson(this.filePath(), { accounts: [] });
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((acc: any) => ({
      id: Number(acc.id || 0),
      email: String(acc.email || ""),
      enabled: acc.enabled !== false,
      proxyUrl: String(acc.proxyUrl || ""),
      hasSessionKey: Boolean(acc.sessionKey),
      hasPassword: Boolean(acc.password),
      status: normalizeStatus(acc.status),
      useCount: Number(acc.useCount || 0),
      orgId: String(acc.orgId || ""),
      lastVerifiedAt: String(acc.lastVerifiedAt || ""),
      lastUsedAt: String(acc.lastUsedAt || ""),
      lastError: String(acc.lastError || ""),
      createdAt: String(acc.createdAt || ""),
      updatedAt: String(acc.updatedAt || ""),
    }));
    return { ok: true, accounts };
  }

  // ── 添加/更新(按 email 去重) ──────────────────────────────────────────
  addAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    const password = String(payload?.password || "").trim();
    const sessionKey = String(payload?.sessionKey || "").trim();
    const proxyUrl = payload?.proxyUrl ? toSocks5ProxyUrl(String(payload.proxyUrl).trim()) : "";

    if (!email) return { ok: false, error: "email 不能为空" };
    if (!sessionKey) return { ok: false, error: "sessionKey 不能为空" };

    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];

    const existing = accounts.find(
      (a: any) => String(a.email || "").toLowerCase() === email.toLowerCase(),
    );

    let accountId: number;
    if (existing) {
      if (password) existing.password = password;
      existing.sessionKey = sessionKey;
      if (proxyUrl) existing.proxyUrl = proxyUrl;
      // 换了新 sessionKey,旧的"不能用"判定作废,回到未验证待客户端重测。
      existing.status = "unverified";
      existing.lastError = "";
      existing.updatedAt = nowIso();
      accountId = Number(existing.id);
    } else {
      const maxId = accounts.reduce((max: number, a: any) => Math.max(max, Number(a.id || 0)), 0);
      accountId = maxId + 1;
      accounts.push({
        id: accountId,
        email,
        password,
        sessionKey,
        proxyUrl,
        enabled: true,
        status: "unverified" as SessionStatus,
        useCount: 0,
        orgId: "",
        lastVerifiedAt: "",
        lastUsedAt: "",
        lastError: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }

    writeJson(this.filePath(), { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing) };
  }

  // ── 批量导入(每行 email----password----sessionKey) ────────────────────
  batchImport(payload: any) {
    const lines = String(payload?.lines || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const proxyUrl = payload?.proxyUrl ? String(payload.proxyUrl).trim() : "";
    const results: Array<{ email: string; ok: boolean; error?: string; isUpdate?: boolean }> = [];

    for (const line of lines) {
      const parts = line.split(/----+/);
      if (parts.length < 3) {
        results.push({
          email: line.slice(0, 30),
          ok: false,
          error: "格式不对，需要: email----password----sessionKey",
        });
        continue;
      }
      const [rawEmail, rawPw, rawSk] = parts.map((p) => p.trim());
      if (!rawEmail || !rawSk) {
        results.push({ email: rawEmail || "?", ok: false, error: "email 或 sessionKey 为空" });
        continue;
      }
      const r = this.addAccount({ email: rawEmail, password: rawPw, sessionKey: rawSk, proxyUrl });
      results.push({ email: rawEmail, ok: r.ok, error: r.ok ? undefined : (r as any).error, isUpdate: (r as any).isUpdate });
    }

    return { ok: true, results, total: lines.length, success: results.filter((r) => r.ok).length };
  }

  // ── 删除 ────────────────────────────────────────────────────────────────
  deleteAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const filtered = accounts.filter((a: any) => Number(a.id) !== accountId);
    if (filtered.length === accounts.length) return { ok: false, error: "账号不存在" };
    writeJson(this.filePath(), { ...data, accounts: filtered, updatedAt: nowIso() });
    return { ok: true };
  }

  // ── 启用/禁用 ──────────────────────────────────────────────────────────
  toggleAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    acc.enabled = !acc.enabled;
    acc.updatedAt = nowIso();
    writeJson(this.filePath(), { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: acc.email, enabled: acc.enabled };
  }

  // ── 设置/清除出口代理(强制 SOCKS5) ────────────────────────────────────
  setProxy(payload: any) {
    const accountId = Number(payload?.accountId);
    const proxyUrl = toSocks5ProxyUrl(String(payload?.proxyUrl || "").trim());
    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    acc.proxyUrl = proxyUrl;
    acc.updatedAt = nowIso();
    writeJson(this.filePath(), { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: acc.email, proxyUrl };
  }

  // ── 更新 sessionKey(单独更新,不走 addAccount 整套) ─────────────────────
  updateSessionKey(payload: any) {
    const accountId = Number(payload?.accountId);
    const sessionKey = String(payload?.sessionKey || "").trim();
    if (!sessionKey) return { ok: false, error: "sessionKey 不能为空" };

    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    acc.sessionKey = sessionKey;
    acc.status = "unverified"; // 新 key 待客户端重测
    acc.lastError = "";
    acc.updatedAt = nowIso();
    writeJson(this.filePath(), { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: acc.email };
  }

  // ── 客户端租约:接管时拉一个白号(sessionKey + 静态出口) ────────────────
  // 只挑 enabled + 有代理(不准裸连) + status ∈ {unverified, usable};按使用人数升序分配,
  // 让流量摊平到多个号,降低单号被 claude.ai 风控聚类的概率。命中后 useCount+1、记 lastUsedAt。
  leaseSession(_payload?: any) {
    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];

    const candidates = accounts
      .filter((a: any) => a.enabled !== false)
      .filter((a: any) => Boolean(a.sessionKey))
      .filter((a: any) => Boolean(a.proxyUrl)) // 无静态出口的号绝不下发(不准裸奔)
      .filter((a: any) => normalizeStatus(a.status) !== "unusable")
      .sort((a: any, b: any) => {
        const ua = Number(a.useCount || 0);
        const ub = Number(b.useCount || 0);
        if (ua !== ub) return ua - ub;
        return Number(a.id || 0) - Number(b.id || 0);
      });

    const acc = candidates[0];
    if (!acc) return { ok: false, error: "白号池无可用账号(需 enabled + 已配静态代理 + 未被标记不可用)" };

    acc.useCount = Number(acc.useCount || 0) + 1;
    acc.lastUsedAt = nowIso();
    acc.updatedAt = nowIso();
    const leaseId = `ws-${acc.id}-${Date.now().toString(36)}`;
    writeJson(this.filePath(), { ...data, accounts, updatedAt: nowIso() });

    return {
      ok: true,
      leaseId,
      accountId: Number(acc.id),
      email: String(acc.email || ""),
      sessionKey: String(acc.sessionKey || ""),
      accountProxyUrl: String(acc.proxyUrl || ""),
      egressRequired: true,
      orgId: String(acc.orgId || ""),
      status: normalizeStatus(acc.status),
      useCount: Number(acc.useCount || 0),
    };
  }

  // ── 客户端回报:注入后实测能用/不能用 ──────────────────────────────────
  // ok=true                 → status=usable
  // ok=false & fault=account → status=unusable(sessionKey 失效,从此不再下发,等管理员换 key)
  // ok=false & fault=egress  → status【不变】(代理/CF 拦截,号未必坏),只记 lastError,下次照常可租
  //                            —— 避免因为某号的静态代理 IP 过不了 claude.ai 的 CF 就烧掉好号。
  reportSession(payload: any) {
    const accountId = Number(payload?.accountId);
    const ok = payload?.ok === true || payload?.ok === "true";
    const fault = String(payload?.fault || "").toLowerCase();
    const error = String(payload?.error || "").slice(0, 300);
    const orgId = String(payload?.orgId || "").trim();

    const data = readJson(this.filePath(), { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };

    if (ok) {
      acc.status = "usable";
      acc.lastError = "";
      if (orgId) acc.orgId = orgId;
    } else if (fault === "egress") {
      // 代理/CF 问题:不改 status(保持 unverified/usable,仍可租),只留痕。
      acc.lastError = error;
    } else {
      // 号失效(或未指明归因,保守判号坏)。
      acc.status = "unusable";
      acc.lastError = error;
    }
    acc.lastVerifiedAt = nowIso();
    acc.updatedAt = nowIso();
    writeJson(this.filePath(), { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: acc.email, status: normalizeStatus(acc.status) };
  }
}

function normalizeStatus(raw: unknown): SessionStatus {
  const s = String(raw || "").toLowerCase();
  if (s === "usable" || s === "unusable") return s;
  return "unverified";
}
