-- CreateIndex
CREATE INDEX "Task_source_createdAt_idx" ON "Task"("source", "createdAt");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_type_status_idx" ON "Task"("type", "status");

-- CreateIndex
CREATE INDEX "Task_familyGroupId_idx" ON "Task"("familyGroupId");

-- CreateIndex
CREATE INDEX "Task_accountId_idx" ON "Task"("accountId");

-- CreateIndex
CREATE INDEX "Task_updatedAt_idx" ON "Task"("updatedAt");
