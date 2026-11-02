-- AlterTable
ALTER TABLE "GatewayMotherAccount" ADD COLUMN "baseUrl" TEXT NOT NULL DEFAULT 'https://pool.tk4me.com';
ALTER TABLE "GatewayMotherAccount" ADD COLUMN "totalShares" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "GatewayMotherAccount" ADD COLUMN "modelsJson" TEXT;
ALTER TABLE "GatewayMotherAccount" ADD COLUMN "modelsSyncedAt" DATETIME;
ALTER TABLE "GatewayMotherAccount" ADD COLUMN "upstreamResetAt7d" BIGINT;

-- CreateTable
CREATE TABLE "GatewayUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "motherAccountId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL DEFAULT 1,
    "keyHash" TEXT NOT NULL,
    "keyCipher" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usedUsd" REAL NOT NULL DEFAULT 0,
    "periodStartedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalUsedUsd" REAL NOT NULL DEFAULT 0,
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GatewayUser_motherAccountId_fkey" FOREIGN KEY ("motherAccountId") REFERENCES "GatewayMotherAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GatewayUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "gatewayUserId" TEXT NOT NULL,
    "motherAccountId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite5m" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite1h" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 200,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GatewayUsage_gatewayUserId_fkey" FOREIGN KEY ("gatewayUserId") REFERENCES "GatewayUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewayUser_customerId_key" ON "GatewayUser"("customerId");
CREATE UNIQUE INDEX "GatewayUser_keyHash_key" ON "GatewayUser"("keyHash");
CREATE INDEX "GatewayUser_motherAccountId_idx" ON "GatewayUser"("motherAccountId");
CREATE UNIQUE INDEX "GatewayUsage_requestId_key" ON "GatewayUsage"("requestId");
CREATE INDEX "GatewayUsage_gatewayUserId_createdAt_idx" ON "GatewayUsage"("gatewayUserId", "createdAt");
CREATE INDEX "GatewayUsage_motherAccountId_createdAt_idx" ON "GatewayUsage"("motherAccountId", "createdAt");
