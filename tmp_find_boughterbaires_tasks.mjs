import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const targetEmail = 'boughterbaires@gmail.com';

async function main() {
  const results = {};

  results.Tasks = await prisma.task.findMany({
    where: {
      payload: {
        contains: targetEmail
      }
    }
  });

  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
