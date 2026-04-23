import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const orderNo = 'GFA-MNG81085-8E9J';
  
  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: {
      tasks: {
        include: {
          logs: true
        }
      },
      swapRecords: true,
      familyGroup: true,
      redeemCode: true
    }
  });

  if (!order) {
    fs.writeFileSync('tmp_order_GFA-MNG81085-8E9J.txt', `Order ${orderNo} not found in database.`);
    return;
  }

  let out = `Querying order ${orderNo}...\n`;
  out += '--- Order Info ---\n';
  out += `ID: ${order.id}\n`;
  out += `Type: ${order.orderType}\n`;
  out += `Status: ${order.status}\n`;
  out += `User Email: ${order.userEmail}\n`;
  out += `Result Message: ${order.resultMessage}\n`;
  out += `Created At: ${order.createdAt}\n`;
  
  out += '\n--- Family Group ---\n';
  if (order.familyGroup) {
      out += `Group Name: ${order.familyGroup.groupName}\n`;
      out += `Group Status: ${order.familyGroup.status}\n`;
  } else {
      out += 'None\n';
  }

  out += `\n--- Tasks (${order.tasks.length}) ---\n`;
  for (const t of order.tasks) {
     out += `\nTask ID: ${t.id} | Type: ${t.type} | Status: ${t.status}\n`;
     out += `Created At: ${t.createdAt} | Finished At: ${t.finishedAt}\n`;
     out += `Error: ${t.lastErrorMessage}\n`;
     out += `Payload: ${t.payload}\n`;
     out += `Logs (${t.logs.length}):\n`;
     for (const l of t.logs) {
        out += `  [${l.createdAt.toISOString()}] [${l.level}] ${l.message} ${l.extra || ''}\n`;
     }
  }

  out += `\n--- Swap Records (${order.swapRecords.length}) ---\n`;
  for (const sr of order.swapRecords) {
     out += `Swap Record ID: ${sr.id} | Status: ${sr.status} | Old: ${sr.oldEmail} -> New: ${sr.newEmail}\n`;
  }

  fs.writeFileSync('tmp_order_GFA-MNG81085-8E9J.txt', out);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
