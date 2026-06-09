# GFA — 冰茶AI 全栈平台

Google Family Automation + 冰茶AI 代理服务的全栈 monorepo,涵盖 AI 代理桌面端、VS Code 插件、管理后台与自动化 Worker 等全部组件。

---

## 项目结构

```
GFA/
├── apps/
│   ├── bcai-wails/      # 冰茶AI 桌面端 (Go + Wails)
│   ├── gfa-extension/   # 冰茶AI VS Code 插件
│   ├── api/             # 业务 API + Token 租赁服务 (NestJS)
│   ├── web/             # GFA 控制台 & 公开页 (Next.js)
│   └── worker/          # GFA 自动化 Worker (Playwright)
├── packages/
│   └── shared/          # 共享枚举、类型、常量
├── prisma/              # 数据库 Schema + 迁移 (SQLite · Prisma Migrate)
├── scripts/             # 运维脚本、构建工具
├── docs/                # 部署文档、操作手册
└── _deprecated/         # 弃用代码（保留归档）
```

---

## 应用说明

### 🍵 冰茶AI 代理服务

为 AI 编程 IDE 提供 Google Cloud Code API 代理,支持远程号池（卡密）与本地号池两种模式。

| 应用 | 技术栈 | 说明 |
|---|---|---|
| [`bcai-wails`](apps/bcai-wails) | Go · Wails · WebView | 桌面客户端,内嵌代理引擎,监听 `127.0.0.1:60670` 并转发请求到 Google API |
| [`gfa-extension`](apps/gfa-extension) | TypeScript · VS Code API | VS Code 插件,提供账号池管理、代理启停、额度监控等功能 |

### 🖥️ 服务端

| 应用 | 技术栈 | 说明 |
|---|---|---|
| [`api`](apps/api) | NestJS · Prisma · BullMQ | 业务 API + `/api/remote-token/*` Token 租赁 + Rosetta 管理 |

### 📦 GFA 管理后台

Google One Family 自动化管理系统,提供成员邀请、到期移除、账号换绑等全流程自动化。

| 应用 | 技术栈 | 说明 |
|---|---|---|
| [`web`](apps/web) | Next.js · React | 控制台 & 公开兑换 / 状态页 |
| [`worker`](apps/worker) | Playwright · AdsPower | 浏览器自动化 Worker |

---

## 快速上手

### 冰茶AI 桌面端（bcai-wails）

```bash
cd apps/bcai-wails
wails dev          # 开发模式
wails build        # 构建生产二进制
```

> 需安装 [Wails CLI](https://wails.io/docs/gettingstarted/installation) 与 Go ≥ 1.21。

### GFA 管理后台

```bash
# 1. 配置环境变量
cp .env.example .env   # 必填：JWT_SECRET、ADSPOWER_API_KEY

# 2. 初始化（首次）
pnpm dev:setup         # 安装依赖 → 编译 shared → 初始化 DB → seed

# 3. 启动
pnpm dev               # 开发模式（热更新）
pnpm start             # 生产模式
pnpm start:daemon      # 生产模式（后台运行）
```

访问 http://localhost:3000/console/login,默认账号 `admin@gfa.local` / `admin123`。

---

## 常用命令

```bash
pnpm dev               # 启动所有服务（开发模式）
pnpm start             # 启动所有服务（生产模式）
pnpm start:daemon      # 后台启动
pnpm start:stop        # 停止后台服务
pnpm build             # 构建生产包
pnpm db:generate       # 重新生成 Prisma Client
pnpm db:migrate        # 应用待执行的数据库迁移（生产部署）
pnpm db:reset:sqlite   # 重置数据库（⚠️ 清空数据）
```

> 数据库采用 **Prisma Migrate**：版本化迁移按序应用,详见 [`prisma/MIGRATIONS.md`](prisma/MIGRATIONS.md)。

---

## 环境依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 18 | Web / API / Worker / Extension |
| pnpm | latest | Monorepo 包管理 |
| Go | ≥ 1.21 | 冰茶AI 桌面端 |
| Redis | any | BullMQ 任务队列 |
| AdsPower | — | 浏览器自动化 (Worker) |

---

## 文档

- [运营操作手册](docs/OPERATIONS.md) — 账号导入、订单管理、人工干预
- [私有化部署](docs/PRIVATE-HOSTING.md) — 安装包交付模式
- [服务器配置](docs/server-setup-guide.md) — 云服务器环境搭建
- [交付说明](docs/DELIVERY.md) — 交付流程

---

## 弃用代码

[`_deprecated/`](_deprecated/) 目录归档了已被取代的旧组件：

| 目录 | 原用途 | 替代方案 |
|---|---|---|
| `bcai-client/` | Electron 桌面端 + 独立 Go 代理引擎 | → `apps/bcai-wails/`（Wails 一体化） |
| `gfa-client/` | Tauri 桌面端 (v3.x) | → `apps/bcai-wails/`（Wails 一体化） |

详见 [`_deprecated/README.md`](_deprecated/README.md)。
