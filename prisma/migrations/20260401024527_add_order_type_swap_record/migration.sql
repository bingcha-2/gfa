-- AlterTable
ALTER TABLE "Account" ADD COLUMN "subscriptionPlan" TEXT;

-- CreateTable
CREATE TABLE "TransferBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceGroupId" TEXT NOT NULL,
    "targetGroupId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'REMOVING',
    "memberEmails" TEXT NOT NULL,
    "totalMembers" INTEGER NOT NULL,
    "removedCount" INTEGER NOT NULL DEFAULT 0,
    "removeFailedCount" INTEGER NOT NULL DEFAULT 0,
    "invitedCount" INTEGER NOT NULL DEFAULT 0,
    "inviteFailedCount" INTEGER NOT NULL DEFAULT 0,
    "errorDetail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TransferBatch_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "FamilyGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferBatch_targetGroupId_fkey" FOREIGN KEY ("targetGroupId") REFERENCES "FamilyGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SwapRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "oldEmail" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SwapRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNo" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'JOIN',
    "redeemCodeId" TEXT,
    "userEmail" TEXT NOT NULL,
    "familyGroupId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "resultMessage" TEXT,
    "assignedAt" DATETIME,
    "expiresAt" DATETIME,
    "expiredAt" DATETIME,
    "swapCount" INTEGER NOT NULL DEFAULT 0,
    "lastSwapAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_redeemCodeId_fkey" FOREIGN KEY ("redeemCodeId") REFERENCES "RedeemCode" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_familyGroupId_fkey" FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("assignedAt", "createdAt", "expiredAt", "expiresAt", "familyGroupId", "id", "orderNo", "redeemCodeId", "resultMessage", "status", "updatedAt", "userEmail") SELECT "assignedAt", "createdAt", "expiredAt", "expiresAt", "familyGroupId", "id", "orderNo", "redeemCodeId", "resultMessage", "status", "updatedAt", "userEmail" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_orderNo_key" ON "Order"("orderNo");
CREATE UNIQUE INDEX "Order_redeemCodeId_key" ON "Order"("redeemCodeId");
CREATE INDEX "Order_userEmail_idx" ON "Order"("userEmail");
CREATE TABLE "new_RedeemCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "product" TEXT NOT NULL DEFAULT 'GOOGLE_ONE',
    "codeType" TEXT NOT NULL DEFAULT 'JOIN_GROUP',
    "usesAllowed" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "expiresAt" DATETIME,
    "usedAt" DATETIME,
    "validDays" INTEGER,
    "swapLimit" INTEGER NOT NULL DEFAULT 0,
    "swapWindowHours" INTEGER NOT NULL DEFAULT 5,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_RedeemCode" ("code", "codeType", "createdAt", "createdById", "expiresAt", "id", "product", "status", "updatedAt", "usedAt", "usesAllowed") SELECT "code", "codeType", "createdAt", "createdById", "expiresAt", "id", "product", "status", "updatedAt", "usedAt", "usesAllowed" FROM "RedeemCode";
DROP TABLE "RedeemCode";
ALTER TABLE "new_RedeemCode" RENAME TO "RedeemCode";
CREATE UNIQUE INDEX "RedeemCode_code_key" ON "RedeemCode"("code");
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "familyGroupId" TEXT,
    "accountId" TEXT,
    "workerId" TEXT,
    "transferBatchId" TEXT,
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
INSERT INTO "new_Task" ("accountId", "afterScreenshotPath", "beforeScreenshotPath", "createdAt", "errorScreenshotPath", "familyGroupId", "finishedAt", "id", "lastErrorCode", "lastErrorMessage", "maxRetryCount", "orderId", "payload", "priority", "retryCount", "startedAt", "status", "type", "updatedAt", "workerId") SELECT "accountId", "afterScreenshotPath", "beforeScreenshotPath", "createdAt", "errorScreenshotPath", "familyGroupId", "finishedAt", "id", "lastErrorCode", "lastErrorMessage", "maxRetryCount", "orderId", "payload", "priority", "retryCount", "startedAt", "status", "type", "updatedAt", "workerId" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SwapRecord_orderId_idx" ON "SwapRecord"("orderId");
