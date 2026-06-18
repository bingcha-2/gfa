-- fair-share 重构(fraction-share + T_i 分段累加,见 src/leasing/QUOTA-REDESIGN.md)。
-- 1) 删除已退役的 QuotaProfile(学习上游预算的反推档案,新模型只信上游 fraction)。
-- 2) FairShareWindow 改列:删 estimatedBudget/confidence(已退役),加 attributedShare(T_i)
--    + lockedDenominator(窗口锁定分母 D)。其余列(含已用量/低水位)原样保留并迁移。
-- 手写迁移(dev.db 由旧 db push 管理、与迁移历史有 drift,migrate dev 会要求 reset 丢数据,
-- 故不走自动生成;SQL 严格对齐 schema.prisma 与既有迁移风格)。

-- DropTable
PRAGMA foreign_keys=OFF;
DROP TABLE "QuotaProfile";
PRAGMA foreign_keys=ON;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FairShareWindow" (
    "provider" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "windowStart" BIGINT NOT NULL,
    "weightedUsed" REAL NOT NULL DEFAULT 0,
    "attributedShare" REAL NOT NULL DEFAULT 0,
    "lockedDenominator" REAL NOT NULL DEFAULT 0,
    "lastFraction" REAL NOT NULL DEFAULT 1,
    "isParticipant" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("provider", "accountId", "bucket", "cardId")
);
INSERT INTO "new_FairShareWindow" ("accountId", "bucket", "cardId", "lastFraction", "provider", "updatedAt", "weightedUsed", "windowStart") SELECT "accountId", "bucket", "cardId", "lastFraction", "provider", "updatedAt", "weightedUsed", "windowStart" FROM "FairShareWindow";
DROP TABLE "FairShareWindow";
ALTER TABLE "new_FairShareWindow" RENAME TO "FairShareWindow";
CREATE INDEX "FairShareWindow_provider_accountId_bucket_idx" ON "FairShareWindow"("provider", "accountId", "bucket");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
