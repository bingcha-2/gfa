import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const p = new PrismaClient();

async function main() {
  const task = await p.task.findFirst({
    where: {
      id: {
        contains: 'cmniuxg07001'
      }
    },
    include: {
      logs: true,
      account: true,
      familyGroup: true,
    }
  });

  writeFileSync('tmp_task_cmniuxg07001_out2.json', JSON.stringify(task, null, 2), 'utf8');
  console.log('Done script');
}

main().catch(console.error).finally(() => p.$disconnect());
