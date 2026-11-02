ALTER TABLE "GatewayUsage" ADD COLUMN "pricingVersion" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "GatewayUsage" ADD COLUMN "pricingMode" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "QuotaReportReceipt" ADD COLUMN "pricingVersion" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "QuotaReportReceipt" ADD COLUMN "apiValueUsd" REAL NOT NULL DEFAULT 0;
