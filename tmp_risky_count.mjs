import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const total = await p.account.count({ where: { status: 'RISKY' } });

  const withStuckTasks = await p.account.findMany({
    where: {
      status: 'RISKY',
      familyGroups: {
        some: {
          tasks: {
            some: { status: { in: ['PENDING', 'RUNNING', 'FAILED_RETRYABLE', 'MANUAL_REVIEW'] } }
          }
        }
      }
    },
    select: { loginEmail: true },
  });

  const withStuckOrders = await p.account.findMany({
    where: {
      status: 'RISKY',
      familyGroups: {
        some: {
          orders: {
            some: { status: { in: ['TASK_QUEUED', 'TASK_RUNNING'] } }
          }
        }
      }
    },
    select: { loginEmail: true },
  });

  console.log(`RISKY 主号总数: ${total}`);
  console.log(`有阻塞任务的: ${withStuckTasks.length} → ${withStuckTasks.map(a => a.loginEmail).join(', ')}`);
  console.log(`有卡住订单的: ${withStuckOrders.length} → ${withStuckOrders.map(a => a.loginEmail).join(', ')}`);
}

main().catch(console.error).finally(() => p.$disconnect());
