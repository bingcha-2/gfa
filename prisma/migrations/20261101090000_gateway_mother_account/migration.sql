-- CreateTable
CREATE TABLE "GatewayMotherAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountName" TEXT NOT NULL,
    "upstreamId" TEXT,
    "requestId" TEXT NOT NULL,
    "keyCipher" TEXT,
    "keyHint" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "usageJson" TEXT,
    "usageSyncedAt" DATETIME,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewayMotherAccount_accountName_key" ON "GatewayMotherAccount"("accountName");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayMotherAccount_requestId_key" ON "GatewayMotherAccount"("requestId");
