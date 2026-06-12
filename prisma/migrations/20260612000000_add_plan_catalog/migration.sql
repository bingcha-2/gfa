-- CreateTable
CREATE TABLE "PlanCatalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "config" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanCatalog_version_key" ON "PlanCatalog"("version");

-- CreateIndex
CREATE INDEX "PlanCatalog_status_idx" ON "PlanCatalog"("status");
