-- Add customerId to CardTokenUsage for account-level usage attribution.
-- Add priority to Subscription for account-internal failover ordering.
--
-- Both are simple nullable/defaulted additions; SQLite supports ALTER TABLE
-- ADD COLUMN for columns with a default or nullable constraint.

-- CardTokenUsage: add customerId (nullable, no default)
ALTER TABLE "CardTokenUsage" ADD COLUMN "customerId" TEXT;

-- CardTokenUsage: add index on (customerId, timestamp) for per-account queries
CREATE INDEX "CardTokenUsage_customerId_timestamp_idx" ON "CardTokenUsage"("customerId", "timestamp");

-- Subscription: add priority (integer, default 0) for failover ordering
ALTER TABLE "Subscription" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
