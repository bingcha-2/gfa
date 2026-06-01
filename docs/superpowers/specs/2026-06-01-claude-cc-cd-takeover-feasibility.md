# 可行性调研:GFA 接入 Claude Code / Claude Desktop(参考 ReClaude 透明接管思路)

> 日期:2026-06-01
> 状态:可行性调研 → **关键决策已锁定**(见下),未进入实现
> 范围约束:**antigravity 与 codex 通路保持不动**,仅新增 Claude Code(cc)/ Claude Desktop(cd)支持

## 决策已锁定(2026-06-01)

1. **上游鉴权 = Claude 订阅号 OAuth(Pro/Max)** —— 对标 ReClaude 真正玩法,需新建 Anthropic OAuth 登录/刷新 + 设备绑定。
2. **cd 纳入范围,且采用透明 MITM + 自签 CA** —— 接受装根 CA 的风险,追求零客户端配置体验。
3. cc 仍走 env 注入(最简,无需 MITM);cd 走 MITM+CA。
4. 利好:**bcai-wails 与 ReClaude 同为 Go**,ReClaude 的 `ca`/`mitm` 子系统可结构化移植。

---

## 1. 背景与目标

参考 ReClaude(一个用 Go 写的 Claude 续杯客户端:本地代理 + 自签 CA + 网关转发)的接管思路,
研究 GFA 能否让用户用自己的 **Claude Code / Claude Desktop** 直接接入 GFA 的账号池,
而无需手动改配置或换客户端。

目标客户端:
- **cc = Claude Code**(官方 CLI)
- **cd = Claude Desktop**(官方 Electron 桌面应用)

---

## 2. GFA 现状(调研结论)

| 维度 | 现状 | 文件证据 |
|---|---|---|
| 客户端形态 | bcai-wails(Go + Wails)= "CodeRelay Desktop",已跑**本地 HTTP 代理** | `apps/bcai-wails/proxy.go` |
| 接管机制 | `TakeoverTarget` 接口,三种注入:`settings` / `asar` / `config` | `apps/bcai-wails/takeover.go` |
| 已支持产品 | Antigravity IDE(改 settings.json)、Antigravity Hub(ASAR 补丁)、Codex(config.toml) | `takeover.go`、`ide_inject.go`、`codex_inject.go` |
| 主代理上游 | **Google / Antigravity**(`daily-cloudcode-pa.googleapis.com`),OAuth 走 `accounts.google.com` | `proxy.go:17`、`account_oauth.go:160` |
| Claude 现状 | **仅作为第三方"模型名"出现在 Antigravity 的 Google 网关里**,无 `api.anthropic.com` 直连通路 | `proxy.go:478`、`account_quota.go:526` |
| 账号租约 | 客户端向服务端 `/lease-token` 租 token,服务端统一调度账号池 | `leaser.go:316`、`API_BASE=/remote-token` |
| Provider 抽象 | 服务端 `lease-core` 有 `Provider<TAccount>` 抽象,**显式为新增上游预留**("antigravity / codex / **future**") | `apps/api/src/lease-core/provider.ts` |
| 用量体系 | 已按账号 5h 窗口剩余配额调度:`remainingFraction`/`getModelQuotaResetAt`/`hasModelQuotaRemaining`;卡密侧已有 `tokenWindowRemaining`/`tokenWindowResetAt` | `token-server/lease-scheduler.ts`、`access-key-store.ts` |
| 账号池数据模型 | `AccountEntry` 已含 `Provider` 字段,枚举值已含 `"claude"`;`QuotaEntry` 同样已含 `"claude"` | `account_pool.go:42/47` |

**关键结论:**
1. GFA **没有**直连 Anthropic 的 Claude 通路 —— 这是一条要**新建**的能力,不是改造现有的。
2. 但 GFA 的两个核心抽象(客户端 `TakeoverTarget`、服务端 `Provider<TAccount>`)**正是为"加一种新上游/新产品"设计的**,贴合度高。
3. 用量/配额体系已成熟,**Claude 用量展示基本可复用**,无需照搬 ReClaude 的透传逻辑。

---

## 3. ReClaude 那套的本质,以及哪部分值得借鉴

ReClaude 的"透明接管"由三块组成:

| ReClaude 组件 | 作用 | 对 GFA 的价值 |
|---|---|---|
| 本地代理 | 拦截 Claude 流量 | GFA **已有**本地代理,不必照搬 |
| 自签 CA + 动态叶子证书 | 解密 HTTPS(因为它不改客户端配置) | **只有接管 Claude Desktop 时才需要**,cc 不需要 |
| 设备 Ed25519 逐请求签名 | 防卡密盗刷/转卖 | 与本议题正交,可单独评估(见第 8 节) |

**核心洞察:ReClaude 之所以"必须"上自签 CA + MITM,是因为它选择了"零客户端配置"。
而 GFA 一旦愿意做一步注入(env / 配置),cc 这条路根本不需要 MITM。**

---

## 4. 两条客户端接管路线对比

### 4.1 Claude Code(cc)—— 低风险,贴合现有架构

Claude Code 认以下配置(env 或 `~/.claude/settings.json`):
- `ANTHROPIC_BASE_URL` → 指向本地代理
- `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`
- `NODE_TLS_REJECT_UNAUTHORIZED`(若用自签证书才需要)

**接管方式:** 新增一个 `claudeCodeTarget` 实现 `TakeoverTarget`,`InjectionType = "env"`(或复用 `settings`),
把 `ANTHROPIC_BASE_URL` 指到 `http://127.0.0.1:<proxyPort>`。**不需要 CA,不需要 MITM。**

- 工作量:小(一个新 takeover target + 代理侧 Anthropic 路由)
- 风险:低(纯配置注入,可一键还原)
- 与现有架构:几乎完美贴合(和 Codex 的 `config` 注入同构)

### 4.2 Claude Desktop(cd)—— 高难度,真正需要 ReClaude 式手段

Claude Desktop 是打包的 Electron 应用,只连 `claude.ai` / `api.anthropic.com`,**不暴露 base_url 开关**。接管它只有两条路:

| 方案 | 做法 | 风险 |
|---|---|---|
| **A. ASAR 补丁** | 改 Electron 包注入 base_url 覆盖(GFA 已有 `PatchAsar`,ReClaude 也走这条) | 中:Claude 升级会还原补丁;需重签名;破坏应用完整性 |
| **B. 透明 MITM + 自签 CA** | 装根 CA,拦截 claude.ai HTTPS(ReClaude 主方案) | 高:装证书需提权 / 用户信任;杀软报毒;证书锁定(pinning)可能直接挡掉;跨平台信任库差异大 |

- 工作量:大(无论 A/B)
- 风险:中~高
- 与现有架构:A 可复用 ASAR 轮子;B 需要全新的 CA/SNI/intercept 子系统(等于把 ReClaude 的 `ca`/`mitm` 模块搬过来)

### 4.3 共性难点:上游鉴权(与 cc/cd 选择无关,都要解决)

这是**整件事最实质的工作量**,不在接管层而在账号层:

- Claude Code/Desktop 的官方鉴权是 **Claude.ai 订阅账号 OAuth**(Pro/Max),不是 API key。
- 需要:Claude 账号池 + OAuth 登录/刷新 + Anthropic 侧的设备/会话绑定处理。
- 类比现有 `account_oauth.go`(对 Google),需新写一套对 Anthropic 的 OAuth。
- 若改用 **Anthropic API key** 模式,鉴权简单很多,但账号来源/成本模型不同(需产品侧确认)。

---

## 5. 用量展示(复用,不照搬 ReClaude)

- ReClaude 是"透传上游 ratelimit 头让 Claude Code 自己画用量条"——因为它没有自己的用量体系。
- GFA **已有**主动计算的用量体系(`remainingFraction` / `tokenWindow*` / 5h 窗口)。
- 新增 Claude provider 后,只需:
  1. 代理转发时解析 Anthropic SSE 的 `usage`(`input_tokens`/`output_tokens`/`cache_*`)做计量;
  2. 透传 / 解析 `anthropic-ratelimit-unified-*` 与 `retry-after` 用于账号调度与展示;
  3. provider 的 `statusAccountExtras` / `quotaFractionFor` 把 Claude 5h 剩余暴露给控制台(和 Codex 同构)。

---

## 6. 与现有架构的贴合度评分

| 改动点 | 贴合度 | 说明 |
|---|---|---|
| 服务端新增 Anthropic Provider | ★★★★★ | `Provider<TAccount>` 抽象就是为此设计 |
| 账号池支持 claude | ★★★★☆ | 数据结构已含 `claude`,需补 OAuth 刷新 |
| 客户端 cc 接管(env 注入) | ★★★★★ | 与 Codex `config` 注入同构 |
| 客户端 cd 接管(ASAR) | ★★★☆☆ | 可复用 PatchAsar,但 Claude 升级易碎 |
| 客户端 cd 接管(MITM+CA) | ★★☆☆☆ | 需移植 ReClaude 的 ca/mitm 子系统,风险最高 |
| 用量计量 | ★★★★☆ | 复用现有体系,新增 SSE usage 解析 |

---

## 7. 目标架构与分阶段(基于已锁定决策)

整体链路(**服务端转发**模型,对标 ReClaude 网关):

```
Claude Code (env 注入) ─┐                                  ┌─ 出口层 ─┐
                        ├─→ bcai-wails 本地代理 ─→ GFA 服务端 ─→ [每账号粘性住宅代理] ─→ api.anthropic.com
Claude Desktop ─────────┘   (本地只做拦截+上送)   (账号池/OAuth/    (utls 对齐TLS指纹)
   (透明 MITM + 自签CA 拦截)                       用量/调度)
```

> **关键架构事实(已对齐)**:最终连 Anthropic 的那一跳由 **GFA 服务端**完成(本地代理只做拦截 + 上送),
> 这与 ReClaude **完全一致**——ReClaude 也是本地 MITM → 服务端网关 → Anthropic,真正打 Anthropic 的是网关。
> 因此出口 IP = GFA 服务器 IP(用户 IP 不暴露),且 ReClaude 已在生产证明此模型可行。

### 待建组件清单

| 层 | 组件 | 新建/复用 | 来源参考 |
|---|---|---|---|
| 客户端-接管 | `claudeCodeTarget`(env 注入 `ANTHROPIC_BASE_URL`) | 新建,同构 Codex | `takeover.go` 现有接口 |
| 客户端-接管 | `claudeDesktopTarget`(透明 MITM 拦截 claude.ai) | 新建 | ReClaude `mitm/`、`takeover.go` |
| 客户端-CA | 自签根 CA + 动态叶子证书 + 系统信任库安装 | 移植 | ReClaude `ca/ca.go`(Go,可直接借鉴) |
| 客户端-MITM | SNI 解析 + CONNECT/透明拦截 + 直通白名单 | 移植 | ReClaude `mitm/server.go` |
| 客户端-代理 | Anthropic 路由 + SSE 流式转发 + `usage` 计量 | 新建 | 现有 `proxy_stream.go` 扩展 |
| 客户端-账号 | Anthropic OAuth 登录/刷新(对标 Google 版) | 新建 | `account_oauth.go` 改写上游 |
| 服务端 | `AnthropicProvider implements Provider<TAccount>` | 新建,抽象已留口 | `lease-core/provider.ts` |
| 服务端 | Claude 订阅号账号池 + OAuth refresh + 设备绑定 | 新建 | codex provider 参照 |
| 服务端 | Claude 5h 用量计量 / `statusAccountExtras` 暴露 | 复用+扩展 | `lease-scheduler.ts` |
| **出口层** | **utls TLS 指纹伪装** + HTTP 原样透传 | 新建 | `refraction-networking/utls` |
| **出口层** | **每账号粘性住宅代理**(地域匹配 + IP/账号配比) | 新建 | 第三方住宅代理商 |

### 出口层设计(抗风控的核心)

服务端转发把出口 IP 收敛到 GFA,解决了"一号多 IP",但需避免新生的两个信号:

1. **TLS/HTTP 指纹不匹配** —— 服务端用任意 HTTP 库(Node/Go)转发,其 TLS ClientHello(JA3/JA4)
   与 header 里**声称**的客户端(cc=Node / cd=Electron)对不上。
   - 对策 A:**HTTP 层原样透传**。因本地是 MITM 拦下真客户端请求,转发时保留其 header 顺序/大小写/
     HTTP2 frame settings,不重构 → HTTP 指纹天然为真。
   - 对策 B:**TLS 层用 utls** 把出口 ClientHello 伪装成所声称客户端的指纹。
   - 定位:**廉价保险**。ReClaude 网关未死说明当前未硬卡 pinning,但加上等于焊死该向量。

2. **机房 IP 上的账号密度** —— "一个机房 IP 挂 N 个 Claude 账号"是典型中转农场特征。
   - 对策:服务端转发的**最后一跳走每账号绑定的粘性(sticky)住宅/移动代理**:
     - 每账号一个长期不变的住宅 IP(看起来=一个固定家庭重度用户)
     - 住宅 IP **地域匹配**账号注册/账单国家(避免地理矛盾)
     - **IP/账号配比**:一个 IP/子网只挂 1~少数账号
     - 住宅/移动 ASN 优先于机房 ASN(信誉更高)
   - 代价:住宅代理按 GB 计费(LLM 为 token 密集/字节中等,可控但需进单账号成本模型);
     sticky 会话有时长上限,需做 IP 续租/重绑逻辑。

叠加已有的「**一号 ≤ 4 用户 + 单设备绑定 + 池内请求串行化/日量上限**」,每个账号在 Anthropic 视角 ≈
**固定家庭 IP、固定设备、合理地域、人类级总量的一个重度用户**——同类服务存活的标准打法。

### 分阶段

1. **阶段一:cc + Claude OAuth 池(无 MITM)**
   - 新增 Anthropic Provider + 订阅号 OAuth 登录/刷新 + cc 的 env 注入 takeover。
   - 跑通 "Claude Code → 本地代理 → Anthropic(订阅号)" 全链路,验证用量计量与账号调度。
   - 这一阶段不碰 CA/MITM,先把最难的"账号鉴权"打通。

2. **阶段二:cd 透明 MITM + CA**
   - 移植 ReClaude 的 `ca`/`mitm` 子系统进 bcai-wails,拦截 claude.ai。
   - 处理跨平台信任库安装、证书锁定探测、还原/卸载。

3. **阶段三:打磨**
   - 杀软误报应对、Claude 升级跟随、设备签名防盗刷(可选,见 §8.5)。

---

## 8. 风险与未决问题

- ~~8.1 上游账号模式~~ → **已定:订阅号 OAuth**
- ~~8.2 cd 是否要做~~ → **已定:做,透明 MITM+CA**

仍需关注/后续拍板:

3. **证书/合规**:装根 CA 的合规与杀软误报风险已接受,但需在 UI 上对用户**明确告知**(信任让渡)。
4. **Anthropic 反制(最大不确定性,但多数信号已有对策)**:
   - 多 IP / impossible travel → **服务端转发**消除(出口收敛到 GFA)
   - 机房 IP 农场特征 → **每账号粘性住宅代理 + 地域匹配 + IP/账号配比**(见出口层设计)
   - TLS/HTTP 指纹 → **utls + 原样透传**(廉价保险)
   - 设备 churn → **单设备绑定**
   - 大规模共享 → **一号 ≤ 4 用户 + 池内串行化/日量上限**
   - **不可消除的残余**:Anthropic 的判定规则是**服务端黑盒**(无客户端产物可逆向),且随时可改。
     只能靠**灰度 + 监控封号率**观察,无任何架构能给 100% 保证。
5. **设备签名防盗刷**(ReClaude 的 Ed25519 逐请求签名):是否借此机会引入,提升卡密抗盗刷能力?(与本议题正交,可单列评估。)
6. **维护成本**:cc/cd 跟随官方升级的破坏性变更(尤其 cd 的 Electron 结构、claude.ai 接口),需持续跟进。

### 已确认事项(2026-06-01)

- **A. OAuth 凭据来源** → **GFA 无原生 Claude 订阅号**。现存 provider 仅 `antigravity`(注释:"Gemini + Claude/Opus **via Antigravity IDE Google OAuth**")与 `codex`,即当前 Claude 是借道 Antigravity 的 Google OAuth,非 Anthropic 原生订阅号。**结论:需新建 Claude 订阅号 OAuth 采集/录入 + 入池流程(阶段一主要工作量)。**
- **B. 阶段一交付边界** → **cc + cd 一起上**(用户拍板)。
- **C. claude.ai MITM 实测** → **不跑真机实测,采信 ReClaude 生产证据**。ReClaude 二进制实锤拦截 `api.anthropic.com` / `/v1/messages` / `claude.ai`,证明 Claude Code/Desktop 的模型请求接口 `api.anthropic.com` **未对自定义根 CA 做证书锁定**,透明 MITM 成立。(若上线后遇拦截失败,再补真机回归测试。)

---

## 9. 一句话结论

**可行,服务端贴合度很高(`Provider` 抽象就是为加新上游留的),且架构完全对标 ReClaude(本地 MITM → 服务端转发 → Anthropic),ReClaude 已在生产验证此模型。**
最实质的工作量是 **Claude 订阅号 OAuth 鉴权 + 账号采集入池**;抗风控的多数信号已有对策(服务端转发 + 粘性住宅代理 + utls + 单设备 + 限流),
**唯一不可消除的残余是 Anthropic 的黑盒封号规则**,只能灰度观察。

把出口层设计纳入后,工程实现把握 ~80–85%,"上线稳定存活"把握 ~80%(其余取决于黑盒风控)。
建议**阶段一先打通 cc + OAuth 账号链路 + 出口层**,把最不确定的"账号鉴权 + 是否被封"用最小成本先暴露,再推进 cd 的 MITM。
