# Google Family Automation

Google One Family 自动化管理系统，提供成员邀请、到期移除、账号换绑等全流程自动化。

---

## 系统架构

```
公开页（客户使用）          管理后台（运营使用）
──────────────────         ──────────────────────
/redeem    兑换码激活        /console/login  登录
/status    订单进度查询      /console        控制台（账号、订单、任务管理）
/swap      账号换绑申请
```

| App | 说明 |
|-----|------|
| `apps/web` | 控制台 & 公开兑换/状态页 (Next.js) |
| `apps/api` | 业务 API、队列编排、持久层 (NestJS) |
| `apps/worker` | AdsPower + Playwright 自动化 Worker |
| `packages/shared` | 共享枚举、队列名称、任务类型 |

**技术栈**: Next.js · NestJS · SQLite · Prisma · Redis · BullMQ · AdsPower · Playwright

---

## 快速上手（TL;DR）

> 适用于已安装 Node.js ≥ 18、pnpm 和 Redis 的开发者。

```powershell
git clone <repo-url>
cd google-family-automation
Copy-Item .env.example .env        # 必填：ADSPOWER_API_KEY、JWT_SECRET
pnpm dev:setup                     # 一键：安装依赖 → 编译 shared → 初始化 DB
pnpm dev                           # 启动所有服务
```

> ⚠️ **`JWT_SECRET` 必须设置（32位以上随机字符串），否则 API 拒绝启动。**

访问 http://localhost:3000/console/login，使用 `admin@gfa.local` / `admin123` 登录。

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

## 源码开发模式启动

### 第一步：克隆项目

```powershell
git clone <repo-url>
cd google-family-automation
```

### 第二步：配置 `.env` 文件

```powershell
Copy-Item .env.example .env
```

用文本编辑器打开 `.env`，按下方说明填写：

```dotenv
# ── 基础配置 ──────────────────────────────────────────────────────────────
DATABASE_URL="file:./dev.db"          # SQLite 路径，无需修改
REDIS_URL="redis://localhost:6379"    # Redis 地址
WEB_PORT="3000"                       # Web 控制台端口
API_PORT="3001"                       # API 端口
WORKER_NAME="worker-1"                # Worker 实例名称
API_BASE_URL="http://127.0.0.1:3001/api"

# ── AdsPower ──────────────────────────────────────────────────────────────
ADSPOWER_HOST="http://127.0.0.1:50325"
ADSPOWER_POOL_IDS="profile-id-1,profile-id-2"  # AdsPower 浏览器池 Profile ID

# ⚠️ 必填：在 AdsPower → 设置 → API Key 中获取
ADSPOWER_API_KEY="your_adspower_api_key_here"

# ── 安全配置（生产必改）───────────────────────────────────────────────────
# ⚠️ 必填，留空则 API 启动失败。生成命令：
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET="REPLACE_WITH_A_STRONG_RANDOM_SECRET_AT_LEAST_32_CHARS"

# CORS 允许的前端来源，留空则拒绝所有跨域（开发: http://localhost:3000）
CORS_ALLOWED_ORIGINS="http://localhost:3000"

# 管理后台 URL 前缀。生产改为随机字符串可隐藏登录入口，防自动化扫描。
# 生成：node -e "console.log(require('crypto').randomBytes(5).toString('hex'))"
ADMIN_PATH_PREFIX="console"

# 允许访问后台的 IP，逗号分隔（留空则不限制，适合动态 IP 场景）
ADMIN_IP_ALLOWLIST=""

# Session Cookie HTTPS 强制（生产 HTTPS 部署改为 true）
CONSOLE_COOKIE_SECURE=""
```

> **开发环境必填**：`ADSPOWER_API_KEY` + `JWT_SECRET`。其余字段保持默认值即可启动。

### 第三步：一键初始化（首次必须）

```powershell
pnpm dev:setup
```

此命令会依次完成：

1. 安装所有 npm 依赖（`pnpm install`）
2. 编译共享包 `@gfa/shared`（⚠️ 必须先于 API/Worker 构建）
3. 生成 Prisma Client（`pnpm db:generate`）
4. 创建并同步 SQLite 数据库（`pnpm db:init:sqlite`）
5. 写入默认账号（`pnpm db:seed`）

> ⚠️ **跳过此步骤直接启动，会报 `Cannot find module '@gfa/shared'` 错误。**

### 第四步：启动所有服务

**方式 A：单命令并行启动（推荐）**

```powershell
pnpm dev
```

**方式 B：分终端启动（调试推荐）**

打开四个 PowerShell 窗口，**按顺序**执行：

```powershell
# 窗口 1 - 监听共享包变更（先启动）
pnpm dev:shared

# 窗口 2 - API 服务
pnpm dev:api

# 窗口 3 - Worker 自动化
pnpm dev:worker

# 窗口 4 - Web 控制台
pnpm dev:web
```

### 第五步：访问控制台

| 地址 | 说明 |
|------|------|
| http://localhost:3000/console/login | 管理员登录（若自定义前缀请替换 `console`） |
| http://localhost:3000/ | 公开兑换/状态页（客户使用） |
| http://localhost:3001/api/health | API 健康检查 |

---

## 默认登录账号

数据库初始化（`pnpm db:seed`）后会自动创建以下账号：

| 邮箱 | 密码 | 角色 |
|------|------|------|
| `admin@gfa.local` | `admin123` | ADMIN（完全权限） |
| `support@gfa.local` | `admin123` | SUPPORT（只读/客服） |

> ⚠️ **生产部署前必须完成以下各项：**
> 1. 生成并设置 `JWT_SECRET`（≥32位随机字符串）
> 2. 设置 `CORS_ALLOWED_ORIGINS` 为实际管理域名
> 3. 将 `ADMIN_PATH_PREFIX` 改为随机字符串（隐藏登录入口）
> 4. 可选：配置 `ADMIN_IP_ALLOWLIST` 为运营 IP（双重防护）
> 5. 登录后立即修改默认密码

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
2. 弹出配置向导填写 AdsPower API Key 和 JWT Secret
3. 安装依赖（`pnpm install`）
4. 构建生产包（`pnpm build`，包含 shared 包）
5. 启动 Redis（Docker 方式）
6. 初始化并 seed 数据库
7. 后台运行 API / Worker / Web 三个服务

> 详细交付说明见 `docs/PRIVATE-HOSTING.md`。

---

## 更新到最新版本

```powershell
git pull origin master   # 拉取最新代码
pnpm install             # 安装/更新依赖（不会清除数据库）
pnpm dev                 # 启动服务
```

> ✅ 无需任何数据库迁移操作，直接启动即可。

---

## 常用命令

```powershell
# 首次初始化（clone 后必须执行一次）
pnpm dev:setup

# 启动所有服务（开发模式）
pnpm dev

# 构建生产包
pnpm build

# 重置数据库（⚠️ 会删除所有数据）
pnpm db:reset:sqlite

# 重新生成 Prisma Client（修改 schema 后执行，不影响数据）
pnpm db:generate

# 运行测试
pnpm test
```

---

## 常见问题

**Q: 启动 API 或 Worker 报 `Cannot find module '@gfa/shared'`**  
A: 共享包未编译。执行 `pnpm dev:setup`（首次初始化）或 `pnpm --filter @gfa/shared build` 单独重新编译。

**Q: 启动 API 时报 `ECONNREFUSED 127.0.0.1:6379`**  
A: Redis 未运行。请参考上方「环境准备 → Redis」章节启动 Redis。

**Q: Worker 报错 `AdsPower API unreachable`**  
A: AdsPower 客户端未启动，或 `ADSPOWER_API_KEY` 未填写。先启动 AdsPower 桌面客户端。

**Q: 登录提示「邮箱或密码错误」**  
A: 确认已执行 `pnpm dev:setup` 或 `pnpm db:seed`，使用 `admin@gfa.local` / `admin123` 登录。

**Q: 访问 `/console/login` 返回 404**  
A: 已配置了自定义 `ADMIN_PATH_PREFIX`。请使用 `http://localhost:3000/{你的前缀}/login` 访问。

**Q: `pnpm dev:setup` 卡在安装依赖很久**  
A: 检查网络连接。若在国内，可配置 npm 镜像：
```powershell
pnpm config set registry https://registry.npmmirror.com
```

**Q: 启动 API 时报 `[FATAL] JWT_SECRET is not set`**  
A: `.env` 中 `JWT_SECRET` 未配置或使用了示例占位值。运行以下命令生成并填入：
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Q: `pnpm db:generate` 会清空数据库数据吗？**  
A: **不会**。该命令只重新生成 Prisma Client 类型代码，完全不操作数据库文件。能清空数据的是 `pnpm db:reset:sqlite`。

---

## 运营操作手册

账号导入、AdsPower Profile 绑定、订单管理、人工干预等详细操作，请参阅：

📖 [docs/OPERATIONS.md](./docs/OPERATIONS.md)
