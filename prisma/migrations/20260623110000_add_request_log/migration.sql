-- per-request 热表 RequestLog(72h 短保留)+ BanEventRequest 增 surface/IP 列。
-- RequestLog 行数靠 TTL 清理控量;封号永久副本仍在 BanEventRequest。仅 codex/anthropic 写。

-- AlterTable: BanEventRequest 增列
ALTER TABLE "BanEventRequest" ADD COLUMN "surface" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BanEventRequest" ADD COLUMN "sourceIp" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BanEventRequest" ADD COLUMN "exitIp" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL DEFAULT 0,
    "accountEmail" TEXT NOT NULL DEFAULT '',
    "accessKeyId" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT NOT NULL DEFAULT '',
    "deviceId" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL DEFAULT '',
    "modelKey" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "reverseProxy" BOOLEAN NOT NULL DEFAULT false,
    "surface" TEXT NOT NULL DEFAULT '',
    "sourceIp" TEXT NOT NULL DEFAULT '',
    "exitIp" TEXT NOT NULL DEFAULT '',
    "headers" TEXT NOT NULL DEFAULT ''
);

-- CreateIndex
CREATE INDEX "RequestLog_at_idx" ON "RequestLog"("at");
CREATE INDEX "RequestLog_accountEmail_at_idx" ON "RequestLog"("accountEmail", "at");
CREATE INDEX "RequestLog_accessKeyId_at_idx" ON "RequestLog"("accessKeyId", "at");
CREATE INDEX "RequestLog_provider_at_idx" ON "RequestLog"("provider", "at");
