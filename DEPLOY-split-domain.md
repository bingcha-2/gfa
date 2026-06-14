# GFA 分域名部署手册（account-system 分支）

本文档面向在一台全新服务器上部署 GFA「客户账户系统」(`account-system` 分支)的分域名架构。
当前示例域名用 `bcai.space`;**换域名(如 `bcai.lol`)只需全局替换 `bcai.space` → `bcai.lol`**
(共四处:Caddyfile、`.env` 的 `WEB_BASE_URL`/`CORS_ALLOWED_ORIGINS`/host 隔离/EPAY 回调)。

> 现网这台机器仓库在 `D:\gfa`(不是 skill 默认的 `C:\Users\Administrator\Desktop\GFA`)。

---

## 0. 架构总览(分域名)

一个 Next.js 进程(:3000)按 Host 头同时服务 官网/用户中心/控制台 三个面;NestJS(:3001)单独吃机器 API。
Caddy 按子域反代 + 正向白名单隔离,middleware 是第二层(双保险)。

| 子域 | 后端 | 受众 | 路径 |
|------|------|------|------|
| `bcai.space` | Next :3000 | 访客 | 官网 + `/updates/*`(客户端升级源)+ `/api/faq-images/*` |
| `my.bcai.space` | Next :3000 | toC 客户 | `/account/*`、`/api/account/*`、`/api/account-session/*` |
| `console.bcai.space` | Next :3000 | toB 管理员 | `/console/*`、`/login`、`/api/console/*`、`/api/console-session/*` |
| `api.bcai.space` | NestJS :3001 | 桌面客户端 / 支付 | `/api/app/*`、`/api/epay/*`、`/api/health` |

> 桌面客户端的自动升级 feed **永远留在 apex**:`https://bcai.space/updates/latest-wails.json`
> (`apps/app/updater.go` 的 `UpdateCheckURL`)。

---

## 1. 前置环境

### 1.1 工具链 PATH(本机工具链不在默认 PATH,每个新开 shell 先跑)
```powershell
$env:PATH = "D:\nodejs\node-v22.16.0-win-x64;D:\Redis;D:\gh_cli\bin;" + $env:PATH
```
- Node v22.16.0 + pnpm v10.27.0:`D:\nodejs\node-v22.16.0-win-x64`(pnpm store = `D:\pnpm-store`)
- gh CLI:`D:\gh_cli\bin`
- Redis:`D:\Redis`(Windows 端口 5.0.14.1,注册为 Windows 服务 `Redis`)
- Caddy:`D:\caddy.exe`
- Playwright 浏览器:`D:\playwright-browsers`(`.env` 的 `PLAYWRIGHT_BROWSERS_PATH`)

### 1.2 Redis(BullMQ 队列依赖)
RDB 持久化失败会让 worker 所有队列命令报错(`MISCONF ... stop-writes-on-bgsave-error`)。修:
```powershell
# 注释掉 D:\Redis\redis.windows-service.conf 里的 save 行,且每次重启后:
redis-cli CONFIG SET stop-writes-on-bgsave-error no
```

### 1.3 DNS(分域名必须)
为四个子域各加一条 A/AAAA 记录指向本机:`@`(apex)、`my`、`console`、`api`。
`console` 子域建议**不要走 CDN 代理**(否则 IP 白名单看不到真实客户端 IP)。
Caddy 会在每个域名 DNS 生效且 80/443 可达后**自动**各签一张 Let's Encrypt 证书(4 域 = 4 证书)。

### 1.4 防火墙
放行入站,供 ACME 质询到达:
```powershell
# 已添加规则:Caddy HTTP (80) TCP、Caddy HTTPS (443) TCP、Caddy HTTPS UDP (443)
```

---

## 2. 拉代码 + 切分支
```powershell
cd D:\gfa
git fetch --all --prune
git checkout account-system
git pull --ff-only
```
> ⚠️ 切分支前若服务在跑,`prisma\dev.db` 会被锁(`unable to unlink ... Invalid argument`)。
> 先 `pnpm start:stop`,再 `taskkill /F` 掉残留的 node 进程(占用 :3000/:3001 的 + worker),才能切。

---

## 3. 依赖(顺序很重要)

`account-system` 是 monorepo 重构:`apps/server`(NestJS,原 apps/api)、`apps/web`、`apps/worker`、
`apps/app`(Go/Wails,原 apps/bcai-wails)、`packages/shared`(新增共享包)。
**必须先 build `@gfa/shared`,其它包才能编译**(否则报一堆 `Cannot find module '@nestjs/common'` 之类)。
```powershell
cd D:\gfa
pnpm install
pnpm --filter @gfa/shared build
pnpm db:generate            # = prisma generate
```
> install 可能警告 `bcrypt`/`ssh2`/`cpu-features` 构建脚本被忽略。若运行时报 bcrypt 加载失败:
> `pnpm approve-builds` 或 `pnpm rebuild bcrypt`。

---

## 4. 数据库(Prisma Migrate)

本分支从旧的 `db push` 切到 **Prisma Migrate**(版本化迁移,`prisma/migrations/`)。

### 4.1 全新空库
```powershell
pnpm db:migrate            # 自动从 0_init 起建全表
pnpm db:seed
```

### 4.2 从已有(db push 管理的)生产库迁移 ——【一次性 baseline,切前必做】
旧库表已存在,直接 `migrate deploy` 会失败,需先打基线(详见 `prisma/MIGRATIONS.md`):
```powershell
# 1) 先备份!
New-Item -ItemType Directory -Force backups | Out-Null
Copy-Item prisma\dev.db "backups\dev-$(Get-Date -Format yyyyMMdd-HHmmss).db"
# 2) 让旧库 schema 追到最新(最后一次用旧流程)
pnpm db:init:sqlite
# 3) 重置迁移历史并打基线(只动 _prisma_migrations 元数据表,不动业务数据)
#    (用 sqlite3 或等价手段清空 _prisma_migrations 后:)
pnpm prisma migrate resolve --applied 0_init
# 4) 验证
pnpm db:migrate:status     # 应显示 Database schema is up to date!
```
此后常规改库走 `db:migrate:dev`(生成迁移)→ 提交 → 生产 `pnpm db:migrate`。

---

## 5. 配置 `.env`

关键项(完整见仓库 `.env`,`.env.example` 有注释):

| 键 | 说明 |
|----|------|
| `DATABASE_URL` | `file:./dev.db`(相对 `prisma/`) |
| `REDIS_URL` | `redis://localhost:6379` |
| `API_BASE_URL` | **必须** `http://localhost:3001/api`,**切勿**写公网 https(见 §7 坑1) |
| `ROSETTA_DATA_DIR` | Windows 用绝对路径 `D:/gfa/data/rosetta`(api 子进程 cwd≠仓库根) |
| `JWT_SECRET` | 管理端(console)强随机 |
| `CUSTOMER_JWT_SECRET` | **生产必填**,客户端(toC)JWT,≥32 字符,与 `JWT_SECRET` 分开。不设则 server 启动 FATAL 退出。生成:`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `WEB_BASE_URL` | `https://my.bcai.space`(邮件验证/改密链接基址) |
| `NEXT_PUBLIC_ACCOUNT_URL` | `https://my.bcai.space/account`。官网各处「用户中心」按钮目标(`lib/account/portal-url.ts` 的 `ACCOUNT_URL`)。不设则回退相对 `/account` → 被 apex 404。**`NEXT_PUBLIC_*` 构建期内联,改后必须重 build web** |
| `CORS_ALLOWED_ORIGINS` | `https://my.bcai.space,https://console.bcai.space` |
| `MARKETING_HOST`/`ACCOUNT_HOST`/`CONSOLE_HOST` | `bcai.space`/`my.bcai.space`/`console.bcai.space`(middleware 第二层;全空=no-op) |
| `ACCOUNT_COOKIE_DOMAIN`/`CONSOLE_COOKIE_DOMAIN` | 各自子域,**切勿设父域** `.bcai.space` |
| `ADMIN_PATH_PREFIX` | `console`(后台路径前缀) |
| `EPAY_PID`/`EPAY_MERCHANT_PRIVATE_KEY`/`EPAY_PLATFORM_PUBLIC_KEY`/`EPAY_API_BASE` | 易支付(zhunfu)凭据;私钥绝密 |
| `EPAY_NOTIFY_URL` | `https://api.bcai.space/api/epay/notify` |
| `EPAY_RETURN_URL` | `https://my.bcai.space/account/billing` |
| `PLAYWRIGHT_BROWSERS_PATH` | `D:/playwright-browsers` |

> 换域名时这些带域名的值要一起改。`EPAY_*` 密钥留空 = 支付整体关闭(回调 fail-closed 拒绝)。

---

## 6. Caddy

仓库根 `Caddyfile`(由 `Caddyfile.migration` 模板适配而来:四子域 `.space`、updates 根指向 `D:/gfa`)。
```powershell
D:\caddy.exe validate --config D:\gfa\Caddyfile     # 应输出 Valid configuration
D:\caddy.exe start --config D:\gfa\Caddyfile        # 仅在 Caddy 未运行时
# 改完 Caddyfile 后热加载:
D:\caddy.exe reload --config D:\gfa\Caddyfile
```
- 仅在 Caddy 未运行时 `start`;改过 `Caddyfile` 才 `reload`。
- 常规代码更新**不要**动 Caddy。

---

## 7. 启动服务 + 验证
```powershell
cd D:\gfa
pnpm start:stop          # 先停旧的(若有)
pnpm start:daemon        # 重新 build + 启动 API/Worker/Web,并轮询 /api/health
```
检查:
```powershell
netstat -ano | findstr ":3000 :3001"
curl.exe http://127.0.0.1:3001/api/health
Get-Content .\logs\daemon.log -Tail 80
```
对外:`https://bcai.space`(官网)、`https://my.bcai.space/account`(登录)、
`https://console.bcai.space/login`(后台)、`https://api.bcai.space/api/health`。
登录用**邮箱**(非用户名),密码 ≥6 位。

---

## 8. 已知坑(务必看)

1. **`API_BASE_URL` 必须 localhost。** 写成公网 `https://bcai.space/api`,在 TLS 证书签发前 Next SSR
   会 fetch 到非 JSON → 登录 500,症状看起来像"用户数据丢了/界面变了",其实数据没事。
2. **Redis RDB 失败**(`MISCONF stop-writes-on-bgsave-error`)→ worker 队列全废。见 §1.2。
3. **切分支被 `dev.db` 卡住** → 服务/worker 进程锁文件。见 §2。
4. **cookie 域不要设父域** `.bcai.space` → 会跨子域共享 cookie,破坏隔离。
5. **`@gfa/shared` 没 build** → server/web 编译报缺 `@nestjs/*` 等。先 build shared。
6. **官网「用户中心」跳 apex 被 404** → 没设 `NEXT_PUBLIC_ACCOUNT_URL`(回退相对 `/account`)。设成子域绝对地址 **并重 build web**(NEXT_PUBLIC_ 构建期内联,光重启无效)。
7. **Caddy 不是 Windows 服务**:`D:\caddy.exe start` 是游离进程,崩溃或重启机器都不会自动拉起,挂了则整站连不上(443 无监听)。排查:`Get-Process caddy` 为空 + `netstat | findstr :443` 无监听 → `D:\caddy.exe start --config D:\gfa\Caddyfile` 重启。**建议注册成 Windows 服务/加开机自启**以免单点。

---

## 9. 换域名部署(如 bcai.lol)速查

把以下文件里的 `bcai.space` 全部替换为目标域,并重新配 DNS + 防火墙,然后 §6/§7:
- `D:\gfa\Caddyfile`(四个 site 块 + 头部注释)
- `D:\gfa\.env`:`WEB_BASE_URL`、`NEXT_PUBLIC_ACCOUNT_URL`、`CORS_ALLOWED_ORIGINS`、`MARKETING_HOST`/`ACCOUNT_HOST`/`CONSOLE_HOST`、
  `ACCOUNT_COOKIE_DOMAIN`/`CONSOLE_COOKIE_DOMAIN`、`EPAY_NOTIFY_URL`、`EPAY_RETURN_URL`
  (改完 `NEXT_PUBLIC_ACCOUNT_URL` 等 NEXT_PUBLIC_ 变量后**必须重 build web**)
- 桌面客户端升级源(`apps/app/updater.go` 的 `UpdateCheckURL`)若也要换域,需改源码并重新出包。

> 管理后台凭据(本环境):登录邮箱 `admin@gfa.local`(SUPER_ADMIN)等,见旧库数据。
