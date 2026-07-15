-- Serves the receipt pruner's `provider = ? AND createdAt < ?` range delete.
--
-- QuotaReportReceipt_createdAt_idx stays. The usage-stats diagnostics query
-- filters createdAt without constraining provider, so this composite cannot
-- serve it: skip-scan would need ANALYZE statistics this database never
-- collects, leaving that query a full table scan.
CREATE INDEX "QuotaReportReceipt_provider_createdAt_idx"
ON "QuotaReportReceipt"("provider", "createdAt");
