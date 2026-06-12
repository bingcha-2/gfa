-- PlanOrder gains the catalog-based purchase path (spec §8):
--   * planId becomes nullable (catalog orders are selection-driven, no Plan row)
--   * catalogVersion / selection / config snapshot the computePurchase result;
--     `config` is what gets written into Subscription.config on activation.
-- SQLite cannot drop a NOT NULL constraint in place, so planId-nullable requires
-- the standard table rebuild. The three new columns are nullable → no data loss.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_PlanOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "planId" TEXT,
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
    CONSTRAINT "PlanOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlanOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PlanOrder" ("id", "customerId", "planId", "subscriptionId", "amountCents", "payChannel", "outTradeNo", "epayTradeNo", "status", "notifyRaw", "paidAt", "referrerId", "expiresAt", "createdAt", "updatedAt")
SELECT "id", "customerId", "planId", "subscriptionId", "amountCents", "payChannel", "outTradeNo", "epayTradeNo", "status", "notifyRaw", "paidAt", "referrerId", "expiresAt", "createdAt", "updatedAt" FROM "PlanOrder";
DROP TABLE "PlanOrder";
ALTER TABLE "new_PlanOrder" RENAME TO "PlanOrder";
CREATE UNIQUE INDEX "PlanOrder_outTradeNo_key" ON "PlanOrder"("outTradeNo");
CREATE INDEX "PlanOrder_customerId_idx" ON "PlanOrder"("customerId");
CREATE INDEX "PlanOrder_planId_idx" ON "PlanOrder"("planId");
CREATE INDEX "PlanOrder_status_idx" ON "PlanOrder"("status");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
