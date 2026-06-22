-- 激活码改造:卡密 → 激活码。
--   * PayChannel/ActivationCodeStatus 是 Prisma 枚举,在 SQLite 中以 TEXT 存储、不做 DDL 约束,
--     故新增 PayChannel.ACTIVATION_CODE 无需 SQL 变更。
--   * Subscription 增审计回链列 activatedFromActivationCodeId(nullable → 无数据迁移)。
--   * 新增 ActivationCode 表:生成时只是「码 + selection 模板」,激活时对最新目录算价/配置并开通订阅。

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "activatedFromActivationCodeId" TEXT;

-- CreateTable
CREATE TABLE "ActivationCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "activatedAt" DATETIME,
    "activatedByCustomerId" TEXT,
    "subscriptionId" TEXT,
    "name" TEXT,
    "batchId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationCode_code_key" ON "ActivationCode"("code");
CREATE INDEX "ActivationCode_status_idx" ON "ActivationCode"("status");
CREATE INDEX "ActivationCode_batchId_idx" ON "ActivationCode"("batchId");
CREATE INDEX "ActivationCode_activatedByCustomerId_idx" ON "ActivationCode"("activatedByCustomerId");
