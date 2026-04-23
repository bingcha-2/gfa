import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();

const partial = await p.$queryRaw`
  SELECT id, type, status, retryCount, maxRetryCount, payload, 
         lastErrorCode, lastErrorMessage, startedAt, finishedAt, createdAt, 
         accountId, familyGroupId
  FROM Task WHERE id LIKE ${'cmnhja4km%'}
`;

const logs = partial[0] ? await p.$queryRaw`
  SELECT createdAt, level, message, extra 
  FROM TaskLog WHERE taskId = ${partial[0].id} ORDER BY createdAt ASC
` : [];

let accountInfo = null;
let groupInfo = null;
if (partial[0]?.accountId) {
  const accs = await p.$queryRaw`SELECT loginEmail, status FROM Account WHERE id = ${partial[0].accountId}`;
  accountInfo = accs[0];
}
if (partial[0]?.familyGroupId) {
  const fgs = await p.$queryRaw`SELECT groupName, status FROM FamilyGroup WHERE id = ${partial[0].familyGroupId}`;
  groupInfo = fgs[0];
}

const out = {
  task: partial[0],
  account: accountInfo,
  familyGroup: groupInfo,
  logs
};

writeFileSync('/tmp/task_out.json', JSON.stringify(out, null, 2), 'utf8');
console.log('Written to /tmp/task_out.json');
console.log('Log count:', logs.length);
await p.$disconnect();
