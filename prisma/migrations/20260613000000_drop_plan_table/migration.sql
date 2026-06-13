-- Drop the legacy Plan table and all plan-based (non-catalog) ordering.
-- Catalog-only launch: PlanCatalog + Subscription.config (JSON) is the single
-- source of truth. The Plan table and the planId-based activation path are dead.
--
-- Changes:
--   * Subscription: drop planId column + its FK to Plan + the planId index;
--     ADD migratedFromKey (provenance for card-migrated subs — catalog purchases
--     leave it null, distinguishing the two now that both have no planId).
--   * PlanOrder: drop planId column + its FK to Plan + the planId index.
--     PlanOrder itself STAYS (catalog orders use it with catalogVersion/selection/config).
--   * DROP the Plan table.
--
-- SQLite cannot DROP a column that participates in a foreign-key relation in
-- place, so Subscription and PlanOrder use the standard table-rebuild pattern.
-- INSERT…SELECT copies every kept column EXCEPT planId (so any rows with a
-- non-null planId are preserved minus that column); migratedFromKey defaults to
-- NULL on the rebuild (no historical card-migration provenance to backfill).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- ── Subscription: rebuild without planId, with migratedFromKey ────────────────
CREATE TABLE "new_Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "activatedFromOrderId" TEXT,
    "migratedFromKey" TEXT,
    "config" TEXT,
    "catalogVersion" INTEGER,
    "productEntitlements" TEXT NOT NULL,
    "bucketLimits" TEXT,
    "bindings" TEXT,
    "levels" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "weeklyTokenLimit" INTEGER,
    "windowMs" INTEGER NOT NULL DEFAULT 18000000,
    "backingKeyValue" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Subscription" ("id", "customerId", "status", "startsAt", "expiresAt", "activatedFromOrderId", "config", "catalogVersion", "productEntitlements", "bucketLimits", "bindings", "levels", "weight", "deviceLimit", "weeklyTokenLimit", "windowMs", "backingKeyValue", "createdAt", "updatedAt")
SELECT "id", "customerId", "status", "startsAt", "expiresAt", "activatedFromOrderId", "config", "catalogVersion", "productEntitlements", "bucketLimits", "bindings", "levels", "weight", "deviceLimit", "weeklyTokenLimit", "windowMs", "backingKeyValue", "createdAt", "updatedAt" FROM "Subscription";
DROP TABLE "Subscription";
ALTER TABLE "new_Subscription" RENAME TO "Subscription";
CREATE UNIQUE INDEX "Subscription_backingKeyValue_key" ON "Subscription"("backingKeyValue");
CREATE INDEX "Subscription_customerId_idx" ON "Subscription"("customerId");
CREATE INDEX "Subscription_activatedFromOrderId_idx" ON "Subscription"("activatedFromOrderId");

-- ── PlanOrder: rebuild without planId (catalog columns retained) ──────────────
CREATE TABLE "new_PlanOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "payChannel" TEXT NOT NULL,
    "outTradeNo" TEXT NOT NULL,
    "epayTradeNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notifyRaw" TEXT,
    "paidAt" DATETIME,
    "referrerId" TEXT,
    "catalogVersion" INTEGER,
    "selection" TEXT,
    "config" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlanOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PlanOrder" ("id", "customerId", "subscriptionId", "amountCents", "payChannel", "outTradeNo", "epayTradeNo", "status", "notifyRaw", "paidAt", "referrerId", "catalogVersion", "selection", "config", "expiresAt", "createdAt", "updatedAt")
SELECT "id", "customerId", "subscriptionId", "amountCents", "payChannel", "outTradeNo", "epayTradeNo", "status", "notifyRaw", "paidAt", "referrerId", "catalogVersion", "selection", "config", "expiresAt", "createdAt", "updatedAt" FROM "PlanOrder";
DROP TABLE "PlanOrder";
ALTER TABLE "new_PlanOrder" RENAME TO "PlanOrder";
CREATE UNIQUE INDEX "PlanOrder_outTradeNo_key" ON "PlanOrder"("outTradeNo");
CREATE INDEX "PlanOrder_customerId_idx" ON "PlanOrder"("customerId");
CREATE INDEX "PlanOrder_status_idx" ON "PlanOrder"("status");

-- ── Drop the Plan table (now unreferenced) ───────────────────────────────────
DROP TABLE "Plan";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
