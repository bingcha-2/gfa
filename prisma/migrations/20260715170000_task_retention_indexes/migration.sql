CREATE INDEX "TaskLog_taskId_createdAt_idx"
ON "TaskLog"("taskId", "createdAt");

CREATE INDEX "Task_status_finishedAt_idx"
ON "Task"("status", "finishedAt");
