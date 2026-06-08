# 数据库迁移(Prisma Migrate)

本项目已从 `db push`(`init-sqlite.mjs`,diff 当前库→schema 直接改库)切换到**业界最佳实践 Prisma Migrate**:版本化迁移文件入 git,`migrate deploy` 按顺序确定性应用,可 review / 可复现 / 不丢数据。

## 日常工作流

- **改 schema 后(开发)**:`pnpm db:migrate:dev`(= `prisma migrate dev`)
  → 在 `prisma/migrations/<时间戳>_<名字>/` 生成版本化迁移并应用到本地库,同时重生成 client。
- **部署(生产 / 新环境)**:`pnpm db:migrate`(= `prisma migrate deploy`)
  → 按顺序应用所有未应用的迁移。**新建空库会自动从 `0_init` 起建全表。**
- **查看状态**:`pnpm db:migrate:status`
- **生成 client**:`pnpm db:generate`

> `db:init:sqlite` / `db:reset:sqlite`(旧的 `init-sqlite.mjs`)仅作应急保留,**不要再用于常规改库**。

## `0_init` 基线说明

`prisma/migrations/0_init/` 是把**当前完整 schema**(已含 AccountQuotaSnapshot / QuotaProfile / FairShareWindow,已删 CreditConsumption / CreditSnapshot)固化成的基线迁移(`migrate diff --from-empty`)。原先 9 个陈旧迁移(不反映真实 schema、7/9 未应用)已移除,git 历史仍可查。

## ⚠️ 生产库一次性 baseline(切换前必做一次,在服务器执行)

生产库是 `db push` 管理的、已有真实数据,**不能**直接 `migrate deploy`(会因表已存在而失败),需先 baseline:

1. **先备份生产 `dev.db`。**
2. 让生产库 schema 追到最新(本次改动:删 credit 两表 + 建 3 张新表 + CardTokenUsage 索引)。两种方式二选一:
   - 用最后一次旧流程:`pnpm db:init:sqlite`(它 diff 当前库→新 schema 并应用)。
   - 或手工执行本次改动的 DDL。
   完成后生产库 schema 应与 `0_init` 一致。
3. **重置迁移历史并打基线**(只动 `_prisma_migrations` 元数据表,不动业务数据):
   ```sh
   # 清掉旧的迁移记录(若有),再把 0_init 标记为已应用
   sqlite3 <prod.db> "DELETE FROM _prisma_migrations;"   # 仅元数据表
   pnpm prisma migrate resolve --applied 0_init
   ```
4. 验证:`pnpm db:migrate:status` 应显示 `Database schema is up to date!`。
5. 之后把 launcher(`scripts/private-hosting/launcher.ps1`)里调 `db:init:sqlite` 的那行改为 `db:migrate`,生产从此走 `migrate deploy`。

完成后,以后任何 schema 变更都走 `db:migrate:dev`(生成迁移)→ 提交 → 生产 `db:migrate` 应用。
