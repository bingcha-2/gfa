ALTER TABLE "FairShareWindow" ADD COLUMN "share" REAL NOT NULL DEFAULT 0;
ALTER TABLE "FairShareWindow" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "FairShareWindow" ADD COLUMN "isExclusive" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FairShareWindowHead" (
    "provider" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "stateJson" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'window-cu-v1',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("provider", "accountId", "bucket", "scope")
);

CREATE INDEX "FairShareWindowHead_provider_accountId_bucket_idx"
ON "FairShareWindowHead"("provider", "accountId", "bucket");
