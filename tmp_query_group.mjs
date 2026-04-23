import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const familyGroupId = 'cmnfczubb003dxkb0zwtr0dc5';
  const timeLimit = new Date('2026-04-06T15:50:00.000Z');
  
  const members = await prisma.familyMember.findMany({
    where: { familyGroupId }
  });
  
  const tasks = await prisma.task.findMany({
    where: { 
      familyGroupId,
      updatedAt: { gte: timeLimit }
    },
    include: { logs: true }
  });

  fs.writeFileSync('tmp_group_details.json', JSON.stringify({ members, tasks }, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
