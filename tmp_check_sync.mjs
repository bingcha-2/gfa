import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
const p = new PrismaClient();

const out = [];
const log = (msg) => out.push(msg);

// The REMOVE_MEMBER task that ran 
const task = await p.task.findUnique({
  where: { id: 'cmntt32bf001lxkpksuqldn9e' },
  include: {
    order: true,
    familyGroup: true,
    account: { select: { name: true, loginEmail: true } },
    logs: { orderBy: { createdAt: 'asc' } },
  },
});

log('=== REMOVE_MEMBER task details ===');
log(`Type: ${task.type} | Status: ${task.status}`);
log(`Account: ${task.account?.loginEmail}`);
log(`Group: ${task.familyGroup?.groupName}`);
log(`Created: ${task.createdAt.toISOString()}`);
log(`Finished: ${task.finishedAt?.toISOString()}`);
log(`Payload: ${task.payload}`);
log(`Order: ${JSON.stringify(task.order, null, 2)}`);

log('\n=== Task Logs ===');
for (const l of task.logs) {
  log(`[${l.level}] ${l.createdAt.toISOString()} ${l.message}`);
}

writeFileSync('tmp_sync_detail5.txt', out.join('\n'), 'utf8');
console.log('Written to tmp_sync_detail5.txt');
await p.$disconnect();
