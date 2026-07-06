# 沙箱模式接管(Claude Code · sbx)设计

- 日期:2026-07-06
- 范围:冰茶(BingchaAI)客户端 · 接管中心新增「沙箱模式接管」
- 只做 Claude Code(不含 Codex / 其它)

## 1. 目标与动机

用户越来越担心 Claude Code 这类 AI 编程工具的安全风险(隐私泄露、恶意 MCP/Skill、乱翻本机文件)。Docker 官方的 `sbx`(Docker Sandboxes)能把 Claude Code 关进隔离沙盒。

本功能让冰茶**帮用户把 sbx 装好、配好**,并让沙箱里的 Claude Code **请求仍经宿主冰茶网关出口**——隔离与租号/指纹/IP 脱敏三者兼得:

- **隔离**:沙箱挡住 Claude Code 碰宿主文件 / Cookies(视频卖点)
- **IP 脱敏**:egress 仍从宿主冰茶网关出去(住宅代理 + 用户真实网络)
- **指纹/计费不变**:沿用现有 `claude_proxy` 出口层(逐字节 CLI ClientHello + 母号 header 归一 + 血条/限额/计费),**网关代码零改动**

关键取舍:**冰茶只负责准备(检测/安装/配置/递命令);交互式 Claude Code 会话由用户在自己终端 `sbx run` 里跑**。冰茶不内嵌终端。

## 2. 数据流

```
宿主(用户 macOS / Windows / Linux):
  ├─ 冰茶客户端(照旧在宿主跑)
  │    ├─ 本地网关 :<port>  ← 租号 + 指纹 uTLS + 每号住宅代理 → api.anthropic.com
  │    └─【新增】sbx 管家:检测/安装/配置 sbx、生成 kit、设 policy、拼 run 命令、探 IP 定时区
  │
  └─ sbx 沙盒(隔离):
       ├─ Claude Code(碰不到宿主文件/Cookies)
       ├─ ANTHROPIC_BASE_URL → http://host.docker.internal:<port>
       └─ 挂载:用户项目目录
```

沙箱→宿主可达性依据(已查官方文档,见 §9):sbx 沙盒网络隔离,**仅 HTTP/HTTPS 经宿主侧转发代理**可达宿主;宿主别名 `host.docker.internal` 被 sbx 代理重写为宿主 `localhost`。因此:

- 网关**继续绑 `127.0.0.1:<port>`,不需改绑**(sbx 转发代理跑在宿主上,替沙箱连宿主 loopback)
- 必须显式放行:`sbx policy allow network localhost:<port>`
- Claude Code 接受 `http://` 非 TLS base_url——现有 `claude_inject.go` 已在宿主用 `http://127.0.0.1:<port>`,同一回事

## 3. 用户流程(UI)

1. 接管中心新增卡片「Claude Code · 沙箱模式」
2. 卡片显示 sbx 安装状态;未装 → 「安装」按钮(冰茶代装)
3. 用户配置**挂载目录**(选项目目录,每个标 读/写)
4. 点「开启沙箱接管」→ 冰茶后台:生成 kit + `sbx policy allow` +(Phase 2)探 IP 定时区
5. 冰茶给出**现成命令**(或一键打开系统终端):`sbx run --kit <kit> claude <项目路径...>`
6. 用户复制到自己终端跑;沙箱里 Claude Code 起来,请求经冰茶出口

## 4. 代码结构

沿用接管中心的**注册表模式**(`takeoverTargets`,见 `takeover.go`):新增一个目标 `claude_sandbox` 复用卡片/状态 UI;sbx 特有的动作(装载/kit/挂载/递命令)因装不进通用 `Inject(proxyPort)/Restore()` 接口,单独放叶子模块。

新增文件:

- `sandbox_takeover.go` —— `claudeSandboxTarget`(实现 `TakeoverTarget`,负责检测/状态展示);sbx 编排纯函数:
  - `DetectSbx()` / `InstallSbx()`(平台分支:brew / winget / curl+apt)
  - `GenerateKit(opts) (path, error)` —— 吐 gfa-claude kit
  - `ApplyPolicy(port)` —— `sbx policy allow network localhost:<port>`
  - `BuildRunCommand(kitPath, mounts) string` —— 拼 `sbx run --kit ... claude <路径...>`
  - `OpenInTerminal(cmd)`(可选一键)
- `local_bindings_sandbox.go` —— Wails 绑定,暴露上述给前端(对齐现有 `local_bindings_*.go`)
- 前端:`frontend/src/features/takeover/` 内新增沙箱卡片 + 挂载配置子面板

原则(沿用 `takeover.go` 哲学):**编排层只编排,易碎的 sbx 细节隔离在叶子;端口用网关实际绑定端口**(有兜底会变,不写死 48800)。

## 5. kit 内容

```yaml
environment:
  variables:
    LANG: en_US.UTF-8
    TZ: <Phase 1 固定可配 / Phase 2 按出口 IP 探测>
    ANTHROPIC_BASE_URL: http://host.docker.internal:<网关实际端口>
    ANTHROPIC_AUTH_TOKEN: bcai-claude-proxy      # 哨兵;真号 token 在宿主网关替换,永不进沙箱
network:
  allowedDomains: [ "localhost:<网关实际端口>" ]
commands:
  startup:
    - command: ["sh","-c","mkdir -p /home/agent/.claude && cp <kit>/settings.json /home/agent/.claude/settings.json"]
```

要点:

- `settings.json` 用 kit 的 **startup 命令**写,不能用静态 files 落盘——claude 代理会在静态文件之后覆写 `~/.claude/settings.json`(官方文档明示)
- `en_US.UTF-8` 几乎所有基础镜像自带,免补语言包(选中文才需要补)
- 安全副产品:租到的真号 token 永远在宿主网关被替换,**从不进沙箱**;沙箱里只有哨兵 token

## 6. 时区一致性(分两期)

**背景更正**:租号非「每请求现租」。`LeaseToken` 有 `cachedToken` 缓存复用,`StartAutoLease` 15s ticker 后台续租(`leaser.go:334-343,585,646`);账号 + 其粘性出口代理 `AccountProxyUrl` **整场基本不变**。轮换只发生在额度用尽 / 出错(`excludeAccountIds`)。`claude_session_leaser` 的「轮换」是 claude.ai 网页 sessionKey 轮换,与 `/v1/messages` 无关。故**账号本已粘性,出口 IP 整场稳定**。

**动机**:Anthropic 把时区塞进提示词(随请求正文上行)。故沙箱本地 TZ **确实被 Anthropic 看到**,与出口 IP 地理位置不一致 = 检测点。需让二者对齐。

### Phase 1 · MVP(不碰网关/租号)
时区**固定可配**:默认 `LANG=en_US.UTF-8` + `TZ=America/New_York`,UI 下拉可改。其余(检测/装/kit/policy/挂载/递命令)全在冰茶侧编排即可上线。

### Phase 2 · 一致性增强(读现有粘性租约,非新建锁定机制)
1. 开沙箱时,冰茶**读当前持有的租约**的出口代理(已粘性,无需新「锁账号」机制)
2. 冰茶拿该代理**探一次出口 IP → 查时区**,写进 kit 的 `TZ`(仅开场一次,非每请求)
3. 唯一新增:额度用尽换号时,**优先换同地区的号**,避免时区漂——是给现有轮换加「挑同区」偏好,非新系统
4. 探测方式:**冰茶自己拿代理探**(自给自足,不改服务端)

## 7. 挂载

- UI 选目录,每个标 读 / 写;拼进 `sbx run` 位置参数(`:ro` = 只读)
- 主项目 = `sbx run` 的工作目录(同绝对路径透传)
- 默认只挂当前项目;挂家目录 / 系统盘 → 告警(呼应视频提醒:挂进去的目录 Claude 仍可改)

## 8. 平台支持

冰茶三平台均出包(`build-wails.yml`:Windows x64、macOS arm+Intel、Linux x64)。

| 平台 | sbx 安装 | 注意点 |
|---|---|---|
| macOS | `brew install docker/tap/sbx`,自带虚拟机 | 主力 |
| Windows | `winget install Docker.sbx`,自带虚拟机 | 盘符 `D:\`→沙箱路径映射待验证 |
| Linux | `docker-sbx`,**需 KVM** | 必须裸机(嵌套虚拟化不行);检测 `/dev/kvm`,缺则提示 |

沙箱模式**不需要 OS 原生操作**(装 CA / 重启 App 全外包给 Docker),故跨平台友好。Linux 现有老接管(CA + 重启)是空壳未实现——**沙箱模式很可能是 Linux 用户第一条可用的接管路径**。

按平台分叉仅三处:①装 sbx 命令 ②Linux 检测 KVM ③Windows 盘符映射。其余(kit / policy / 命令 / 探 IP)一套 Go 代码通吃。

## 9. Phase 0 · 真机验证(动 UI/代码前,不可跳)

1. **macOS 最小闭环**:装 sbx → 起冰茶网关 → 手写 kit → `sbx policy allow localhost:<port>` → `sbx run --kit claude` 发一条消息 → **确认请求从冰茶网关出去**
2. **抓真实请求正文**,确认 Claude Code 往提示词塞的时区**格式**(IANA 名 / UTC 偏移 / 仅本地日期)——定 Phase 2 对齐目标
3. **Windows**:盘符 `D:\` 进沙箱**变成啥路径**
4. **en_US 语言包**是否在基础镜像(近乎肯定,确认下)

来源(官方,已查):
- https://docs.docker.com/guides/claude-code-sandbox-model-runner/ (ANTHROPIC_BASE_URL + host.docker.internal + policy allow 的直接先例)
- https://docs.docker.com/ai/sandboxes/architecture/ (网络隔离 / 转发代理)
- https://docs.docker.com/ai/sandboxes/customize/kits/ (kit env / files / network / startup)
- https://docs.docker.com/ai/sandboxes/faq/ (env 变量 + `~/.claude` 不自动挂)
- https://docs.docker.com/reference/cli/sbx/ (CLI 参考)
- https://learn.arm.com/install-guides/sbx/ (Linux/KVM 要求)

## 10. 错误处理 / 边角

- sbx 未装 / 装失败 → 卡片显示状态 + 分级引导(仿现有 CA 失败分级提示)
- Linux 缺 KVM / 在虚拟机内 → 明确提示不可用
- 网关未起 / 未登录 → 复用 `validateTakeoverPrereqs`(需 `cfg.UserToken`)
- Windows 盘符映射不确定 → Phase 0 未验证前,Windows 卡片可先灰置或标「实验」
- Restore = 撤 policy + 删 kit(Phase 2 无需解锁账号,租约本就是共享粘性)

## 11. 测试(遵 TDD 约定)

- 纯函数先写测试:kit 生成、命令拼装、挂载参数、policy 语句、IP→时区映射
- 沙箱 target 的注册/检测走现有 target 测试模式(`*_test.go`)
- 真机交互(`sbx run` / 装 sbx / 开终端)**不进 `go test`**:任何 open/exec 本机进程必须过 `appActionsSuppressed()`(遵 local-tests-no-real-gui 约定),否则 CI 会真去装/跑

## 12. 交付顺序

1. **Phase 0** 真机验证(阻塞后续)
2. **Phase 1** MVP:检测/装 sbx + kit + policy + 挂载 + 递命令 +(固定可配时区);Mac/Win 主力,Linux 覆盖
3. **Phase 2** 时区跟出口 IP + 同地区换号
