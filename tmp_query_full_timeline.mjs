import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();
const groupId = 'cmnizzub3001fxk8szt8soqt4';

// Get ALL tasks for this group
const allTasks = await p.task.findMany({
  where: { familyGroupId: groupId },
  select: { id: true, type: true, status: true, payload: true },
  orderBy: { createdAt: 'asc' },
});

const output = [];

for (const task of allTasks) {
  let email = '-';
  try { const pl = JSON.parse(task.payload); email = pl.userEmail || pl.memberEmail || '-'; } catch {}

  // Get all logs for this task that are relevant to sync/reconcile
  const logs = await p.taskLog.findMany({
    where: { taskId: task.id },
    select: { createdAt: true, level: true, message: true },
    orderBy: { createdAt: 'asc' },
  });

  // Filter to only sync-related logs
  const syncLogs = logs.filter(l =>
    l.message.includes('Upsert') || l.message.includes('Linking') || 
    l.message.includes('T1 ') || l.message.includes('T2 ') || 
    l.message.includes('T3 ') || l.message.includes('T4 ') ||
    l.message.includes('placeholder') || l.message.includes('gaiaOnly') ||
    l.message.includes('Marked') || l.message.includes('scraped') || 
    l.message.includes('Scrape') || l.message.includes('members from page') ||
    l.message.includes('dedup') || l.message.includes('gaia.unknown') ||
    l.message.includes('slot') || l.message.includes('postTask') ||
    l.message.includes('8348647433419558945')
  );

  if (syncLogs.length > 0) {
    output.push({
      taskId: task.id.slice(0, 12),
      type: task.type,
      status: task.status,
      targetEmail: email,
      syncLogs: syncLogs.map(l => ({
        time: l.createdAt.toISOString().slice(11, 23),
        level: l.level,
        msg: l.message,
      })),
    });
  }
}

writeFileSync('tmp_sync_timeline.json', JSON.stringify(output, null, 2), 'utf8');
console.log(`Tasks with sync logs: ${output.length}`);
await p.$disconnect();
