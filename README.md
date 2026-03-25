# Google Family Automation

Monorepo for the Google One family automation project.

---

## Apps

| App | Description |
|-----|-------------|
| `apps/web` | 控制台 & 公开兑换/状态页 (Next.js) |
| `apps/api` | 业务 API、队列编排、持久层 (NestJS) |
| `apps/worker` | AdsPower + Playwright 自动化 Worker |
| `packages/shared` | 共享枚举、队列名称、任务类型 |

---

## 技术栈

- Next.js · NestJS · SQLite · Prisma · Redis · BullMQ · AdsPower · Playwright

---

## 环境准备

### 1. 安装 Node.js

下载并安装 [Node.js LTS](https://nodejs.org/)（≥ 18），安装后验证：

```powershell
node -v
```

### 2. 安装 pnpm

```powershell
npm install -g pnpm
```

### 3. Redis（必须）

系统使用 BullMQ，**Redis 是必须的依赖**。根据你的环境选择以下任一方式：

#### 方式 A：Windows 原生 Redis（推荐，无需 Docker）

从 [tporadowski/redis](https://github.com/tporadowski/redis/releases) 下载最新的 `.msi` 安装包，安装后 Redis 会作为 Windows 服务自动运行：

```powershell
# 验证 Redis 是否正在运行
redis-cli ping
# 返回 PONG 即表示正常
```

> 默认端口为 `6379`，`.env` 中无需修改 `REDIS_URL`。

#### 方式 B：Docker（若已安装）

```powershell
docker compose up -d redis
```

#### 方式 C：WSL2 内运行 Redis

在 WSL2 终端中：
```bash
sudo service redis-server start
```

然后在 `.env` 中将 `REDIS_URL` 改为：
```
REDIS_URL="redis://127.0.0.1:6379"
```

---

## 快速启动（源码开发模式）

### 第一步：克隆并进入项目目录

```powershell
cd google-family-automation
```

### 第二步：配置 `.env` 文件

复制示例配置：

```powershell
Copy-Item .env.example .env
```

用文本编辑器打开 `.env`，按下方说明填写：

```dotenv
# SQLite 数据库路径，无需修改
DATABASE_URL="file:./dev.db"

# Redis 连接地址，本机默认不用改
REDIS_URL="redis://localhost:6379"

# Web 控制台端口（访问地址: http://localhost:3000）
WEB_PORT="3000"

# API 服务端口
API_PORT="3001"

# Worker 实例名称（多 Worker 时区分用）
WORKER_NAME="worker-1"

# API 内部地址（Web 与 Worker 用来调用 API）
API_BASE_URL="http://127.0.0.1:3001/api"

# AdsPower 本地 API 地址（保持默认即可）
ADSPOWER_HOST="http://127.0.0.1:50325"

# AdsPower API Key（必填，在 AdsPower 客户端设置中获取）
ADSPOWER_API_KEY="your_adspower_api_key_here"

# 留空即可（由框架自动判断 http/https）
CONSOLE_COOKIE_SECURE=""

# JWT 签名密钥（生产环境务必改成随机字符串）
JWT_SECRET="gfa-dev-secret-change-in-production"
```

> **`ADSPOWER_API_KEY` 是唯一必须手动填写的字段。**  
> 其余字段保持默认值即可启动。

### 第三步：安装依赖

```powershell
pnpm install
```

### 第四步：初始化数据库

```powershell
# 生成 Prisma Client
pnpm db:generate

# 创建/同步 SQLite 数据库（文件位于 prisma/dev.db）
pnpm db:init:sqlite

# 写入默认用户（admin / support）
pnpm db:seed
```

### 第五步：启动所有服务

**方式 A：分终端启动（开发推荐）**

打开三个 PowerShell 窗口，分别执行：

```powershell
# 窗口 1 - API 服务
pnpm dev:api

# 窗口 2 - Worker 自动化
pnpm dev:worker

# 窗口 3 - Web 控制台
pnpm dev:web
```

**方式 B：单命令并行启动**

```powershell
pnpm dev
```

### 第六步：访问控制台

| 地址 | 说明 |
|------|------|
| http://localhost:3000/console/login | 管理员登录页 |
| http://localhost:3000/ | 公开兑换/状态页 |
| http://localhost:3001/api/health | API 健康检查 |

---

## 默认登录账号

数据库初始化（`pnpm db:seed`）后会自动创建以下账号：

| 邮箱 | 密码 | 角色 |
|------|------|------|
| `admin@gfa.local` | `admin123` | ADMIN（完全权限） |
| `support@gfa.local` | `admin123` | SUPPORT（只读/客服） |

> ⚠️ **生产环境请登录后立即修改密码，并将 `.env` 中的 `JWT_SECRET` 替换为随机强密码。**

---

## Windows 生产部署（私有托管）

如果你是在 Windows 服务器上为客户交付，请使用项目根目录下的一键启动脚本，**无需手动执行上述步骤**：

```
Start-GFA.bat    ← 首次运行会自动完成所有初始化
Stop-GFA.bat     ← 停止所有服务
Status-GFA.bat   ← 查看运行状态
```

首次 `Start-GFA.bat` 会自动完成：

1. 从 `.env.example` 创建 `.env`（若不存在）
2. 弹出配置向导填写 AdsPower API Key
3. 安装依赖（`pnpm install`）
4. 构建生产包（`pnpm build`）
5. 启动 Redis（Docker 方式）
6. 初始化并 seed 数据库
7. 后台运行 API / Worker / Web 三个服务

> 详细交付说明见 `docs/PRIVATE-HOSTING.md`。

---

## 常用命令

```powershell
# 重置数据库（⚠️ 会删除所有数据）
pnpm db:reset:sqlite

# 重新生成 Prisma Client（修改 schema 后执行）
pnpm db:generate

# 运行测试
pnpm test
```

---

## 常见问题

**Q: 启动 API 时报 `ECONNREFUSED 127.0.0.1:6379`**  
A: Redis 未运行。请参考上方「环境准备 → Redis」章节启动 Redis。

**Q: Worker 报错 `AdsPower API unreachable`**  
A: AdsPower 客户端未启动，或 `ADSPOWER_API_KEY` 未填写。先启动 AdsPower 桌面客户端。

**Q: 登录提示「邮箱或密码错误」**  
A: 确认已执行 `pnpm db:seed`，使用 `admin@gfa.local` / `admin123` 登录。
