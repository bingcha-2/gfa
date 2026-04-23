import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const searchTerm = 'shootingstar';

  // Search accounts by email containing the term
  const allAccounts = await prisma.account.findMany({ include: { familyGroups: true } });
  const matchingAccounts = allAccounts.filter(a => a.loginEmail.toLowerCase().includes(searchTerm.toLowerCase()));

  let out = '';
  out += `Searching for accounts containing "${searchTerm}"...\n`;
  out += `Found ${matchingAccounts.length} matching accounts.\n\n`;

  for (const account of matchingAccounts) {
    out += `=== Account: ${account.loginEmail} ===\n`;
    out += `ID: ${account.id}\n`;
    out += `Name: ${account.name}\n`;
    out += `Status: ${account.status}\n`;
    out += `Created: ${account.createdAt.toISOString()}\n\n`;
  }

  // Also search tasks by payload containing the email
  const tasks = await prisma.task.findMany({
    where: {
      OR: [
        { payload: { contains: 'shootingstar' } },
      ]
    },
    orderBy: { createdAt: 'desc' },
    include: { logs: { orderBy: { createdAt: 'asc' } } }
  });

  out += `=== Tasks with "shootingstar" in payload (${tasks.length}) ===\n\n`;
  for (const t of tasks) {
    out += `--- Task ${t.id} ---\n`;
    out += `Type: ${t.type} | Status: ${t.status}\n`;
    out += `AccountId: ${t.accountId || 'N/A'}\n`;
    out += `Created: ${t.createdAt.toISOString()} | Finished: ${t.finishedAt ? t.finishedAt.toISOString() : 'N/A'}\n`;
    out += `Payload: ${t.payload}\n`;
    out += `Result: ${t.resultMessage || 'N/A'}\n`;
    if (t.lastErrorMessage) out += `Error: ${t.lastErrorMessage}\n`;
    if (t.logs.length > 0) {
      out += `Logs (${t.logs.length}):\n`;
      for (const l of t.logs) {
        out += `  [${l.createdAt.toISOString()}] [${l.level}] ${l.message} ${l.extra || ''}\n`;
      }
    }
    out += '\n';
  }

  // Also search task logs for the email
  const taskLogs = await prisma.taskLog.findMany({
    where: { message: { contains: 'shootingstar' } },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  out += `=== Task Logs mentioning "shootingstar" (${taskLogs.length}) ===\n\n`;
  for (const l of taskLogs) {
    out += `  [${l.createdAt.toISOString()}] TaskID: ${l.taskId} [${l.level}] ${l.message} ${l.extra || ''}\n`;
  }

  fs.writeFileSync('tmp_shootingstar_result.txt', out);
  console.log(out);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
