-- 用量存储重构:逐请求的 CardTokenUsage → 小时聚合 CardUsageHourly。
-- schema 在 a78db12 已切换,但当时只 db push 了 dev、漏了迁移;服务器 migrate deploy 因此
-- 从未建出 CardUsageHourly 表 → bind-card 事务里 tx.cardUsageHourly.updateMany 抛
-- "no such table"(非 P2002,未被 mapDuplicateBind 捕获)→ 500。本迁移补建该表修复 500。
--
-- 注意(有意为之):只 CREATE,不 DROP 旧的 CardTokenUsage —— 保留其历史数据(代码已无人
-- 读它,是死数据但不删)。代价:留一张孤儿表,且 schema 与 DB 有一处已知 drift
-- (`prisma migrate diff` 会显示「DROP CardTokenUsage」待处理)。要彻底清理时再单独出一刀。
-- 建表 SQL 由 `prisma migrate diff` 生成,严格对齐 schema。

-- CreateTable
CREATE TABLE "CardUsageHourly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hourStart" DATETIME NOT NULL,
    "accessKeyId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT NOT NULL DEFAULT '',
    "modelKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "failedRequests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "rawTotalTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CardUsageHourly_hourStart_idx" ON "CardUsageHourly"("hourStart");

-- CreateIndex
CREATE INDEX "CardUsageHourly_accessKeyId_hourStart_idx" ON "CardUsageHourly"("accessKeyId", "hourStart");

-- CreateIndex
CREATE INDEX "CardUsageHourly_customerId_hourStart_idx" ON "CardUsageHourly"("customerId", "hourStart");

-- CreateIndex
CREATE INDEX "CardUsageHourly_accountEmail_hourStart_idx" ON "CardUsageHourly"("accountEmail", "hourStart");

-- CreateIndex
CREATE UNIQUE INDEX "CardUsageHourly_hourStart_accessKeyId_accountEmail_customerId_modelKey_bucket_key" ON "CardUsageHourly"("hourStart", "accessKeyId", "accountEmail", "customerId", "modelKey", "bucket");
