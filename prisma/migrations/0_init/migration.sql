-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "loginEmail" TEXT NOT NULL,
    "loginPassword" TEXT,
    "totpSecret" TEXT,
    "recoveryEmail" TEXT,
    "appPassword" TEXT,
    "adspowerProfileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HEALTHY',
    "syncError" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "dailyOperationCount" INTEGER NOT NULL DEFAULT 0,
    "dailyOperationLimit" INTEGER NOT NULL DEFAULT 20,
    "lastOperationDate" TEXT,
    "notes" TEXT,
    "lastLoginAt" DATETIME,
    "lastHealthCheckAt" DATETIME,
    "subscriptionExpiresAt" DATETIME,
    "subscriptionStatus" TEXT,
    "subscriptionStatusUpdatedAt" DATETIME,
    "subscriptionPlan" TEXT,
    "lastAutoMaintenanceAt" DATETIME,
    "refreshToken" TEXT,
    "tokenObtainedAt" DATETIME,
    "tokenStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FamilyGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "maxMembers" INTEGER NOT NULL DEFAULT 6,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "availableSlots" INTEGER NOT NULL DEFAULT 0,
    "pendingInviteCount" INTEGER NOT NULL DEFAULT 0,
    "yearlyChangeCount" INTEGER NOT NULL DEFAULT 0,
    "yearlyChangeLimit" INTEGER NOT NULL DEFAULT 6,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FamilyGroup_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FamilyMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "familyGroupId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "googleMemberId" TEXT,
    "canAutoRemove" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DATETIME,
    "joinedAt" DATETIME,
    "removedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FamilyMember_familyGroupId_fkey" FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FamilyInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "familyGroupId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FamilyInvite_familyGroupId_fkey" FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RedeemCode" (
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

-- CreateTable
CREATE TABLE "Order" (
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

-- CreateTable
CREATE TABLE "Task" (
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

-- CreateTable
CREATE TABLE "TaskLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "extra" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operatorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

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
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "lastCode" TEXT,
    "disabledReason" TEXT,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loginEmail" TEXT NOT NULL,
    "loginPassword" TEXT NOT NULL,
    "totpSecret" TEXT,
    "recoveryEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "refreshToken" TEXT,
    "tokenObtainedAt" DATETIME,
    "familyGroupId" TEXT,
    "uploadedAt" DATETIME,
    "removedAt" DATETIME,
    "lastTaskId" TEXT,
    "notes" TEXT,
    "pool" TEXT NOT NULL DEFAULT 'pending',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "uploadedToPool" DATETIME,
    "motherAccountId" TEXT,
    "motherGroupId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FaqItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SiteSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CardTokenUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accessKeyId" TEXT NOT NULL,
    "accessKeyName" TEXT,
    "accountId" INTEGER,
    "modelKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "rawTotalTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AccountQuotaSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "email" TEXT,
    "modelKey" TEXT NOT NULL,
    "hourlyPercent" REAL,
    "weeklyPercent" REAL,
    "hourlyResetAt" DATETIME,
    "weeklyResetAt" DATETIME,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "QuotaProfile" (
    "provider" TEXT NOT NULL,
    "planType" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "window5h" REAL NOT NULL DEFAULT 0,
    "weekly" REAL NOT NULL DEFAULT 0,
    "samples5h" INTEGER NOT NULL DEFAULT 0,
    "samplesWeekly" INTEGER NOT NULL DEFAULT 0,
    "history5h" TEXT NOT NULL DEFAULT '[]',
    "historyWeekly" TEXT NOT NULL DEFAULT '[]',
    "lastUpdatedAt" BIGINT NOT NULL DEFAULT 0,

    PRIMARY KEY ("provider", "planType", "family")
);

-- CreateTable
CREATE TABLE "FairShareWindow" (
    "provider" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "windowStart" BIGINT NOT NULL,
    "weightedUsed" REAL NOT NULL DEFAULT 0,
    "estimatedBudget" REAL NOT NULL DEFAULT 0,
    "confidence" TEXT NOT NULL DEFAULT 'default',
    "lastFraction" REAL NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("provider", "accountId", "bucket", "cardId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_loginEmail_key" ON "Account"("loginEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Account_adspowerProfileId_key" ON "Account"("adspowerProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyMember_familyGroupId_email_key" ON "FamilyMember"("familyGroupId", "email");

-- CreateIndex
CREATE INDEX "FamilyInvite_familyGroupId_email_idx" ON "FamilyInvite"("familyGroupId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "RedeemCode_code_key" ON "RedeemCode"("code");

-- CreateIndex
CREATE INDEX "RedeemCode_status_idx" ON "RedeemCode"("status");

-- CreateIndex
CREATE INDEX "RedeemCode_codeType_idx" ON "RedeemCode"("codeType");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNo_key" ON "Order"("orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "Order_redeemCodeId_key" ON "Order"("redeemCodeId");

-- CreateIndex
CREATE INDEX "Order_userEmail_idx" ON "Order"("userEmail");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");

-- CreateIndex
CREATE INDEX "Task_accountId_status_idx" ON "Task"("accountId", "status");

-- CreateIndex
CREATE INDEX "Task_source_status_idx" ON "Task"("source", "status");

-- CreateIndex
CREATE INDEX "Task_familyGroupId_idx" ON "Task"("familyGroupId");

-- CreateIndex
CREATE INDEX "SwapRecord_orderId_idx" ON "SwapRecord"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PhonePool_phoneNumber_key" ON "PhonePool"("phoneNumber");

-- CreateIndex
CREATE INDEX "PhonePool_status_idx" ON "PhonePool"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAccount_loginEmail_key" ON "AgentAccount"("loginEmail");

-- CreateIndex
CREATE INDEX "AgentAccount_status_idx" ON "AgentAccount"("status");

-- CreateIndex
CREATE INDEX "AgentAccount_loginEmail_idx" ON "AgentAccount"("loginEmail");

-- CreateIndex
CREATE INDEX "AgentAccount_pool_idx" ON "AgentAccount"("pool");

-- CreateIndex
CREATE INDEX "AgentAccount_pool_banned_idx" ON "AgentAccount"("pool", "banned");

-- CreateIndex
CREATE INDEX "FaqItem_published_sortOrder_idx" ON "FaqItem"("published", "sortOrder");

-- CreateIndex
CREATE INDEX "CardTokenUsage_timestamp_idx" ON "CardTokenUsage"("timestamp");

-- CreateIndex
CREATE INDEX "CardTokenUsage_accessKeyId_timestamp_idx" ON "CardTokenUsage"("accessKeyId", "timestamp");

-- CreateIndex
CREATE INDEX "CardTokenUsage_accessKeyId_modelKey_idx" ON "CardTokenUsage"("accessKeyId", "modelKey");

-- CreateIndex
CREATE INDEX "CardTokenUsage_accountId_timestamp_idx" ON "CardTokenUsage"("accountId", "timestamp");

-- CreateIndex
CREATE INDEX "AccountQuotaSnapshot_provider_accountId_timestamp_idx" ON "AccountQuotaSnapshot"("provider", "accountId", "timestamp");

-- CreateIndex
CREATE INDEX "AccountQuotaSnapshot_timestamp_idx" ON "AccountQuotaSnapshot"("timestamp");

-- CreateIndex
CREATE INDEX "FairShareWindow_provider_accountId_bucket_idx" ON "FairShareWindow"("provider", "accountId", "bucket");

