import fs from 'fs';
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

// Find the user first
const user = await p.user.findFirst({
  where: { email: { contains: 'admin2' } }
});

if (!user) {
  // Try broader search
  const allUsers = await p.user.findMany({ select: { id: true, email: true, displayName: true, role: true } });
  console.log('All users:', JSON.stringify(allUsers, null, 2));
  console.log('No user found matching admin2@gmail.com');
  await p.$disconnect();
  process.exit(0);
}

console.log('Found user:', user.id, user.email, user.displayName);

// Get audit logs for this user today
const logs = await p.auditLog.findMany({
  where: {
    operatorId: user.id,
    createdAt: { gte: todayStart }
  },
  orderBy: { createdAt: 'desc' },
  take: 200
});

const summary = {
  user: { id: user.id, email: user.email, displayName: user.displayName },
  totalActions: logs.length,
  actionBreakdown: {},
  logs: logs.map(l => ({
    action: l.action,
    targetType: l.targetType,
    targetId: l.targetId,
    detail: l.detail,
    createdAt: l.createdAt
  }))
};

for (const l of logs) {
  summary.actionBreakdown[l.action] = (summary.actionBreakdown[l.action] || 0) + 1;
}

fs.writeFileSync('tmp_admin2_audit.json', JSON.stringify(summary, null, 2));
console.log(`Found ${logs.length} audit log entries today. Written to tmp_admin2_audit.json`);
await p.$disconnect();
