const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const taskIds = ["cmoefsb59001", "cmoefsdlc001", "cmoefsi5h001", "cmoefsiax001"];
  
  // Try exact match first
  let tasks = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    select: {
      id: true,
      type: true,
      status: true,
      payload: true,
      familyGroupId: true,
      accountId: true,
      source: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      lastErrorMessage: true,
    },
  });

  // If not found by exact ID, try startsWith
  if (tasks.length === 0) {
    tasks = await prisma.task.findMany({
      where: {
        OR: taskIds.map((id) => ({ id: { startsWith: id } })),
      },
      select: {
        id: true,
        type: true,
        status: true,
        payload: true,
        familyGroupId: true,
        accountId: true,
        source: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        lastErrorMessage: true,
      },
    });
  }

  if (tasks.length === 0) {
    // Try contains
    for (const id of taskIds) {
      const t = await prisma.task.findMany({
        where: { id: { contains: id } },
        select: {
          id: true, type: true, status: true, payload: true,
          familyGroupId: true, accountId: true, source: true,
          createdAt: true,
        },
        take: 1,
      });
      if (t.length > 0) tasks.push(...t);
    }
  }

  console.log(`Found ${tasks.length} tasks\n`);
  for (const t of tasks) {
    console.log(`=== Task ${t.id} ===`);
    console.log(`  type: ${t.type}`);
    console.log(`  status: ${t.status}`);
    console.log(`  source: ${t.source ?? "null"}`);
    console.log(`  familyGroupId: ${t.familyGroupId}`);
    console.log(`  accountId: ${t.accountId}`);
    console.log(`  createdAt: ${t.createdAt.toISOString()}`);
    console.log(`  startedAt: ${t.startedAt?.toISOString() ?? "null"}`);
    console.log(`  finishedAt: ${t.finishedAt?.toISOString() ?? "null"}`);
    console.log(`  payload: ${t.payload}`);
    if (t.lastErrorMessage) console.log(`  lastError: ${t.lastErrorMessage}`);
    console.log();
  }

  // Check if payloads are identical
  if (tasks.length > 1) {
    const payloads = tasks.map((t) => t.payload);
    const allSame = payloads.every((p) => p === payloads[0]);
    console.log(`All payloads identical: ${allSame}`);
    if (allSame) {
      console.log(`Payload: ${payloads[0]}`);
    }
    
    // Check time gaps
    const sorted = tasks.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    console.log("\nTime gaps:");
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].createdAt.getTime() - sorted[i-1].createdAt.getTime();
      console.log(`  ${sorted[i-1].id} → ${sorted[i].id}: ${gap}ms (${(gap/1000).toFixed(1)}s)`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
