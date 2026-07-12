ALTER TABLE "RequestLog" ADD COLUMN "reportId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "traceId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "leaseId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "quotaSubjectId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "requestStartedAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "upstreamCompletedAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "snapshotObservedAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "reason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "primaryReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "weeklyReason" TEXT NOT NULL DEFAULT '';

CREATE INDEX "RequestLog_reportId_idx" ON "RequestLog"("reportId");
CREATE INDEX "RequestLog_traceId_idx" ON "RequestLog"("traceId");
CREATE INDEX "RequestLog_leaseId_idx" ON "RequestLog"("leaseId");
