import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const config = await p.systemSchedulerConfig.findUnique({ where: { id: 'default' } });
console.log(JSON.stringify(config, null, 2));

await p.$disconnect();
