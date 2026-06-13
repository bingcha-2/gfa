# Codex 自动上号（接码）设计

日期：2026-06-13

## 背景与目标

codex 账号上号目前是手动 OAuth 粘贴回调（[codex.service.ts](../../../apps/api/src/rosetta/codex.service.ts) `startCodexOAuthLogin` → 用户手动登录 → `submitCodexOAuthCallback`）。OpenAI 在登录中常要求**手机短信验证（接码）**，需要人工干预。

目标：在 `console/codex-accounts` 页面提供「自动上号」——用户填账号凭据 + 接码手机号 + 接码网址 + 出口代理，后端用无头浏览器自动完成 邮箱→密码→TOTP→加手机号→**自动接码**→同意，拿到授权 code 换 token 落库。

约束（用户明确）：
- **不复用** `PhoneInfo` / `PhonePool`；手机号与代理由用户在页面手动填。
- 输入**拆成独立字段**。
- 进度**异步轮询**。
- 代理**两种格式都支持**：`socks5://user:pass@host:port` 与 `host:port:user:pass`。

## 已验证的事实（来自本仓库实跑，见 scripts/test_codex_login.ts）

OpenAI（auth.openai.com）登录各步真实页面：
- 邮箱：`/log-in-or-create-account`，`input[type=email][name=email]`，submit "Continue"
- 密码：`/log-in/password`，`input[type=password][name=current-password]`，submit "Continue"
- TOTP：`/mfa-challenge`，`input[name=code][autocomplete=one-time-code][maxlength=6]`，submit "Continue"
- 加手机号：`/add-phone`，`input#tel[type=tel][autocomplete=tel]`，国家码默认 US(+1)，submit "Continue"
- 接码：`/phone-verification`，`input[name=code][autocomplete=one-time-code]`，submit "Continue"（另有 "Resend text message"）
- 同意：`/sign-in-with-chatgpt/codex/consent`，`button[type=submit]` "Continue" → 重定向 `redirect_uri?code=ac_...`
- 账号选择（profile 有旧会话残留时）：`/choose-an-account` → 点 "Log in to another account"

接码网址（yuntl.cc）返回纯文本：无码 `暂无短信|链接到期时间...`；有码 `YES|Your OpenAI verification code is: 461668`（**验证码在 `|` 之后**）。解析：命中 `暂无短信` 返回空；否则剥离 `链接到期...` 尾巴后取首个 6 位数。

## 架构

复用现有 OAuth pending 会话机制（PKCE/authorizeUrl/redirectUri/codeVerifier 由 `startCodexOAuthLogin` 同款逻辑产生），把"浏览器自动拿 code"接到 `completeCodexOAuthLogin`（换 token + 落库）之前，code 同源必可换 token。

### 后端（apps/api）

1. **`lib/codex-login-browser.ts`（新）** — 浏览器驱动。
   - 入参：`{ authorizeUrl, redirectUri, email, password, totpSecret, phoneNumber, smsUrl, proxyUrl, onStep? }`。
   - 启浏览器走用户代理：复用 [playwright-oauth.ts](../../../apps/api/src/rosetta/lib/playwright-oauth.ts) 的本地 SOCKS5 中继 + `chromium.launch`（认证 socks5 chromium 无法直连，故用中继）。代理先经 `toSocks5ProxyUrl` 归一化。
   - URL 驱动的步骤机（已验证逻辑）：邮箱/密码/TOTP/选号页/加手机号/接码/同意；TOTP 用内联实现（或复用 otpauth）。
   - 接码：在浏览器内新开标签 `goto(smsUrl)` 读 body（走代理出口、绕 CORS），轮询解析。
   - 截获 `redirectUri?code=...`（监听导航/请求，不需真起本地 server），返回 `{ ok, code }` 或 `{ ok:false, error, step }`。
   - 每步通过 `onStep(step)` 回调上报，供状态轮询。

2. **`codex.service.ts` 新增 `startAutomatedCodexLogin(payload)` / `getAutomatedCodexLoginStatus(jobId)`**：
   - payload：`{ email, password, totpSecret, phoneNumber, smsUrl, proxyUrl }`。
   - 建 pending（PKCE+authUrl+codeVerifier+redirectUri）。生成 jobId，后台异步跑 `codex-login-browser`，把进度/结果存内存 `Map<jobId, {status, step, email, error}>`（仿 `codexOAuthPending`）。
   - 浏览器返回 code → 调 `completeCodexOAuthLogin(pending, code)` 换 token、落 `codex-accounts.json`，并把归一化后的 **proxyUrl 写到该账号**。
   - 失败：记录卡在哪步 + 报错。

3. **`rosetta.controller.ts` 新增路由**：
   - `POST codex-auto-login` → `startAutomatedCodexLogin`，返回 `{ ok, jobId }`
   - `GET codex-auto-login-status?jobId=` → `{ ok, status, step, email, error }`

### 前端（apps/web `codex-accounts/page.tsx`）

新增卡片「自动上号（接码）」，独立字段：邮箱、密码、TOTP密钥、接码手机号、接码网址、出口代理。
点「开始」→ `POST codex-auto-login` 拿 jobId → 每 ~2s 轮询 status，展示当前步骤（如「正在接码…」）→ `completed` 时 toast + 刷新列表；`failed` 显示卡点与报错。轮询在 `expiresAt`/超时后停。

## 数据流

```
前端表单 → POST codex-auto-login → 建 pending + 起后台 job → 返回 jobId
后台 job: codex-login-browser(authUrl,...) ──步骤回调──> job.step
         浏览器拿 code → completeCodexOAuthLogin → 换 token + 落库(+proxyUrl)
前端轮询 codex-auto-login-status(jobId) → 展示进度 → 完成刷新列表
```

## 错误处理
- 浏览器各步超时/选择器未命中：返回 `{ok:false, step, error}`，状态置 failed，附最后 URL（便于定位）。
- 接码轮询超时（默认 ~90s）：failed，提示「未收到短信验证码（可重发后重试）」。
- token 交换失败：沿用 `completeCodexOAuthLogin` 抛错，状态 failed。
- 代理无效：`toSocks5ProxyUrl` 归一化后校验，提前报错。

## 测试
- 单元：接码解析 `extractCode`（真实样本：暂无/YES-有码/含到期尾巴）、代理归一化两种格式、TOTP 生成。
- 集成（手动/半自动）：用真实账号+接码号跑一次 `codex-auto-login`，验证落库 + token 可刷新（已用 scripts/test_codex_login.ts 验证过浏览器侧闭环）。

## 非目标 / YAGNI
- 不做手机号池/轮换、不做代理池（用户手填）。
- 不做并发批量上号（v1 单账号；jobId 机制天然可扩展）。
- 复用现有 `completeCodexOAuthLogin`，不重写 token 交换。
