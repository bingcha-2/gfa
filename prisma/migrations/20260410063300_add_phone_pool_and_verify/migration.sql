-- AlterTable
ALTER TABLE "Account" ADD COLUMN "lastAutoMaintenanceAt" DATETIME;
ALTER TABLE "Account" ADD COLUMN "subscriptionStatusUpdatedAt" DATETIME;
ALTER TABLE "Account" ADD COLUMN "syncError" TEXT;

-- CreateTable
CREATE TABLE "SystemSchedulerConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxAccountsPerRun" INTEGER NOT NULL DEFAULT 10,
    "accountCooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "runWindowStart" TEXT NOT NULL DEFAULT '22:00',
    "runWindowEnd" TEXT NOT NULL DEFAULT '08:00',
    "staleSyncThresholdMinutes" INTEGER NOT NULL DEFAULT 1440,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "removeExpiredMembersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cancelTimedOutInvitesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "deduplicateMembersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inviteTimeoutDays" INTEGER NOT NULL DEFAULT 3,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastRunSummary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PhonePool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phoneNumber" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT '+1',
    "smsUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "lastCode" TEXT,
    "disabledReason" TEXT,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "familyGroupId" TEXT,
    "accountId" TEXT,
    "workerId" TEXT,
    "transferBatchId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetryCount" INTEGER NOT NULL DEFAULT 3,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "beforeScreenshotPath" TEXT,
    "afterScreenshotPath" TEXT,
    "errorScreenshotPath" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_familyGroupId_fkey" FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_transferBatchId_fkey" FOREIGN KEY ("transferBatchId") REFERENCES "TransferBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("accountId", "afterScreenshotPath", "beforeScreenshotPath", "createdAt", "errorScreenshotPath", "familyGroupId", "finishedAt", "id", "lastErrorCode", "lastErrorMessage", "maxRetryCount", "orderId", "payload", "priority", "retryCount", "startedAt", "status", "transferBatchId", "type", "updatedAt", "workerId") SELECT "accountId", "afterScreenshotPath", "beforeScreenshotPath", "createdAt", "errorScreenshotPath", "familyGroupId", "finishedAt", "id", "lastErrorCode", "lastErrorMessage", "maxRetryCount", "orderId", "payload", "priority", "retryCount", "startedAt", "status", "transferBatchId", "type", "updatedAt", "workerId" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_accountId_status_idx" ON "Task"("accountId", "status");
CREATE INDEX "Task_source_status_idx" ON "Task"("source", "status");
CREATE INDEX "Task_familyGroupId_idx" ON "Task"("familyGroupId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PhonePool_phoneNumber_key" ON "PhonePool"("phoneNumber");

-- CreateIndex
CREATE INDEX "PhonePool_status_idx" ON "PhonePool"("status");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "RedeemCode_status_idx" ON "RedeemCode"("status");

-- CreateIndex
CREATE INDEX "RedeemCode_codeType_idx" ON "RedeemCode"("codeType");

