import fs from 'fs';
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const accountLogs = await p.account.findUnique({
  where: { loginEmail: 'zaidchalasani@gmail.com' },
  include: {
    tasks: {
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        logs: { 
          orderBy: { createdAt: 'desc' }, 
          take: 5 
        }
      }
    }
  }
});

fs.writeFileSync('tmp_logs.json', JSON.stringify(accountLogs, null, 2));
await p.$disconnect();
