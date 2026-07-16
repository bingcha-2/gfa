export const TASK_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TASK_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

// MANUAL_REVIEW, FAILED_RETRYABLE, and FAILED_FINAL deliberately remain
// available for operator retry/manual completion.
export const TASK_CLEANUP_STATUSES = [
  "SUCCESS",
  "INVITE_SENT",
  "REPLACED_AND_INVITE_SENT",
  "CANCELLED",
] as const;

const STATUS_PLACEHOLDERS = TASK_CLEANUP_STATUSES.map(() => "?").join(", ");

interface RawPrisma {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

export async function pruneTaskLogsBatch(
  prisma: RawPrisma,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  return Number(await prisma.$executeRawUnsafe(
    `DELETE FROM TaskLog WHERE rowid IN (
       SELECT tl.rowid
       FROM TaskLog tl
       JOIN Task t ON t.id = tl.taskId
       WHERE t.status IN (${STATUS_PLACEHOLDERS})
         AND COALESCE(t.finishedAt, t.updatedAt) < ?
       ORDER BY tl.createdAt
       LIMIT ?
     )`,
    ...TASK_CLEANUP_STATUSES,
    cutoff,
    batchSize,
  ));
}

export async function pruneTasksBatch(
  prisma: RawPrisma,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  return Number(await prisma.$executeRawUnsafe(
    `DELETE FROM Task WHERE rowid IN (
       SELECT rowid
       FROM Task
       WHERE status IN (${STATUS_PLACEHOLDERS})
         AND COALESCE(finishedAt, updatedAt) < ?
       ORDER BY COALESCE(finishedAt, updatedAt)
       LIMIT ?
     )`,
    ...TASK_CLEANUP_STATUSES,
    cutoff,
    batchSize,
  ));
}

export async function countTaskRetentionCandidates(
  prisma: RawPrisma,
  now = Date.now(),
): Promise<{ taskLogs: number; tasks: number }> {
  const logCutoff = new Date(now - TASK_LOG_RETENTION_MS);
  const taskCutoff = new Date(now - TASK_RETENTION_MS);
  const values = [...TASK_CLEANUP_STATUSES];
  const [logRows, taskRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count
       FROM TaskLog tl
       JOIN Task t ON t.id = tl.taskId
       WHERE t.status IN (${STATUS_PLACEHOLDERS})
         AND COALESCE(t.finishedAt, t.updatedAt) < ?`,
      ...values,
      logCutoff,
    ),
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count
       FROM Task
       WHERE status IN (${STATUS_PLACEHOLDERS})
         AND COALESCE(finishedAt, updatedAt) < ?`,
      ...values,
      taskCutoff,
    ),
  ]);
  return {
    taskLogs: Number(logRows[0]?.count ?? 0),
    tasks: Number(taskRows[0]?.count ?? 0),
  };
}
