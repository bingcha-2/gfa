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

## 生产部署

### 方式 A：`pnpm start`（云服务器推荐）

适用于 Windows 云服务器（腾讯云、阿里云等），**带持久化日志**。

```powershell
# 1. 首次初始化
pnpm dev:setup

# 2. 前台启动（关闭终端则服务停止）
pnpm start

# 3. 后台启动（可关闭终端，服务持续运行）
pnpm start:daemon

# 4. 停止后台服务
pnpm start:stop
```

> 💡 `--no-build` 跳过编译（要求已 build）：`pnpm start --no-build` 或 `pnpm start:daemon -- --no-build`

**特性**：
- 自动编译：首次启动检测到未 build 会自动运行 `pnpm build`
- 持久化日志：输出同时写入终端和 `logs/<服务名>-YYYY-MM-DD.log`
- 按天轮转：日志文件按日期自动分割，带时间戳
- 端口清理：启动前自动释放被占用的端口
- 优雅退出：前台 Ctrl+C / 后台 `pnpm start:stop` 安全停止
- **后台模式**：`start:daemon` 以脱离终端的后台进程运行，日志写入 `logs/daemon.log`，PID 记录在 `gfa.pid`
- **不操作数据库**：直接使用现有 `dev.db`，不会删库或重置

**日志位置**：

```
logs/
├── api-2026-03-27.log       # API 日志
├── web-2026-03-27.log       # Web 日志
├── worker-2026-03-27.log    # Worker 日志
└── daemon.log               # 后台模式综合日志
```

### 方式 B：`Start-GFA.bat`（安装包模式）

适用于通过安装包交付的场景，使用项目根目录下的一键启动脚本：

```
Start-GFA.bat    ← 首次运行会自动完成所有初始化
Stop-GFA.bat     ← 停止所有服务
Status-GFA.bat   ← 查看运行状态
```

> 详细交付说明见 `docs/PRIVATE-HOSTING.md`。

---

## 域名 & HTTPS 配置（可选）

若需要通过域名访问（如 `https://gfa.example.com`），推荐使用 Caddy 反向代理。

### 1. 安装 Caddy

从 [caddyserver.com/download](https://caddyserver.com/download) 下载 Windows amd64 版本，放到 `C:\caddy\caddy.exe`。

### 2. 创建 Caddyfile

新建 `C:\caddy\Caddyfile`：

```caddyfile
your-domain.com {
    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

### 3. 安全组放行端口

在云服务商控制台的安全组入站规则中放行 **TCP 80** 和 **TCP 443**。

### 4. 启动 Caddy

```powershell
# 测试运行
cd C:\caddy
.\caddy.exe run --config Caddyfile

# 注册为 Windows 服务（开机自启）
.\caddy.exe install
.\caddy.exe start
```

### 5. 修改 `.env`

```dotenv
API_BASE_URL="https://your-domain.com/api"
NEXT_PUBLIC_API_BASE_URL="https://your-domain.com/api"
CORS_ALLOWED_ORIGINS="https://your-domain.com"
CONSOLE_COOKIE_SECURE="true"
```

修改后重新 `pnpm start`。

> 💡 Caddy 会自动申请 Let's Encrypt 免费 HTTPS 证书，无需手动配置。

---

## 更新到最新版本

```powershell
git pull origin master   # 拉取最新代码
pnpm install             # 安装/更新依赖（不会清除数据库）
pnpm start               # 重新启动（自动重新构建）
```

> ✅ 无需任何数据库迁移操作，直接启动即可。

---

## 常用命令

```powershell
# 首次初始化（clone 后必须执行一次）
pnpm dev:setup

# 启动所有服务（开发模式，带热更新）
pnpm dev

# 启动所有服务（生产模式，前台运行）
pnpm start

# 启动所有服务（生产模式，后台运行，可关闭终端）
pnpm start:daemon

# 停止后台服务
pnpm start:stop

# 单独构建生产包
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
