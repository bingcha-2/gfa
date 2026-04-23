const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const tasks = await p.task.findMany({
    where: { type: 'PHONE_VERIFY' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      status: true,
      lastErrorMessage: true,
      createdAt: true,
      updatedAt: true,
      payload: true,
      retryCount: true,
    },
  });

  console.log(`=== Recent PHONE_VERIFY tasks (${tasks.length}) ===\n`);
  for (const t of tasks) {
    let email = '?';
    try {
      const payload = JSON.parse(t.payload || '{}');
      email = payload.email || payload.accountEmail || payload.userEmail || '?';
    } catch {}
    const time = t.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    const err = (t.lastErrorMessage || '').slice(0, 200);
    console.log(`[${time}] ${t.status.padEnd(18)} retry=${t.retryCount ?? 0}  ${email}`);
    if (err) console.log(`  ERROR: ${err}`);
  }

  // Break down: how many failed vs succeeded, and what errors
  const stats = {};
  for (const t of tasks) {
    stats[t.status] = (stats[t.status] || 0) + 1;
  }
  console.log('\n=== Status breakdown ===');
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`);
  }

  // Analyze failed tasks - what's the common reason?
  const failReasons = {};
  for (const t of tasks) {
    if (t.status !== 'SUCCESS') {
      const reason = t.lastErrorMessage ? t.lastErrorMessage.split('—')[0].trim().slice(0, 80) : 'unknown';
      failReasons[reason] = (failReasons[reason] || 0) + 1;
    }
  }
  console.log('\n=== Failure reason breakdown ===');
  for (const [k, v] of Object.entries(failReasons)) {
    console.log(`  ${v}x: ${k}`);
  }

  // Check the FAILED_RETRYABLE -> SUCCESS pattern (retry chains)
  // Find accounts that have multiple tasks
  const emailTasks = {};
  for (const t of tasks) {
    let email = '?';
    try { email = JSON.parse(t.payload || '{}').email || '?'; } catch {}
    if (!emailTasks[email]) emailTasks[email] = [];
    emailTasks[email].push(t);
  }
  
  console.log('\n=== Accounts with multiple tasks (retries) ===');
  for (const [email, ts] of Object.entries(emailTasks)) {
    if (ts.length > 1) {
      console.log(`  ${email}:`);
      for (const t of ts.reverse()) {
        const time = t.createdAt.toISOString().slice(0, 16).replace('T', ' ');
        console.log(`    [${time}] ${t.status}  err=${(t.lastErrorMessage || '-').slice(0, 100)}`);
      }
    }
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
