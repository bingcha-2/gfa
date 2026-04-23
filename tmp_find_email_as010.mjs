import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';

const prisma = new PrismaClient();
const EMAIL = 'as01054640239@gmail.com';

async function main() {
  const result = {};

  // 1. Find as FamilyMember
  result.members = await prisma.familyMember.findMany({
    where: { email: EMAIL },
    include: {
      familyGroup: {
        select: { id: true, groupName: true, memberCount: true, accountId: true,
          account: { select: { loginEmail: true, name: true } }
        }
      }
    }
  });

  // 2. Find related Orders (by userEmail)
  result.orders = await prisma.order.findMany({
    where: { userEmail: EMAIL },
    include: {
      tasks: { orderBy: { createdAt: 'desc' }, take: 5 },
      redeemCode: { select: { id: true, code: true, codeType: true, status: true } },
      familyGroup: { select: { id: true, groupName: true } }
    }
  });

  // 3. Find related Tasks (by payload containing this email)
  const allTasks = await prisma.task.findMany({
    where: {
      payload: { contains: EMAIL }
    },
    orderBy: { createdAt: 'desc' },
    include: {
      familyGroup: { select: { id: true, groupName: true } },
      account: { select: { loginEmail: true } },
      order: { select: { id: true, orderNo: true, userEmail: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 3 }
    }
  });
  result.tasks = allTasks.map(t => ({
    ...t,
    payload: JSON.parse(t.payload || '{}'),
  }));

  // 4. Find FamilyInvites
  result.invites = await prisma.familyInvite.findMany({
    where: { email: EMAIL },
    include: {
      familyGroup: { select: { id: true, groupName: true } }
    }
  });

  // 5. Find AuditLogs mentioning this email
  result.auditLogs = await prisma.auditLog.findMany({
    where: { detail: { contains: EMAIL } },
    orderBy: { createdAt: 'desc' },
    include: {
      operator: { select: { displayName: true, email: true } }
    }
  });

  // 6. SwapRecords
  result.swapRecords = await prisma.swapRecord.findMany({
    where: { OR: [{ oldEmail: EMAIL }, { newEmail: EMAIL }] },
    include: { order: { select: { orderNo: true, userEmail: true } } }
  });

  writeFileSync('tmp_find_email_as010_result.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log('Done. Check tmp_find_email_as010_result.json');
}

main().catch(console.error).finally(() => prisma.$disconnect());
