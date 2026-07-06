# VSCode 插件沙箱接管(第 7 个接管目标)设计

- 日期:2026-07-06
- 范围:冰茶接管中心新增第 7 个目标 `claude_vscode_sandbox`
- 依赖:复用已有的沙箱功能(`sandbox_*.go` + gfa-claude kit)

## 目标

让 **VSCode 的 Claude Code 扩展(侧边栏面板)** 跑进 sbx 沙箱,得到:
- **侧边栏 UI**(宿主上的官方扩展,不改、不 fork)
- **sbx microVM 强隔离**(claude 在盒子里,碰不到宿主其它文件)
- **用户零操作**(冰茶一键配好一切)

填补现状空白:现有第 4「Claude Code」覆盖 VSCode 扩展但无隔离;第 6「沙箱模式」有隔离但只到 CLI。本目标 = VSCode 扩展 + 隔离。

## 关键机制:官方 `claudeProcessWrapper` 设置

Claude Code VSCode 扩展有官方设置 `claudeCode.claudeProcessWrapper`:
> "Executable used to launch the Claude process. The bundled binary path is passed as an argument when present."
> 来源:https://code.claude.com/docs/en/ide-integrations

即扩展启动 claude 时会调 `<wrapper> <内置claude路径> <参数...>`。把 wrapper 指向冰茶脚本,即可把这次启动**透明重定向进沙箱**——无需 fork 扩展、无需 hack PATH、无需 patch。

## 用户体验

接管中心一张卡「Claude Code · VSCode 沙箱模式」+ 一个「开启」按钮。点一下即完成,用户不碰任何脚本/设置。

## 冰茶「开启」时自动做的三件事

**① 装 wrapper 脚本**(如 `~/.bcai/claude-in-sbx.sh`):
```sh
#!/bin/sh
shift                                    # 丢掉扩展传来的宿主 claude 路径
exec sbx exec bcai-claude claude "$@"    # 改在常驻沙箱里跑 claude,stdio 透传
```

**② 写 VS Code 设置**(settings.json):
```json
"claudeCode.claudeProcessWrapper": "~/.bcai/claude-in-sbx.sh"
```

**③ 起常驻沙箱**(复用现有 kit,挂工作区 + 网关 env/时区):
```sh
sbx run -d --kit gfa-claude --name bcai-claude <工作区目录>
```

**还原**:清设置 ② + 删脚本 ① + `sbx stop bcai-claude`。

## 数据流

```
VSCode 侧边栏 Claude(宿主扩展 UI)
  → 扩展启动 claude
  → 因设置②走脚本①
  → 脚本① sbx exec 进沙箱③
  → claude 在 sbx microVM 里干活、改挂载工作区
  → JSON 流(stdout)回宿主扩展显示
```

## 复用

沙箱本体(kit 生成、gateway env、时区、policy、挂载)= 现有 `sandbox_*.go` 那套,直接复用。本目标新增的只是:wrapper 脚本 + 写 VSCode 设置 + 常驻沙箱生命周期。

## 开放风险(必须真机验)

扩展 ↔ claude 有**两条通道**(见文档 §"built-in IDE MCP server"):
1. **stdio JSON 流** —— 对话/编辑内容。`sbx exec` 天然透传,无碍。
2. **本地 IDE MCP 服务** —— 扩展在宿主 `127.0.0.1` 随机高位端口开,claude 连回来做**原生 diff 预览、读选中代码(@-mention)、Jupyter 执行**;鉴权 token 在宿主 `~/.claude/ide/` 锁文件。

claude 进沙箱后要用富 IDE 功能,须从沙箱连回宿主这个**随机端口**:需 `host.docker.internal` + `sbx policy allow` 该端口(每次激活变)+ 把 `~/.claude/ide/` 挂进沙箱。**基础对话/编辑走 stdio 无碍;native diff / 选区上下文需桥这个端口**——这是本目标真正的工程活。

## 未验证(动手前 Phase 0)

1. `claudeProcessWrapper` + `sbx exec` 链路真机跑通(wrapper 收到的确切 argv、stdio 是否干净透传)
2. IDE MCP 动态端口从沙箱连回宿主可行性 + `~/.claude/ide/` 挂载
3. 扩展是否把工作区/项目路径以宿主绝对路径传入(与沙箱内挂载路径是否一致)

## 平台

同沙箱功能:mac/win/linux。注意这是 **VSCode 扩展**,与 Claude Desktop 的 MSIX/CA 限制无关;Windows 仅需沙箱功能已有的盘符路径处理。
