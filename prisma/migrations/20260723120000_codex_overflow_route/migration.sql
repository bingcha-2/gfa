CREATE TABLE "CodexOverflowRoute" (
    "subscriptionId" TEXT NOT NULL PRIMARY KEY,
    "homeAccountId" INTEGER NOT NULL,
    "servingAccountId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "reservedUsd" REAL NOT NULL,
    "sourceResetAt" DATETIME,
    "servingResetAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "CodexOverflowRoute_servingAccountId_status_expiresAt_idx"
ON "CodexOverflowRoute"("servingAccountId", "status", "expiresAt");

CREATE INDEX "CodexOverflowRoute_homeAccountId_status_expiresAt_idx"
ON "CodexOverflowRoute"("homeAccountId", "status", "expiresAt");
