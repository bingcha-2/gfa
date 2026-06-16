# GFA 与 CLIProxy 同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GFA 后台展示 Antigravity 账号真实健康状态，支持指定账号重新授权，并建立 GFA 与 CLIProxy 之间的同步状态、错误回传和对账能力。

**Architecture:** GFA 保持账号权威状态，`accounts.json` 上保存轻量 `cliproxySync` 元数据；`LeaseService` 继续负责账号健康判定；Rosetta 层新增 CLIProxy 同步服务和错误上报入口；前端账号页和 CLIProxy 管理页展示健康与同步状态。CLIProxy 运行时换号逻辑需要在 CLIProxy 源码仓库中实施，本仓库先实现 GFA 接收端和同步端。

**Tech Stack:** NestJS, TypeScript, Vitest, Next.js, React, existing Rosetta JSON store, existing CLIProxy management API.

---

## 文件结构

- Create: `apps/api/src/rosetta/cliproxy-sync.service.ts`
  - 负责 `cliproxySync` 状态读写、远端 auth 文件名生成、token hash、上传/禁用/删除、错误回传分类和对账。
- Modify: `apps/api/src/rosetta/rosetta.service.ts`
  - 初始化 `CliProxySyncService`，把现有 `getCliProxyStatus` 和 `uploadToCliProxy` 委托到新服务，增加 `resyncCliProxyAccount`、`reconcileCliProxy`、`handleCliProxyReport`。
- Modify: `apps/api/src/rosetta/rosetta.controller.ts`
  - 增加管理端手动同步接口和 CLIProxy 上报接口。
- Modify: `apps/api/src/rosetta/antigravity-account.service.ts`
  - 账号列表返回持久化健康字段和 `cliproxySync` 字段。
- Modify: `apps/api/src/rosetta/google-oauth.service.ts`
  - 支持 `targetAccountId` 形式的指定账号重新授权。
- Modify: `apps/api/src/lease-core/lease-service.ts`
  - 增加对外部账号错误回传的公共方法，复用现有 `invalid_grant`、429、503、401 分类逻辑。
- Modify: `apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx`
  - 合并 runtime health 字段，状态列使用 `AccountStatusCell`，增加重新授权和重新同步入口。
- Modify: `apps/web/src/app/console/(dashboard)/rosetta-cliproxy/page.tsx`
  - 展示 `cliproxySync` 状态、同步错误和手动对账入口。
- Test: `apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts`
- Test: `apps/api/src/rosetta/__tests__/google-oauth.service.spec.ts`
- Test: `apps/api/src/token-server/__tests__/token-server.service.spec.ts`
- Test: `apps/web/src/lib/account-status.test.ts`

## Task 1: 后台账号健康状态可见

**Files:**
- Modify: `apps/api/src/rosetta/antigravity-account.service.ts`
- Modify: `apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx`
- Modify: `apps/web/src/lib/account-status.ts`
- Test: `apps/web/src/lib/account-status.test.ts`

- [ ] **Step 1: 写前端状态标签失败测试**

在 `apps/web/src/lib/account-status.test.ts` 增加：

```ts
it("uses Chinese labels for auth invalid, verification, cooling, and ok states", () => {
  expect(accountStatusLabel("error", "invalid_grant")).toEqual({
    tone: "red",
    label: "已失效·鉴权失效",
  });
  expect(accountStatusLabel("error", "verification_required")).toEqual({
    tone: "red",
    label: "已失效·需要验证",
  });
  expect(accountStatusLabel("cooling", "capacity")).toEqual({
    tone: "yellow",
    label: "容量冷却中",
  });
  expect(accountStatusLabel("ok", "")).toEqual({
    tone: "green",
    label: "正常",
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @gfa/web exec vitest run src/lib/account-status.test.ts
```

Expected: FAIL，原因是现有 label 不是中文目标文案，或没有覆盖 `verification_required`。

- [ ] **Step 3: 实现状态标签映射**

修改 `apps/web/src/lib/account-status.ts`：

```ts
const ERROR_REASON_LABELS: Record<string, string> = {
  invalid_grant: "鉴权失效",
  verification_required: "需要验证",
  consecutive_errors: "连续报错",
};

const COOLING_REASON_LABELS: Record<string, string> = {
  capacity: "容量冷却中",
  quota: "额度恢复中",
};

export function accountStatusLabel(
  quotaStatus?: string,
  quotaStatusReason?: string,
): AccountStatusBadge {
  const status = quotaStatus || "ok";
  const reason = quotaStatusReason || "";
  if (status === "error") {
    return { tone: "red", label: `已失效·${ERROR_REASON_LABELS[reason] || "连续报错"}` };
  }
  if (status === "exhausted" || status === "cooling") {
    return { tone: "yellow", label: COOLING_REASON_LABELS[reason] || "额度恢复中" };
  }
  return { tone: "green", label: "正常" };
}
```

- [ ] **Step 4: 让 Antigravity 账号接口返回健康字段**

在 `AntigravityAccountService.listAccounts()` 的 map 返回对象中加入：

```ts
quotaStatus: String(account.quotaStatus || "ok"),
quotaStatusReason: String(account.quotaStatusReason || ""),
blockedUntil: Number(account.blockedUntil || 0),
cliproxySync: account.cliproxySync || null,
```

- [ ] **Step 5: 前端合并 `/api/remote-token/status` 的健康字段**

扩展 `RosettaAccount` 类型：

```ts
quotaStatus?: string;
quotaStatusReason?: string;
blockedUntil?: number;
blockedModels?: Array<{ modelKey: string; reason: string; blockedUntil: number }>;
cliproxySync?: {
  desired?: "enabled" | "disabled" | "deleted";
  remoteProvider?: "antigravity" | "gemini";
  remoteName?: string;
  revision?: number;
  lastSyncedAt?: number;
  lastSeenAt?: number;
  lastError?: string;
};
```

在 `loadAccounts()` 合并 status 时，把 `quotaStatus`、`quotaStatusReason`、`blockedUntil`、`blockedModels` 一起合入：

```ts
const runtimeMap = new Map<number, Partial<RosettaAccount>>();
for (const qa of statusData?.quota?.accounts || []) {
  runtimeMap.set(Number(qa.id), {
    quotaStatus: qa.quotaStatus || "ok",
    quotaStatusReason: qa.quotaStatusReason || "",
    blockedUntil: Number(qa.blockedUntil || 0),
    blockedModels: qa.blockedModels || [],
    modelQuotaFractions: qa.modelQuotaFractions,
    modelQuotaResetTimes: qa.modelQuotaResetTimes,
    modelQuotaRefreshedAt: qa.modelQuotaRefreshedAt,
  });
}
const merged = (data.accounts || []).map((a: RosettaAccount) => ({
  ...a,
  ...(runtimeMap.get(Number(a.id)) || {}),
}));
```

- [ ] **Step 6: 状态列使用 `AccountStatusCell`**

在 `rosetta-accounts/page.tsx` 引入：

```ts
import { AccountStatusCell } from "@/components/account-status-cell";
```

把 `status` 列渲染改为：

```tsx
case "status":
  return <AccountStatusCell account={account} />;
```

- [ ] **Step 7: 验证**

Run:

```bash
pnpm --filter @gfa/web exec vitest run src/lib/account-status.test.ts
pnpm --filter @gfa/web lint
```

Expected: tests PASS；lint exit 0。

- [ ] **Step 8: 提交**

```bash
git add apps/api/src/rosetta/antigravity-account.service.ts apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx apps/web/src/lib/account-status.ts apps/web/src/lib/account-status.test.ts
git commit -m "feat: show antigravity account health"
```

## Task 2: 指定账号重新授权

**Files:**
- Modify: `apps/api/src/rosetta/google-oauth.service.ts`
- Modify: `apps/api/src/rosetta/rosetta.controller.ts`
- Modify: `apps/api/src/rosetta/rosetta.service.ts`
- Modify: `apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx`
- Test: `apps/api/src/rosetta/__tests__/google-oauth.service.spec.ts`

- [ ] **Step 1: 写后端失败测试**

在 `google-oauth.service.spec.ts` 增加：

```ts
it("reauthorizes a target account instead of creating a new account", async () => {
  const r = await svc.startGoogleOAuthLogin({ targetAccountId: 12 } as any);
  vi.stubGlobal("fetch", okTokenFetch({
    refresh_token: "new-refresh",
    id_token: jwtWith({ email: "target@example.com", name: "Target" }),
  }));

  const out = await svc.submitGoogleOAuthCallback(r.loginId, "auth-code-123");

  expect(out).toMatchObject({ ok: true, status: "completed", accountId: 12, isUpdate: true });
  expect(addAccountChecked).toHaveBeenCalledWith(expect.objectContaining({
    targetAccountId: 12,
    email: "target@example.com",
    refreshToken: "new-refresh",
  }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/google-oauth.service.spec.ts
```

Expected: FAIL，原因是 `startGoogleOAuthLogin` 还不接收 `targetAccountId`。

- [ ] **Step 3: 扩展 OAuth pending 状态**

在 `google-oauth.service.ts` 的 pending 类型加入：

```ts
targetAccountId?: number;
```

把 `startGoogleOAuthLogin()` 改为：

```ts
startGoogleOAuthLogin(options: { targetAccountId?: number } = {}) {
  const targetAccountId = Number(options.targetAccountId || 0);
  // existing pending reuse logic stays unchanged
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
}
```

- [ ] **Step 4: 保存到目标账号**

在 `completeGoogleOAuthLogin()` 调用 `addAccountChecked` 时加入：

```ts
const result = await this.addAccountChecked({
  targetAccountId: pending.targetAccountId,
  email,
  refreshToken,
  alias: profile.name || "",
});
```

返回值中使用目标账号：

```ts
return {
  email,
  isUpdate: Boolean(result.isUpdate || pending.targetAccountId),
  accountId: pending.targetAccountId || result.id,
};
```

- [ ] **Step 5: 让 Antigravity 保存逻辑支持 `targetAccountId`**

在 `AntigravityAccountService.addAccount()` 中优先按 `targetAccountId` 找账号：

```ts
const targetAccountId = Number(payload?.targetAccountId || 0);
const existing = targetAccountId > 0
  ? accounts.find((account: any) => Number(account.id) === targetAccountId)
  : accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
if (targetAccountId > 0 && !existing) return { ok: false, error: "目标账号不存在" };
```

当更新目标账号时保留原账号绑定数据，只替换授权相关字段：

```ts
existing.email = email || existing.email;
existing.refreshToken = refreshToken;
existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
existing.alias = String(payload.alias ?? existing.alias ?? "");
delete existing.quotaStatus;
delete existing.quotaStatusReason;
delete existing.blockedUntil;
```

- [ ] **Step 6: 控制器支持目标账号 OAuth**

在 `RosettaController.startGoogleOAuthLogin` 读取 body：

```ts
@Post("google-oauth-start")
startGoogleOAuthLogin(@Body() body: any) {
  return this.rosetta.startGoogleOAuthLogin({ targetAccountId: Number(body?.targetAccountId || 0) });
}
```

Rosetta facade 增加同签名委托。

- [ ] **Step 7: 前端增加行级重新授权按钮**

复用已有 OAuth 面板状态，新增：

```ts
const [oauthTargetAccountId, setOauthTargetAccountId] = useState<string>("");

async function handleReauthorize(accountId: string) {
  setOauthTargetAccountId(accountId);
  await handleOAuthStart(accountId);
}
```

把 `handleOAuthStart` 改为接收可选账号 id：

```ts
async function handleOAuthStart(targetAccountId?: string) {
  const res = await fetch("/api/rosetta/google-oauth-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(targetAccountId ? { targetAccountId } : {}),
  });
}
```

在行操作里加按钮：

```tsx
<TooltipContent>重新授权</TooltipContent>
```

- [ ] **Step 8: 授权成功后自动恢复**

在 `RosettaController.submitGoogleOAuthCallback()` 成功后，如果返回 `accountId`，调用：

```ts
const result = await this.rosetta.submitGoogleOAuthCallback(String(body?.loginId || ""), String(body?.input || ""));
if (result?.ok && result.accountId) {
  const { reactivated } = this.tokenServer.reactivateIfAuthDead(Number(result.accountId));
  return { ...result, reactivated };
}
return result;
```

- [ ] **Step 9: 验证**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/google-oauth.service.spec.ts
pnpm --filter @gfa/api lint
pnpm --filter @gfa/web lint
```

Expected: tests PASS；两个 lint exit 0。

- [ ] **Step 10: 提交**

```bash
git add apps/api/src/rosetta/google-oauth.service.ts apps/api/src/rosetta/antigravity-account.service.ts apps/api/src/rosetta/rosetta.controller.ts apps/api/src/rosetta/rosetta.service.ts apps/api/src/rosetta/__tests__/google-oauth.service.spec.ts apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx
git commit -m "feat: reauthorize antigravity accounts"
```

## Task 3: GFA 到 CLIProxy 同步状态

**Files:**
- Create: `apps/api/src/rosetta/cliproxy-sync.service.ts`
- Modify: `apps/api/src/rosetta/rosetta.service.ts`
- Modify: `apps/api/src/rosetta/rosetta.controller.ts`
- Test: `apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts`
- Test: `apps/api/src/rosetta/__tests__/rosetta.service.spec.ts`

- [ ] **Step 1: 写同步服务失败测试**

创建 `cliproxy-sync.service.spec.ts`：

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliProxySyncService } from "../cliproxy-sync.service";

const writeJson = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-cliproxy-sync-"));
  process.env.CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
  process.env.CLIPROXY_MANAGEMENT_KEY = "mgmt";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLIPROXY_BASE_URL;
  delete process.env.CLIPROXY_MANAGEMENT_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CliProxySyncService", () => {
  it("uploads enabled antigravity accounts with a gfa-id remote name and stores sync metadata", async () => {
    writeJson(path.join(dir, "accounts.json"), { accounts: [{ id: 7, email: "u@example.com", refreshToken: "rt", projectId: "p", enabled: true }] });
    let uploadedName = "";
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/v0/management/auth-files?name=")) {
        uploadedName = decodeURIComponent(new URL(u).searchParams.get("name") || "");
        expect(JSON.parse(String(init?.body))).toMatchObject({ type: "antigravity", email: "u@example.com", project_id: "p" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.includes("/v0/management/auth-files")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("", { status: 404 });
    }));

    const svc = new CliProxySyncService({ dataDir: dir, logger: console as any });
    const result = await svc.syncAccount(7, "antigravity");

    expect(result.ok).toBe(true);
    expect(uploadedName).toBe("antigravity-gfa-7-u@example.com.json");
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
    expect(stored.accounts[0].cliproxySync).toMatchObject({ desired: "enabled", remoteName: uploadedName, remoteProvider: "antigravity", revision: 1 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/cliproxy-sync.service.spec.ts
```

Expected: FAIL，原因是 `cliproxy-sync.service.ts` 不存在。

- [ ] **Step 3: 创建同步服务**

实现 `CliProxySyncService` 的基础结构：

```ts
import * as crypto from "crypto";
import * as path from "path";
import { BadRequestException, Logger } from "@nestjs/common";
import { readJson, writeJson } from "./lib/store";

type CliProxyProvider = "gemini" | "antigravity";
type SyncDesired = "enabled" | "disabled" | "deleted";

export type CliProxySyncState = {
  desired: SyncDesired;
  remoteProvider: CliProxyProvider;
  remoteName: string;
  revision: number;
  tokenHash: string;
  lastSyncedAt: number;
  lastSeenAt: number;
  lastError: string;
};

export class CliProxySyncService {
  constructor(private readonly ctx: { dataDir: string; logger: Logger | Console }) {}

  async syncAccount(accountId: number, provider: CliProxyProvider = "antigravity") {
    const { baseUrl, managementKey } = this.requireConfig();
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((a: any) => Number(a.id) === Number(accountId));
    if (!account) return { ok: false, error: "账号不存在" };
    if (!account.refreshToken) return { ok: false, error: "账号没有 refreshToken" };
    if (account.quotaStatus === "error" || account.enabled === false || account.poolEnabled === false) {
      return this.markDesiredDisabled(filePath, data, account, provider, baseUrl, managementKey);
    }
    const remoteName = this.remoteName(account, provider);
    const revision = Number(account.cliproxySync?.revision || 0) + 1;
    const credential = this.credentialFor(account, provider);
    const resp = await fetch(`${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(remoteName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${managementKey}` },
      body: JSON.stringify(credential),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      account.cliproxySync = this.nextState(account, provider, remoteName, revision, "enabled", `HTTP ${resp.status}: ${text.slice(0, 120)}`);
      writeJson(filePath, { ...data, accounts, updatedAt: new Date().toISOString() });
      return { ok: false, error: account.cliproxySync.lastError };
    }
    account.cliproxySync = this.nextState(account, provider, remoteName, revision, "enabled", "");
    writeJson(filePath, { ...data, accounts, updatedAt: new Date().toISOString() });
    return { ok: true, remoteName, revision };
  }

  private requireConfig() {
    const baseUrl = process.env.CLIPROXY_BASE_URL;
    const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY;
    if (!baseUrl || !managementKey) throw new BadRequestException("CLIProxyAPI 未配置");
    return { baseUrl, managementKey };
  }

  private remoteName(account: any, provider: CliProxyProvider) {
    return `${provider}-gfa-${Number(account.id)}-${String(account.email || "unknown")}.json`;
  }

  private tokenHash(account: any) {
    return crypto.createHash("sha256").update(String(account.refreshToken || "")).digest("hex").slice(0, 16);
  }

  private credentialFor(account: any, provider: CliProxyProvider) {
    if (provider === "antigravity") {
      return { type: "antigravity", email: account.email, project_id: account.projectId || "", refresh_token: account.refreshToken, access_token: account.accessToken || "" };
    }
    return { type: "gemini", email: account.email, project_id: account.projectId || "", token: { refresh_token: account.refreshToken } };
  }

  private nextState(account: any, provider: CliProxyProvider, remoteName: string, revision: number, desired: SyncDesired, lastError: string): CliProxySyncState {
    return { desired, remoteProvider: provider, remoteName, revision, tokenHash: this.tokenHash(account), lastSyncedAt: lastError ? 0 : Date.now(), lastSeenAt: Date.now(), lastError };
  }
}
```

- [ ] **Step 4: 从 RosettaService 委托现有 upload 逻辑**

在构造函数中增加：

```ts
private readonly cliproxySyncSvc: CliProxySyncService;
// constructor
this.cliproxySyncSvc = new CliProxySyncService(this.ctx);
```

新增 facade 方法：

```ts
resyncCliProxyAccount(body: any) {
  return this.cliproxySyncSvc.syncAccount(Number(body?.accountId), body?.provider === "gemini" ? "gemini" : "antigravity");
}
```

保持 `uploadToCliProxy()` 兼容老接口，内部循环调用 `syncAccount` 并汇总结果。

- [ ] **Step 5: 增加手动同步接口**

在 `RosettaController` 增加：

```ts
@Post("cliproxy-resync-account")
resyncCliProxyAccount(@Body() body: any) {
  return this.rosetta.resyncCliProxyAccount(body);
}
```

- [ ] **Step 6: 验证**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/cliproxy-sync.service.spec.ts
pnpm --filter @gfa/api test -- src/rosetta/__tests__/rosetta.service.spec.ts
pnpm --filter @gfa/api lint
```

Expected: tests PASS；lint exit 0。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/rosetta/cliproxy-sync.service.ts apps/api/src/rosetta/rosetta.service.ts apps/api/src/rosetta/rosetta.controller.ts apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts apps/api/src/rosetta/__tests__/rosetta.service.spec.ts
git commit -m "feat: track cliproxy sync state"
```

## Task 4: CLIProxy 错误回传接收端

**Files:**
- Modify: `apps/api/src/lease-core/lease-service.ts`
- Modify: `apps/api/src/rosetta/cliproxy-sync.service.ts`
- Modify: `apps/api/src/rosetta/rosetta.controller.ts`
- Modify: `apps/api/src/rosetta/rosetta.service.ts`
- Test: `apps/api/src/token-server/__tests__/token-server.service.spec.ts`
- Test: `apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts`

- [ ] **Step 1: 写 lease-core 外部错误失败测试**

在 `token-server.service.spec.ts` 增加：

```ts
it("external invalid_grant report marks the account auth-dead", async () => {
  tokenProvider.mockResolvedValue("access-token-ok");
  const service = makeService();
  const r = await service.leaseToken(REQ, leasePayload({ modelKey: "gemini-3.1-flash-image" }));

  expect(service.applyExternalAccountFailure({
    accountId: r.accountId,
    modelKey: "gemini-3.1-flash-image",
    status: 400,
    reason: "invalid_grant",
  })).toEqual({ ok: true, action: "auth_dead" });

  const acct: any = service.getStatus().quota.accounts.find((a: any) => a.id === r.accountId);
  expect(acct.quotaStatus).toBe("error");
  expect(acct.quotaStatusReason).toBe("invalid_grant");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @gfa/api test -- src/token-server/__tests__/token-server.service.spec.ts -t "external invalid_grant"
```

Expected: FAIL，原因是 `applyExternalAccountFailure` 不存在。

- [ ] **Step 3: 在 LeaseService 暴露外部失败入口**

在 `LeaseService` 增加：

```ts
applyExternalAccountFailure(payload: { accountId: number; modelKey?: string; status: number; reason?: string; retryAfterMs?: number }) {
  const accountId = Number(payload.accountId);
  const modelKey = String(payload.modelKey || "");
  const status = Number(payload.status || 0);
  const reason = String(payload.reason || "");
  const retryAfterMs = Number(payload.retryAfterMs || 0);
  if (!Number.isFinite(accountId) || accountId <= 0) return { ok: false, error: "invalid accountId" };
  if ((status === 400 || status === 401) && reason.includes("invalid_grant")) {
    const state = this.ensureRuntime(accountId);
    state.tokenDeathStrikes = TOKEN_DEATH_STRIKE_THRESHOLD - 1;
    this.markAccountTokenError(accountId, reason);
    return { ok: true, action: "auth_dead" };
  }
  if (status === 429 || status === 503) {
    const cooldownMs = this.cooldownForExhaustion(status, reason || (status === 429 ? "quota" : "capacity"), retryAfterMs, accountId, modelKey);
    this.markAccountExhausted(accountId, modelKey, reason || (status === 429 ? "quota" : "capacity"), cooldownMs);
    return { ok: true, action: status === 429 ? "model_quota" : "model_capacity" };
  }
  if (status === 401) {
    this.mutateAccount(accountId, (account) => {
      const a = account as any;
      a.accessToken = "";
      a.accessTokenExpiresAt = 0;
      return account;
    });
    return { ok: true, action: "token_cache_cleared" };
  }
  this.markAccountTransientError(accountId, modelKey, reason || `http_${status}`);
  return { ok: true, action: "transient_error" };
}
```

- [ ] **Step 4: 写回传端点测试**

在 `cliproxy-sync.service.spec.ts` 增加：

```ts
it("ignores stale revision reports and accepts current invalid_grant reports", async () => {
  writeJson(path.join(dir, "accounts.json"), { accounts: [{
    id: 9,
    email: "bad@example.com",
    refreshToken: "rt",
    cliproxySync: { desired: "enabled", remoteProvider: "antigravity", remoteName: "antigravity-gfa-9-bad@example.com.json", revision: 3, tokenHash: "h", lastSyncedAt: 1, lastSeenAt: 1, lastError: "" },
  }] });
  const lease = { applyExternalAccountFailure: vi.fn(() => ({ ok: true, action: "auth_dead" })) };
  const svc = new CliProxySyncService({ dataDir: dir, logger: console as any });

  expect(await svc.handleReport({ gfaAccountId: 9, remoteName: "antigravity-gfa-9-bad@example.com.json", revision: 2, provider: "antigravity", model: "m", status: 400, reason: "invalid_grant" }, lease as any))
    .toMatchObject({ ok: true, ignored: true, reason: "stale_revision" });

  expect(await svc.handleReport({ gfaAccountId: 9, remoteName: "antigravity-gfa-9-bad@example.com.json", revision: 3, provider: "antigravity", model: "m", status: 400, reason: "invalid_grant" }, lease as any))
    .toMatchObject({ ok: true, action: "auth_dead" });
  expect(lease.applyExternalAccountFailure).toHaveBeenCalledOnce();
});
```

- [ ] **Step 5: 实现 `handleReport` 和控制器鉴权**

`CliProxySyncService.handleReport` 校验 account id、remoteName、revision、provider 后调用 `leaseService.applyExternalAccountFailure`。

控制器新增：

```ts
@Post("cliproxy-report")
reportCliProxyFailure(@Headers("x-cliproxy-report-secret") secret: string, @Body() body: any) {
  if (secret !== process.env.CLIPROXY_REPORT_SECRET) throw new UnauthorizedException("Invalid CLIProxy report secret");
  return this.rosetta.handleCliProxyReport(body, this.tokenServer);
}
```

- [ ] **Step 6: invalid_grant 后触发禁用同步**

`handleReport` 中当 action 为 `auth_dead` 时，把账号 `cliproxySync.desired` 写成 `"disabled"`，并调用远端禁用或删除方法。

- [ ] **Step 7: 验证**

Run:

```bash
pnpm --filter @gfa/api test -- src/token-server/__tests__/token-server.service.spec.ts -t "external invalid_grant"
pnpm --filter @gfa/api test -- src/rosetta/__tests__/cliproxy-sync.service.spec.ts
pnpm --filter @gfa/api lint
```

Expected: tests PASS；lint exit 0。

- [ ] **Step 8: 提交**

```bash
git add apps/api/src/lease-core/lease-service.ts apps/api/src/rosetta/cliproxy-sync.service.ts apps/api/src/rosetta/rosetta.controller.ts apps/api/src/rosetta/rosetta.service.ts apps/api/src/token-server/__tests__/token-server.service.spec.ts apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts
git commit -m "feat: accept cliproxy account failure reports"
```

## Task 5: 对账与前端同步状态

**Files:**
- Modify: `apps/api/src/rosetta/cliproxy-sync.service.ts`
- Modify: `apps/api/src/rosetta/rosetta.controller.ts`
- Modify: `apps/web/src/app/console/(dashboard)/rosetta-cliproxy/page.tsx`
- Modify: `apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx`
- Test: `apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts`

- [ ] **Step 1: 写对账失败测试**

在 `cliproxy-sync.service.spec.ts` 增加：

```ts
it("reconcile uploads missing enabled accounts and marks unmanaged remote files", async () => {
  writeJson(path.join(dir, "accounts.json"), { accounts: [{ id: 10, email: "sync@example.com", refreshToken: "rt", projectId: "p", enabled: true }] });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/v0/management/auth-files")) return new Response(JSON.stringify(["manual.json"]), { status: 200 });
    if (u.includes("/v0/management/auth-files?name=")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response("", { status: 404 });
  }));
  const svc = new CliProxySyncService({ dataDir: dir, logger: console as any });
  const out = await svc.reconcile();
  expect(out.uploaded).toContain(10);
  expect(out.unmanaged).toContain("manual.json");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/cliproxy-sync.service.spec.ts -t "reconcile uploads"
```

Expected: FAIL，原因是 `reconcile` 不存在。

- [ ] **Step 3: 实现 `reconcile`**

实现：

```ts
async reconcile(provider: CliProxyProvider = "antigravity") {
  const { baseUrl, managementKey } = this.requireConfig();
  const remote = await this.listRemoteFiles(baseUrl, managementKey);
  const data = readJson(path.join(this.ctx.dataDir, "accounts.json"), { accounts: [] });
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const expected = new Set(accounts.map((a: any) => this.remoteName(a, provider)));
  const uploaded: number[] = [];
  for (const account of accounts) {
    const name = this.remoteName(account, provider);
    if (account.enabled !== false && account.quotaStatus !== "error" && !remote.has(name)) {
      const r = await this.syncAccount(Number(account.id), provider);
      if (r.ok) uploaded.push(Number(account.id));
    }
  }
  const unmanaged = Array.from(remote).filter((name) => !expected.has(name));
  return { ok: true, uploaded, unmanaged };
}
```

- [ ] **Step 4: 控制器增加手动对账**

```ts
@Post("cliproxy-reconcile")
reconcileCliProxy(@Body() body: any) {
  return this.rosetta.reconcileCliProxy(body);
}
```

- [ ] **Step 5: 前端展示同步状态**

在 CLIProxy 管理页 `RosettaAccount` 类型加：

```ts
cliproxySync?: {
  desired?: string;
  remoteProvider?: string;
  remoteName?: string;
  revision?: number;
  lastSyncedAt?: number;
  lastError?: string;
};
```

表格新增同步列：

```tsx
<TableHead>同步</TableHead>
```

渲染：

```tsx
<TableCell>
  {acc.cliproxySync?.lastError ? (
    <Badge variant="destructive">同步失败</Badge>
  ) : acc.cliproxySync?.lastSyncedAt ? (
    <Badge variant="default">已同步</Badge>
  ) : (
    <Badge variant="secondary">未同步</Badge>
  )}
</TableCell>
```

账号页行操作增加重新同步按钮，调用：

```ts
await fetch("/api/rosetta/cliproxy-resync-account", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ accountId, provider: "antigravity" }),
});
```

- [ ] **Step 6: 验证**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/cliproxy-sync.service.spec.ts
pnpm --filter @gfa/api lint
pnpm --filter @gfa/web lint
```

Expected: tests PASS；lint exit 0。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/rosetta/cliproxy-sync.service.ts apps/api/src/rosetta/rosetta.controller.ts apps/api/src/rosetta/rosetta.service.ts apps/api/src/rosetta/__tests__/cliproxy-sync.service.spec.ts apps/web/src/app/console/(dashboard)/rosetta-cliproxy/page.tsx apps/web/src/app/console/(dashboard)/rosetta-accounts/page.tsx
git commit -m "feat: reconcile cliproxy auth state"
```

## Task 6: CLIProxy 运行时换号改造

**Files:**
- Remote source: `/opt/cliproxyapi` on the production server, or the matching local CLIProxyAPI repository if it is later added to this workspace.

- [ ] **Step 1: 读取 CLIProxy 源码定位 auth 选择与错误处理**

Run on the CLIProxy source tree:

```bash
rg -n "executeClaudeNonStream|invalid_grant|RoundRobinSelector|auth-files|quota|cooldown|request-retry" .
```

Expected: locate Antigravity execution path, auth selector, and upstream error handling.

- [ ] **Step 2: 写 CLIProxy 失败测试**

在 CLIProxyAPI 的测试目录增加一条行为测试：

```ts
it("reports invalid_grant and retries the next antigravity auth", async () => {
  const reports: any[] = [];
  const pool = makePool([
    auth({ id: "bad", email: "bad@example.com", type: "antigravity" }),
    auth({ id: "good", email: "good@example.com", type: "antigravity" }),
  ]);
  upstream.respondFor("bad", { status: 400, body: { error: "invalid_grant" } });
  upstream.respondFor("good", { status: 200, body: { choices: [{ message: { content: "ok" } }] } });
  gfaReportServer.onReport((body) => reports.push(body));

  const res = await client.chat({ model: "gemini-3.1-flash-image", messages: [{ role: "user", content: "hi" }] });

  expect(res.status).toBe(200);
  expect(reports[0]).toMatchObject({ status: 400, reason: "invalid_grant", model: "gemini-3.1-flash-image" });
  expect(pool.get("bad").blocked).toBe(true);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run in CLIProxyAPI:

```bash
npm test -- invalid_grant
```

Expected: FAIL，当前逻辑会直接返回 400 或不会上报 GFA。

- [ ] **Step 4: 实现本地 block、GFA report、换号重试**

在 CLIProxy 的账号级错误处理处增加：

```ts
if (status === 400 && String(errorBody?.error || errorBody?.error_description || "").includes("invalid_grant")) {
  authState.block(auth.id, { reason: "invalid_grant", blockedUntil: Date.now() + INVALID_GRANT_BLOCK_MS });
  await gfaReporter.report({
    provider: auth.type,
    gfaAccountId: auth.gfa_account_id,
    remoteName: auth.fileName,
    revision: auth.gfa_revision,
    model,
    status,
    reason: "invalid_grant",
    requestId,
    at: Date.now(),
  });
  continue;
}
```

- [ ] **Step 5: 运行 CLIProxy 测试**

Run:

```bash
npm test -- invalid_grant
```

Expected: PASS，坏 auth 被 block，GFA 收到 report，请求由下一账号成功。

- [ ] **Step 6: 部署前手工验证**

在测试环境请求 `gemini-3.1-flash-image`，人为放入一个失效 auth 和一个有效 auth。期望：

- new-api 最终收到成功响应。
- CLIProxy 日志出现一次 `invalid_grant` 上报。
- GFA 后台该失效账号显示“已失效·鉴权失效”。
- CLIProxy 不再继续轮询该坏 auth。

## Task 7: 总体验证与部署检查

**Files:**
- No new files.

- [ ] **Step 1: API 关键测试**

Run:

```bash
pnpm --filter @gfa/api test -- src/rosetta/__tests__/cliproxy-sync.service.spec.ts src/rosetta/__tests__/google-oauth.service.spec.ts src/token-server/__tests__/token-server.service.spec.ts
```

Expected: PASS。

- [ ] **Step 2: Web 类型检查**

Run:

```bash
pnpm --filter @gfa/web lint
```

Expected: exit 0。

- [ ] **Step 3: API 类型检查**

Run:

```bash
pnpm --filter @gfa/api lint
```

Expected: exit 0。

- [ ] **Step 4: 部署环境变量确认**

Confirm production has:

```text
CLIPROXY_BASE_URL=http://154.12.88.124:8317
CLIPROXY_MANAGEMENT_KEY=<existing management key>
CLIPROXY_REPORT_SECRET=<new random shared secret>
```

The same `CLIPROXY_REPORT_SECRET` must be configured in CLIProxyAPI.

- [ ] **Step 5: 手工验收**

Use the GFA console:

1. 打开 Antigravity 账号页，确认状态列显示“正常 / 已失效·鉴权失效 / 冷却中”。
2. 对一个测试账号点击重新同步，确认 CLIProxy 页面出现对应 `antigravity-gfa-<id>-<email>.json`。
3. 对一个失效账号点击重新授权，完成 OAuth 后确认状态恢复正常、revision 递增。
4. 触发一次 CLIProxy `invalid_grant` 上报，确认 GFA 后台标红并同步禁用远端 auth。

- [ ] **Step 6: 最终提交**

```bash
git status --short
pnpm --filter @gfa/api lint
pnpm --filter @gfa/web lint
git log --oneline -5
```

Expected: only intentional files changed; lint exits 0; recent commits match tasks.
