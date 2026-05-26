# GFA 新服务器部署手册（Windows Server）

> 适用于：腾讯云香港 Windows Server 2022

---

## 第一步：安装 Node.js

1. 浏览器打开 https://nodejs.org/zh-cn/download
2. 下载 **Windows Installer (.msi)** → 64-bit LTS 版本（v20.x）
3. 双击安装，一路 Next，**勾上 "Add to PATH"**
4. 验证：

```powershell
node -v    # 应显示 v20.x.x
npm -v     # 应显示 10.x.x
```

---

## 第二步：安装 pnpm

```powershell
npm install -g pnpm
pnpm -v    # 应显示 9.x.x
```

---

## 第三步：安装 Git

1. 浏览器打开 https://git-scm.com/download/win
2. 下载 **64-bit Git for Windows Setup**
3. 双击安装，所有选项保持默认即可
4. 验证：

```powershell
git --version    # 应显示 git version 2.x.x
```

---

## 第四步：安装 Redis

1. 浏览器打开 https://github.com/tporadowski/redis/releases
2. 下载最新的 `Redis-x64-x.x.x.msi`
3. 双击安装，**勾选 "Add the Redis installation folder to the PATH"**
4. 安装完成后 Redis 会自动注册为 Windows 服务并启动
5. 验证：

```powershell
redis-cli ping    # 应返回 PONG
```

> Redis 会开机自启，无需额外配置。

---

## 第五步：安装 AdsPower

1. 从客户已有的安装包安装 AdsPower，或从官网下载
2. 登录客户的 AdsPower 账号
3. 确保 AdsPower 本地 API 已开启（默认端口 50354）
4. 导入或同步客户的浏览器 profiles

---

## 第六步：拉取代码 & 安装依赖

```powershell
# 选择一个工作目录
cd C:\
git clone https://github.com/kledx/GFA.git
cd GFA
pnpm install
```

---

## 第七步：配置环境变量

将旧服务器的 `.env` 文件复制到新服务器的 `C:\GFA\.env`。

需要确认/修改的配置项：

```env
# 数据库（从旧服务器拷贝 dev.db 到同目录）
DATABASE_URL="file:./dev.db"

# Redis（默认本地不用改）
REDIS_URL="redis://localhost:6379"

# AdsPower（确认新机器上的端口和 API Key）
ADSPOWER_HOST="http://127.0.0.1:50354"
ADSPOWER_API_KEY="<客户的 AdsPower API Key>"
ADSPOWER_POOL_IDS=39,40

# JWT 密钥（生产环境务必改成强密码）
JWT_SECRET="<改成随机强密码>"

# ── 域名相关（不配域名就保持默认）──
API_BASE_URL="http://127.0.0.1:3001/api"
CORS_ALLOWED_ORIGINS="http://localhost:3000"
CONSOLE_COOKIE_SECURE=""
ADMIN_IP_ALLOWLIST=""
```

---

## 第八步：迁移数据

从旧服务器复制以下文件到新服务器的对应目录：

| 文件 | 说明 |
|------|------|
| `dev.db` | SQLite 数据库（项目根目录） |
| `.env` | 环境变量配置 |

> AdsPower 的 profiles 通过 AdsPower 客户端本身同步，不需要手动拷贝。

---

## 第九步：首次构建 & 启动

```powershell
cd C:\GFA

# 前台启动（关终端则服务停止）
pnpm start

# 或：后台启动（可关闭终端，服务持续运行）
pnpm start:daemon
```

`pnpm start` 会自动执行 `pnpm build` 然后启动所有服务。

启动成功后会显示：

```
🚀  GFA Production — All Services Ready
  Public Portal             http://localhost:3000/
  Admin Console             http://localhost:3000/console23/login
  API Health                http://localhost:3001/api/health
```

在浏览器打开 `http://localhost:3000/console23/login` 验证能否正常登录。

---

## 第十步：配置域名（可选）

如果需要通过域名访问（如 `https://example.com`）：

### 1. 下载 Caddy

从 https://caddyserver.com/download 下载 Windows 版本，解压到 `C:\caddy\`

### 2. 创建 Caddyfile

在 `C:\caddy\` 下创建文件 `Caddyfile`：

```
example.com {
    # Legacy desktop client path. Keep `/remote-token/*` stable.
    handle /remote-token/* {
        rewrite * /api{uri}
        reverse_proxy localhost:3001
    }

    # Next.js session routes (login/logout via httpOnly cookie)
    handle /api/session/* {
        reverse_proxy localhost:3000
    }

    # NestJS API
    handle /api/* {
        reverse_proxy localhost:3001
    }

    # Everything else → Next.js (pages, static assets)
    handle {
        reverse_proxy localhost:3000
    }
}
```

> ⚠️ **路由顺序很重要**：`/api/session/*` 必须在 `/api/*` 前面，否则登录会 404。

### 3. 启动 Caddy

```powershell
cd C:\caddy
.\caddy.exe start --config Caddyfile
```

### 4. 更新 .env

```env
API_BASE_URL="https://example.com/api"
CORS_ALLOWED_ORIGINS="https://example.com"
CONSOLE_COOKIE_SECURE="true"
```

改完后重启 GFA：`pnpm start`

### 5. DNS 解析

在域名管理后台将域名的 A 记录指向服务器公网 IP。

---

## 日常运维

### 启动 / 停止

```powershell
pnpm start              # 前台启动
pnpm start:daemon       # 后台启动
pnpm start:stop         # 停止后台服务
pnpm start --no-build   # 跳过编译直接启动
```

### 查看日志

```powershell
Get-Content logs\api-2026-03-27.log -Tail 50 -Wait
Get-Content logs\worker-2026-03-27.log -Tail 50 -Wait
Get-Content logs\daemon.log -Tail 50 -Wait    # 后台模式
```

### 更新代码

```powershell
# 先停掉服务
pnpm start:stop        # 或前台 Ctrl+C

git pull origin master
pnpm install           # 如果有新依赖
pnpm start
```

### 修改管理员密码

在管理后台左侧点「修改密码」即可自行修改。

### 检查服务状态

```powershell
redis-cli ping                              # Redis → PONG
curl http://localhost:3001/api/health        # API → OK
```
