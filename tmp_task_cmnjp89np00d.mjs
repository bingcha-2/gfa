import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();

const partial = await p.$queryRaw`
  SELECT id, type, status, retryCount, maxRetryCount, payload, 
         lastErrorCode, lastErrorMessage, startedAt, finishedAt, createdAt, 
         accountId, familyGroupId
  FROM Task WHERE id LIKE ${'cmnjp89np00d%'}
  LIMIT 5
`;

const task = partial[0];
const logs = task ? await p.$queryRaw`
  SELECT createdAt, level, message, extra 
  FROM TaskLog WHERE taskId = ${task.id} ORDER BY createdAt ASC
` : [];

let accountInfo = null;
let groupInfo = null;
if (task?.accountId) {
  const accs = await p.$queryRaw`SELECT loginEmail, status FROM Account WHERE id = ${task.accountId}`;
  accountInfo = accs[0];
}
if (task?.familyGroupId) {
  const fgs = await p.$queryRaw`SELECT id, groupName, status, availableSlots FROM FamilyGroup WHERE id = ${task.familyGroupId}`;
  groupInfo = fgs[0];
}

const out = { task, account: accountInfo, familyGroup: groupInfo, logs };
writeFileSync('C:/tmp_task_result.json', JSON.stringify(out, null, 2), 'utf8');
console.log('Done. Logs count:', logs.length);
await p.$disconnect();
