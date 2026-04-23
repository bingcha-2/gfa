import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();

const tasks = await p.$queryRawUnsafe(
  `SELECT id, type, status, retryCount, maxRetryCount, lastErrorCode, lastErrorMessage, startedAt, finishedAt, createdAt, accountId, familyGroupId, orderId, source FROM Task WHERE id LIKE ? LIMIT 5`,
  'cmnjsi93o00k%'
);

const task = tasks[0];
if (!task) { console.log('Task not found'); await p.$disconnect(); process.exit(0); }

const logs = await p.$queryRawUnsafe(
  `SELECT createdAt, level, message FROM TaskLog WHERE taskId = ? ORDER BY createdAt ASC`,
  task.id
);

let accountInfo = null;
let groupInfo = null;
let orderInfo = null;

if (task.accountId) {
  const accs = await p.$queryRawUnsafe(`SELECT loginEmail, status FROM Account WHERE id = ?`, task.accountId);
  accountInfo = accs[0];
}
if (task.familyGroupId) {
  const fgs = await p.$queryRawUnsafe(`SELECT id, groupName, status, availableSlots, memberCount FROM FamilyGroup WHERE id = ?`, task.familyGroupId);
  groupInfo = fgs[0];
}
if (task.orderId) {
  const ords = await p.$queryRawUnsafe(`SELECT id, orderNo, status, userEmail, resultMessage FROM "Order" WHERE id = ?`, task.orderId);
  orderInfo = ords[0];
}

const output = { task, account: accountInfo, familyGroup: groupInfo, order: orderInfo, logs };
writeFileSync('tmp_task_cmnjsi_result.json', JSON.stringify(output, null, 2), 'utf8');
console.log('Done. Task type:', task.type, 'Status:', task.status, 'Logs:', logs.length);
await p.$disconnect();
