import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany({
    where: { status: "RISKY" },
  });
  console.log("Risky accounts:", accounts.map(a => ({ email: a.loginEmail, status: a.status, syncError: a.syncError })));
  const groups = await prisma.familyGroup.findMany({
    where: { account: { syncError: { not: null } } },
    include: { account: { select: { syncError: true } } },
  });
  console.log("Groups with syncError account:", groups.map(g => ({ id: g.id, groupName: g.groupName, syncError: g.account?.syncError, lastSyncedAt: g.lastSyncedAt })));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
