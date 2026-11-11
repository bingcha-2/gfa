-- SQLite requires a table rebuild to change a column default.
PRAGMA foreign_keys=OFF;
BEGIN;

CREATE TABLE "new_GatewayMotherAccount" (
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
    "baseUrl" TEXT NOT NULL DEFAULT 'https://pool1.tk4me.com',
    "totalShares" INTEGER NOT NULL DEFAULT 6,
    "modelsJson" TEXT,
    "modelsSyncedAt" DATETIME,
    "upstreamResetAt5h" BIGINT,
    "upstreamResetAt7d" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_GatewayMotherAccount" (
    "id", "accountName", "upstreamId", "requestId", "keyCipher", "keyHint",
    "enabled", "status", "lastError", "usageJson", "usageSyncedAt", "lastSyncAt",
    "baseUrl", "totalShares", "modelsJson", "modelsSyncedAt", "upstreamResetAt5h",
    "upstreamResetAt7d", "createdAt", "updatedAt"
)
SELECT
    "id", "accountName", "upstreamId", "requestId", "keyCipher", "keyHint",
    "enabled", "status", "lastError", "usageJson", "usageSyncedAt", "lastSyncAt",
    "baseUrl", "totalShares", "modelsJson", "modelsSyncedAt", "upstreamResetAt5h",
    "upstreamResetAt7d", "createdAt", "updatedAt"
FROM "GatewayMotherAccount";

DROP TABLE "GatewayMotherAccount";
ALTER TABLE "new_GatewayMotherAccount" RENAME TO "GatewayMotherAccount";
CREATE UNIQUE INDEX "GatewayMotherAccount_accountName_key" ON "GatewayMotherAccount"("accountName");
CREATE UNIQUE INDEX "GatewayMotherAccount_requestId_key" ON "GatewayMotherAccount"("requestId");

UPDATE "GatewayMotherAccount"
SET "baseUrl" = 'https://pool1.tk4me.com', "modelsSyncedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE rtrim("baseUrl", '/') = 'https://pool.tk4me.com';

UPDATE "SiteSetting"
SET "value" = 'https://pool1.tk4me.com', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'gateway_upstream_base_url' AND rtrim("value", '/') = 'https://pool.tk4me.com';

COMMIT;
PRAGMA foreign_keys=ON;
