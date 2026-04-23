import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Check what tasks were running/active during the 20-minute window
  // Task was created at 21:45:27 and cancelled at 22:05:59
  const startTime = new Date('2026-04-04T13:44:00.000Z'); // 21:44 UTC+8
  const endTime = new Date('2026-04-04T14:06:00.000Z');   // 22:06 UTC+8

  // Find ALL tasks that overlapped with this window
  // A task overlaps if: createdAt < endTime AND (finishedAt > startTime OR finishedAt IS NULL)
  const overlappingTasks = await prisma.task.findMany({
    where: {
      OR: [
        // Tasks that started and were still running during the window
        {
          startedAt: { lte: endTime },
          OR: [
            { finishedAt: { gte: startTime } },
            { finishedAt: null },
          ]
        },
        // Tasks created during the window (including pending)
        {
          createdAt: { gte: startTime, lte: endTime },
        }
      ]
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      status: true,
      source: true,
      payload: true,
      workerId: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      account: { select: { name: true, loginEmail: true } },
      familyGroup: { select: { groupName: true } },
    }
  });

  console.log(`=== Tasks overlapping with 21:44-22:06 (${overlappingTasks.length} tasks) ===\n`);
  for (const t of overlappingTasks) {
    const duration = t.startedAt && t.finishedAt
      ? `${Math.round((t.finishedAt.getTime() - t.startedAt.getTime()) / 1000)}s`
      : t.startedAt ? 'still running' : 'never started';
    
    console.log(`[${t.id.substring(0, 15)}...]`);
    console.log(`  Type: ${t.type} | Status: ${t.status} | Source: ${t.source}`);
    console.log(`  Account: ${t.account?.name ?? 'N/A'} | Group: ${t.familyGroup?.groupName ?? 'N/A'}`);
    console.log(`  Worker: ${t.workerId ?? 'none'}`);
    console.log(`  Created: ${t.createdAt.toISOString()}`);
    console.log(`  Started: ${t.startedAt?.toISOString() ?? 'null'}`);
    console.log(`  Finished: ${t.finishedAt?.toISOString() ?? 'null'}`);
    console.log(`  Duration: ${duration}`);
    if (t.lastErrorCode) console.log(`  Error: ${t.lastErrorCode} - ${t.lastErrorMessage}`);
    console.log('');
  }
}

main().finally(() => prisma.$disconnect());
