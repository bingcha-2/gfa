ALTER TABLE "GatewayUser" ADD COLUMN "quotaResetAt" DATETIME;
ALTER TABLE "GatewayMotherAccount" ADD COLUMN "upstreamResetAt5h" BIGINT;
ALTER TABLE "GatewayUsage" ADD COLUMN "subscriptionId" TEXT;
ALTER TABLE "GatewayUsage" ADD COLUMN "occurredAt" DATETIME;
UPDATE "GatewayUsage" SET "occurredAt" = "createdAt" WHERE "occurredAt" IS NULL;
CREATE INDEX "GatewayUsage_gatewayUserId_subscriptionId_occurredAt_idx" ON "GatewayUsage"("gatewayUserId", "subscriptionId", "occurredAt");
