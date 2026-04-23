import { PrismaClient } from '@prisma/client';
import fs from 'fs';
const prisma = new PrismaClient();

async function main() {
  const id = 'cmnh6avzr004';
  let output = {};
  
  const tables = [
    'Task',
    'Order',
    'Account',
    'FamilyGroup',
    'FamilyMember',
    'SwapRecord',
    'TransferBatch',
  ];

  for (const table of tables) {
    try {
      const result = await prisma[table[0].toLowerCase() + table.slice(1)].findFirst({
        where: { id: { contains: id } }
      });
      if (result) {
        output[table] = result;
      }
    } catch (e) {
      // ignore
    }
  }

  const logs = await prisma.taskLog.findMany({
    where: { taskId: { contains: id } },
    orderBy: { createdAt: 'asc' }
  });
  if (logs.length > 0) {
    output['TaskLogs'] = logs;
  }
  
  fs.writeFileSync('tmp_task_details.json', JSON.stringify(output, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
