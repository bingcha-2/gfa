import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const task = await prisma.task.findFirst({
    where: { id: { startsWith: 'cmnis1mpf000' } }
  });

  if (!task) {
    fs.writeFileSync('tmp_task_fail_result.txt', 'Task not found\n');
    return;
  }

  const lines = [];
  lines.push('=== Task Info ===');
  lines.push(`ID: ${task.id}`);
  lines.push(`Type: ${task.type}`);
  lines.push(`Status: ${task.status}`);
  lines.push(`retryCount: ${task.retryCount}`);
  lines.push(`createdAt: ${task.createdAt}`);
  lines.push(`updatedAt: ${task.updatedAt}`);
  lines.push('');
  lines.push('=== failReason ===');
  lines.push(task.failReason || '(无)');
  lines.push('');
  lines.push('=== lastErrorMessage ===');
  lines.push(task.lastErrorMessage || '(无)');

  // 查询任务日志
  const logs = await prisma.taskLog.findMany({
    where: { taskId: task.id },
    orderBy: { createdAt: 'asc' },
  });
  lines.push('');
  lines.push(`=== All Task Logs (${logs.length} total) ===`);
  logs.forEach(l => {
    lines.push(`[${l.createdAt.toISOString()}] [${l.level}] ${l.message}`);
  });

  fs.writeFileSync('tmp_task_fail_result.txt', lines.join('\n'), 'utf8');
  console.log('Done. Written to tmp_task_fail_result.txt');
}

main().finally(() => prisma.$disconnect());
