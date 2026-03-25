# 交付指南 — Google Family Automation

本文档说明如何将 GFA 打包并交付给最终用户。

---

## 开发者：构建安装包

### 前置要求（开发者机器）

- Node.js LTS + pnpm
- [Inno Setup 6](https://jrsoftware.org/isinfo.php)（免费，用于打包）
- 网络连接（脚本会自动下载 Node.js portable + Redis binary）

### 步骤

```powershell
# 1. 在仓库根目录执行，构建所有产物 + 打包到 release/
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1

# 2. 编译 Inno Setup 安装包
iscc scripts\installer.iss

# 3. 安装包输出在：
#    installer-output\GFA-Setup-1.0.0.exe
```

> 总构建时间约 5-10 分钟（含下载 Node.js ~75MB）

---

## 用户：安装与启动

### 用户前置要求

- Windows 10/11 64位
- 已安装并运行 **AdsPower**

### 步骤

1. 双击 `GFA-Setup-1.0.0.exe` → 按提示安装
2. 安装完成后，双击桌面快捷方式 **「启动 GFA」**
3. **首次启动**会弹出配置向导：

   ![setup wizard](docs/images/setup-wizard.png)

   - **AdsPower API Key**：在 AdsPower → 设置 → API → 本地 API 中获取
   - 端口保持默认（3000 / 3001）
   - 点击「确认并启动」

4. 稍等片刻，浏览器自动打开 `http://localhost:3000`

### 日常使用

| 操作 | 方式 |
|------|------|
| 启动 | 双击桌面「启动 GFA」 |
| 停止 | 双击桌面「停止 GFA」（如有） / Start 菜单 → 停止 GFA |
| 查看状态 | 开始菜单 → Google Family Automation → 查看状态 |
| 日志 | 安装目录 `artifacts\private-hosting\logs\` |

### 重新配置 AdsPower Key

删除安装目录下的 `.env` 文件，再次双击「启动 GFA」即可触发配置向导。

---

## 安装目录结构

```
C:\Program Files\GFA\
├── runtime\
│   ├── node.exe          ← Portable Node.js（无需系统安装）
│   └── redis-server.exe  ← Redis（无需 Docker）
├── apps\api\dist\
├── apps\worker\dist\
├── apps\web\.next\
├── prisma\
├── data\                 ← 用户数据（SQLite 数据库）
├── artifacts\            ← 运行时日志
├── Start-GFA.bat
├── Stop-GFA.bat
└── .env                  ← 首次配置向导生成
```
