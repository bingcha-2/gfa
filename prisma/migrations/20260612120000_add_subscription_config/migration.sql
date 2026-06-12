-- AlterTable: Subscription gains the de-shadow single-source-of-truth config
-- (JSON string; SQLite has no Json type) and the purchase-time catalog version.
-- Both nullable → plain ADD COLUMN, no table rewrite.
ALTER TABLE "Subscription" ADD COLUMN "config" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "catalogVersion" INTEGER;
