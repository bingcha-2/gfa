-- 封号定因:新增 AccountBanEvent(每次封号一行)+ BanEventRequest(封号前请求时间线)。
-- 两表都有界:AccountBanEvent 行数=封号次数(罕见);BanEventRequest=封号次数×N(内存环 dump)。
-- 仅 codex/anthropic 写入。保留由后续 cron 处理。DDL 由 schema 对齐生成。

-- CreateTable
CREATE TABLE "AccountBanEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "accountEmail" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "upstreamStatus" INTEGER NOT NULL DEFAULT 0,
    "upstreamBody" TEXT NOT NULL DEFAULT '',
    "modelKey" TEXT NOT NULL DEFAULT '',
    "deathStrikes" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "BanEventRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "banEventId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" DATETIME NOT NULL,
    "accessKeyId" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT NOT NULL DEFAULT '',
    "modelKey" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "reverseProxy" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "BanEventRequest_banEventId_fkey" FOREIGN KEY ("banEventId") REFERENCES "AccountBanEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AccountBanEvent_provider_createdAt_idx" ON "AccountBanEvent"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "AccountBanEvent_accountEmail_idx" ON "AccountBanEvent"("accountEmail");

-- CreateIndex
CREATE INDEX "BanEventRequest_banEventId_idx" ON "BanEventRequest"("banEventId");
