import { PrismaClient } from '@prisma/client';
import fs from 'fs';
const prisma = new PrismaClient();

async function main() {
  const codeStr = 'CX-YPR6B4MGF4P416O7';
  const out = {
    code: codeStr,
    redeemCode: null,
    orders: null,
    tasks: [],
    logs: []
  };
  
  try {
    let rCodeId = null;
    out.redeemCode = await prisma.redeemCode.findUnique({
      where: { code: codeStr },
      include: {
        order: {
          include: {
            familyGroup: {
              select: { id: true, groupName: true, account: { select: { loginEmail: true, id: true } } }
            }
          }
        }
      }
    });

    if (out.redeemCode) {
      rCodeId = out.redeemCode.id;
    }

    if (rCodeId) {
      out.orders = await prisma.order.findMany({
        where: { redeemCodeId: rCodeId },
        include: {
          familyGroup: {
            select: { id: true, groupName: true, account: { select: { loginEmail: true } } }
          },
          swapRecords: { orderBy: { createdAt: 'desc' } }
        }
      });

      if (out.orders.length > 0) {
        const orderId = out.orders[0].id;
        out.tasks = await prisma.task.findMany({
          where: { orderId: orderId },
          orderBy: { createdAt: 'desc' },
          take: 20
        });

        out.logs = await prisma.auditLog.findMany({
          where: { targetId: orderId },
          orderBy: { createdAt: 'desc' },
          take: 10
        });
      }
    }
  } catch(e) {
    out.error = e.message;
  }
  
  fs.writeFileSync('tmp_cx_data.json', JSON.stringify(out, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
