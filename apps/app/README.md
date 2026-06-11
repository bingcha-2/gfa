# CodeRelay Desktop

CodeRelay Desktop 是一个桌面端 IDE 代理网关，用于接管 Antigravity IDE / Hub 的 AI 请求，实现账号卡授权、模型代理、Token 自动轮换等功能。

## 技术栈

- **后端**: Go + [Wails v2](https://wails.io/)
- **前端**: Vanilla JS + Vite
- **支持平台**: macOS (Intel & Apple Silicon)、Windows

---

## 开发环境准备

### 必须安装

1. **Go** >= 1.21  
   ```bash
   brew install go        # macOS
   # 或从 https://go.dev/dl/ 下载
   ```

2. **Node.js** >= 16  
   ```bash
   brew install node      # macOS
   ```

3. **Wails CLI** v2  
   ```bash
   go install github.com/wailsapp/wails/v2/cmd/wails@latest
   ```

4. **平台依赖**  
   - **macOS**: Xcode Command Line Tools  
     ```bash
     xcode-select --install
     ```
   - **Windows**: [MSVC Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

### 验证环境

```bash
wails doctor
```

确认所有依赖都是 ✅ 状态。

---

## 开发运行

```bash
cd code-relay-desktop
wails dev
```

访问 http://localhost:34115 可在浏览器中调试前端。

---

## 打包构建

### macOS

```bash
# 通用二进制 (Intel + Apple Silicon)
wails build -platform darwin/universal

# 仅 Intel
wails build -platform darwin/amd64

# 仅 Apple Silicon
wails build -platform darwin/arm64
```

产物路径: `build/bin/CodeRelay Desktop.app`

> **分发提示**: 如果要分发给其他用户，建议用 `codesign` 签名：
> ```bash
> codesign --deep --force --sign - "build/bin/CodeRelay Desktop.app"
> ```

### Windows

在 Windows 上执行：

```bash
wails build -platform windows/amd64
```

产物路径: `build/bin/CodeRelay Desktop.exe`

> **交叉编译** (从 macOS 编译 Windows 版本):
> ```bash
> # 需要安装 mingw-w64
> brew install mingw-w64
> wails build -platform windows/amd64
> ```

### Linux

```bash
wails build -platform linux/amd64
```

产物路径: `build/bin/code-relay-desktop`

---

## 一键构建脚本

推荐使用 `build.sh` 一键构建（自动处理签名、DMG/NSIS 打包）：

```bash
# macOS .app
./build.sh macos

# macOS .app + DMG 安装包
./build.sh macos --dmg
# 或
./build.sh dmg

# Windows .exe (从 macOS 交叉编译，需要 mingw-w64)
./build.sh windows

# Windows .exe + NSIS 安装程序
./build.sh windows --nsis

# Linux
./build.sh linux

# 全平台一次性构建
./build.sh all

# macOS 代码签名
./build.sh sign
```

> DMG 打包需要 `create-dmg`：`brew install create-dmg`  
> Windows 交叉编译需要 `mingw-w64`：`brew install mingw-w64`  
> NSIS 安装包需要 `nsis`：`brew install nsis`

---

## 打包选项

| 参数 | 说明 |
|------|------|
| `-clean` | 构建前清理旧产物 |
| `-upx` | 使用 UPX 压缩二进制 (需安装 upx) |
| `-nsis` | Windows: 生成 NSIS 安装程序 |
| `-skipbindings` | 跳过前端绑定生成 |
| `-ldflags "-s -w"` | 去除调试信息，减小体积 |

示例 - 生产级构建：

```bash
# macOS 精简构建
wails build -platform darwin/universal -clean -ldflags "-s -w"

# Windows 安装程序
wails build -platform windows/amd64 -clean -nsis -ldflags "-s -w"
```

---

## 项目结构

```
code-relay-desktop/
├── main.go              # Wails 应用入口
├── app.go               # 应用生命周期 & 前端绑定 API
├── proxy.go             # 代理核心逻辑 (请求路由、Token 注入、重试)
├── http_proxy.go        # HTTP 代理服务器
├── upstream_net.go      # HTTP 客户端 & 系统代理检测
├── ide_inject.go        # IDE settings.json 注入/恢复
├── config.go            # 配置持久化
├── logger.go            # 日志系统
├── token_leaser.go      # Token 租约管理
├── build/               # Wails 构建配置
│   └── appicon.png      # 应用图标
├── frontend/            # 前端 (Vite + Vanilla JS)
│   ├── index.html       # 主页面
│   └── src/
│       ├── main.js      # 前端逻辑
│       └── style.css    # 样式
└── README.md
```

---

## 功能概览

- **IDE 接管**: 注入 `jetski.cloudCodeUrl` 到 IDE settings.json，将 AI 请求代理到本地
- **Token 轮换**: 自动从上游获取 Token，429/403/500/503 自动换号重试 (最多 10 次)
- **模型缓存**: `fetchAvailableModels` 结果自动缓存，减少上游请求
- **噪音过滤**: 非关键 IDE 请求 (loadCodeAssist, cascadeNuxes 等) 本地 mock 返回
- **系统代理检测**: 自动读取 macOS 系统代理设置 (支持 TUN 模式)
- **实时日志**: 前端实时显示代理日志
