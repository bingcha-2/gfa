import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const targetEmail = 'DonosoHomeron333@gmail.com';
  const targetEmailLower = targetEmail.toLowerCase();

  // Find the account
  // SQLite doesn't support mode: insensitive, so search by lowercase
  const allAccounts = await prisma.account.findMany({ include: { familyGroups: true } });
  const account = allAccounts.find(a => a.loginEmail.toLowerCase() === targetEmailLower);

  let out = '';

  if (!account) {
    out += `Account ${targetEmail} not found.\n`;
    fs.writeFileSync('tmp_account_log.txt', out);
    return;
  }

  out += `=== Account Info ===\n`;
  out += `ID: ${account.id}\n`;
  out += `Name: ${account.name}\n`;
  out += `Email: ${account.loginEmail}\n`;
  out += `Status: ${account.status}\n`;
  out += `Family Groups: ${account.familyGroups.map(g => g.id + ' (' + g.groupName + ')').join(', ')}\n\n`;

  const familyGroupIds = account.familyGroups.map(g => g.id);
  const familyGroupNames = account.familyGroups.map(g => g.groupName);

  // Get all tasks related to this account or family groups (last 7 days)
  const tasks = await prisma.task.findMany({
    where: {
      OR: [
        { accountId: account.id },
        { familyGroupId: { in: familyGroupIds } }
      ]
    },
    orderBy: { createdAt: 'asc' },
    include: { logs: { orderBy: { createdAt: 'asc' } } }
  });

  out += `=== Tasks (${tasks.length} total) for this account/family groups ===\n\n`;

  for (const t of tasks) {
    out += `--- Task ${t.id} ---\n`;
    out += `Type: ${t.type} | Status: ${t.status}\n`;
    out += `Created: ${t.createdAt.toISOString()} | Finished: ${t.finishedAt ? t.finishedAt.toISOString() : 'N/A'}\n`;
    out += `Payload: ${t.payload}\n`;
    if (t.lastErrorMessage) out += `Error: ${t.lastErrorMessage}\n`;
    if (t.logs.length > 0) {
      out += `Logs (${t.logs.length}):\n`;
      for (const l of t.logs) {
        out += `  [${l.createdAt.toISOString()}] [${l.level}] ${l.message} ${l.extra || ''}\n`;
      }
    }
    out += '\n';
  }

  // Also get all orders related to these family groups
  const orders = await prisma.order.findMany({
    where: { familyGroupId: { in: familyGroupIds } },
    orderBy: { createdAt: 'asc' }
  });

  out += `=== Orders linked to this family group (${orders.length} total) ===\n\n`;
  for (const o of orders) {
    out += `Order: ${o.orderNo} | Type: ${o.orderType} | Status: ${o.status} | User: ${o.userEmail}\n`;
    out += `Created: ${o.createdAt.toISOString()} | Result: ${o.resultMessage || ''}\n\n`;
  }

  // Get current members
  for (const group of account.familyGroups) {
    const members = await prisma.familyMember.findMany({
      where: { familyGroupId: group.id },
      orderBy: { createdAt: 'asc' }
    });
    out += `=== Current Members of ${group.groupName} (DB records) ===\n`;
    for (const m of members) {
      out += `  ${m.email} | role: ${m.role} | status: ${m.status} | canAutoRemove: ${m.canAutoRemove} | joinedAt: ${m.joinedAt}\n`;
    }
    out += '\n';
  }

  fs.writeFileSync('tmp_account_log.txt', out);
  console.log('Done. Written to tmp_account_log.txt');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
