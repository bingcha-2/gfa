import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'remote-data');
const prisma = new PrismaClient();

function readJSON(f) {
  const p = path.join(dataDir, f);
  if (!fs.existsSync(p)) { console.error('❌ 文件不存在:', p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  console.log('🚀 开始导入...\n');

  const accounts = readJSON('accounts.json');
  const familyGroups = readJSON('family-groups.json');

  // 清空旧数据（按依赖顺序）
  console.log('🗑️  清空旧数据...');
  await prisma.familyInvite.deleteMany();
  await prisma.familyMember.deleteMany();
  await prisma.familyGroup.deleteMany();
  await prisma.account.deleteMany();
  console.log('  ✅ 旧数据已清空\n');

  // 导入母号
  console.log(`📦 导入母号: ${accounts.length} 条`);
  let accOk = 0;
  for (const a of accounts) {
    try {
      await prisma.account.create({
        data: {
          id: a.id,
          name: a.name,
          loginEmail: a.loginEmail,
          loginPassword: a.loginPassword ?? null,
          totpSecret: a.totpSecret ?? null,
          recoveryEmail: a.recoveryEmail ?? null,
          appPassword: a.appPassword ?? null,
          adspowerProfileId: a.adspowerProfileId,
          status: a.status ?? 'HEALTHY',
          syncError: a.syncError ?? null,
          riskScore: a.riskScore ?? 0,
          dailyOperationCount: a.dailyOperationCount ?? 0,
          dailyOperationLimit: a.dailyOperationLimit ?? 20,
          lastOperationDate: a.lastOperationDate ?? null,
          notes: a.notes ?? null,
          lastLoginAt: a.lastLoginAt ? new Date(a.lastLoginAt) : null,
          lastHealthCheckAt: a.lastHealthCheckAt ? new Date(a.lastHealthCheckAt) : null,
          subscriptionExpiresAt: a.subscriptionExpiresAt ? new Date(a.subscriptionExpiresAt) : null,
          subscriptionStatus: a.subscriptionStatus ?? null,
          subscriptionStatusUpdatedAt: a.subscriptionStatusUpdatedAt ? new Date(a.subscriptionStatusUpdatedAt) : null,
          subscriptionPlan: a.subscriptionPlan ?? null,
          lastAutoMaintenanceAt: a.lastAutoMaintenanceAt ? new Date(a.lastAutoMaintenanceAt) : null,
        },
      });
      accOk++;
    } catch (e) {
      console.error(`  ❌ ${a.loginEmail}: ${e.message}`);
    }
  }
  console.log(`  ✅ ${accOk}/${accounts.length}\n`);

  // 导入家庭组
  console.log(`📦 导入家庭组: ${familyGroups.length} 条`);
  let fgOk = 0;
  for (const g of familyGroups) {
    try {
      await prisma.familyGroup.create({
        data: {
          id: g.id,
          accountId: g.accountId,
          groupName: g.groupName,
          maxMembers: g.maxMembers ?? 6,
          memberCount: g.memberCount ?? 0,
          availableSlots: g.availableSlots ?? 0,
          pendingInviteCount: g.pendingInviteCount ?? 0,
          yearlyChangeCount: g.yearlyChangeCount ?? 0,
          yearlyChangeLimit: g.yearlyChangeLimit ?? 6,
          status: g.status ?? 'ACTIVE',
          riskScore: g.riskScore ?? 0,
          lastSyncedAt: g.lastSyncedAt ? new Date(g.lastSyncedAt) : null,
        },
      });
      fgOk++;
    } catch (e) {
      console.error(`  ❌ ${g.groupName}: ${e.message}`);
    }
  }
  console.log(`  ✅ ${fgOk}/${familyGroups.length}\n`);

  // 统计
  const stats = {
    accounts: await prisma.account.count(),
    familyGroups: await prisma.familyGroup.count(),
    members: await prisma.familyMember.count(),
  };
  console.log('=========================================');
  console.log('📊 导入完成！');
  console.log(`   母号:     ${stats.accounts}`);
  console.log(`   家庭组:   ${stats.familyGroups}`);
  console.log(`   成员:     ${stats.members} (需要单独拉取)`);
  console.log('=========================================');
}

main().catch(e => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
