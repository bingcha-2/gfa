/**
 * Remove accounts without projectId from accounts.json
 * Creates a backup first, then rewrites the file.
 */
const fs = require('fs');
const path = require('path');

const accountsPath = path.join(
  process.env.APPDATA || '',
  'Antigravity', 'rosetta', 'accounts.json'
);

if (!fs.existsSync(accountsPath)) {
  console.error('accounts.json not found at:', accountsPath);
  process.exit(1);
}

// Read current
const raw = fs.readFileSync(accountsPath, 'utf8');
const data = JSON.parse(raw);
const accounts = Array.isArray(data.accounts) ? data.accounts : [];

console.log('Total accounts before:', accounts.length);

// Separate
const withProject = accounts.filter(a => a.projectId && String(a.projectId).trim());
const withoutProject = accounts.filter(a => !a.projectId || !String(a.projectId).trim());

console.log('With projectId (keep):', withProject.length);
console.log('Without projectId (remove):', withoutProject.length);

if (withoutProject.length === 0) {
  console.log('No accounts to remove. Done.');
  process.exit(0);
}

// Show a few being removed
console.log('\nSample accounts being removed:');
for (const a of withoutProject.slice(0, 10)) {
  console.log('  #' + a.id + ' ' + a.email + ' (projectId=' + (a.projectId || 'none') + ')');
}
if (withoutProject.length > 10) {
  console.log('  ... and ' + (withoutProject.length - 10) + ' more');
}

// Backup
const backupPath = accountsPath + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(accountsPath, backupPath);
console.log('\nBackup saved to:', backupPath);

// Write cleaned
data.accounts = withProject;
const tmpPath = accountsPath + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
fs.renameSync(tmpPath, accountsPath);

console.log('\nDone! Accounts after cleanup:', withProject.length);
console.log('Removed:', withoutProject.length, 'accounts without projectId');
