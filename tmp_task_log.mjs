import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
const prisma = new PrismaClient();

const taskId = 'cmnfxhykg001axkng57aivxiw';

const task = await prisma.task.findUnique({
  where: { id: taskId },
  select: {
    id: true,
    type: true,
    status: true,
    lastErrorCode: true,
    lastErrorMessage: true,
    updatedAt: true
  }
});

writeFileSync('tmp_task_output.txt', JSON.stringify(task, null, 2), 'utf8');
console.log('Done');
await prisma.$disconnect();
