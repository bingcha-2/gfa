CREATE TABLE "QuotaReportReceipt" (
    "provider" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("provider", "reportId")
);

CREATE INDEX "QuotaReportReceipt_createdAt_idx"
ON "QuotaReportReceipt"("createdAt");
