import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();

// 查询任务本身（包含 orderId 字段）
const task = await p.$queryRaw`
  SELECT id, type, status, orderId, accountId, familyGroupId, payload, createdAt, startedAt, finishedAt, lastErrorCode, lastErrorMessage
  FROM Task WHERE id LIKE ${'cmnjp89np00d%'}
`;

// 查询同一时间段内同一账号的其他任务
const relatedTasks = task[0] ? await p.$queryRaw`
  SELECT id, type, status, orderId, payload, createdAt
  FROM Task 
  WHERE accountId = ${task[0].accountId}
    AND createdAt BETWEEN datetime(${task[0].createdAt}, '-5 minutes') 
                      AND datetime(${task[0].createdAt}, '+5 minutes')
  ORDER BY createdAt ASC
` : [];

// 查询同一时间内相同 userEmail 的所有任务
let emailTasks = [];
if (task[0]?.payload) {
  const payload = JSON.parse(task[0].payload);
  emailTasks = await p.$queryRaw`
    SELECT id, type, status, orderId, payload, createdAt
    FROM Task 
    WHERE payload LIKE ${'%' + payload.userEmail + '%'}
    ORDER BY createdAt DESC
    LIMIT 10
  `;
}

// 查询是否有关联的 Order
let order = null;
if (task[0]?.orderId) {
  const orders = await p.$queryRaw`SELECT * FROM \`Order\` WHERE id = ${task[0].orderId}`;
  order = orders[0];
}

const out = { task: task[0], relatedTasks, emailTasks, order };
writeFileSync('C:/tmp_orderId_investigation.json', JSON.stringify(out, null, 2), 'utf8');
console.log('Task orderId:', task[0]?.orderId);
console.log('Related tasks:', relatedTasks.length);
console.log('Tasks with same email:', emailTasks.length);
emailTasks.forEach(t => {
  const p = JSON.parse(t.payload);
  console.log(`  ${t.id} orderId=${t.orderId} status=${t.status} createdAt=${t.createdAt}`);
});
await p.$disconnect();
