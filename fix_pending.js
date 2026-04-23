const fs = require('fs');
const file = 'c:\\Users\\Administrator\\Desktop\\GFA\\apps\\web\\src\\components\\group-panel.tsx';
let content = fs.readFileSync(file, 'utf-8');
const lines = content.split('\n');
let fixed = 0;

for (let i = 0; i < lines.length; i++) {
  // Fix the pending badge display (pendingInviteCount -> pendingMemberCount)
  if (lines[i].includes('group.pendingInviteCount') && lines[i].includes('> 0 &&')) {
    lines[i] = lines[i].replace('group.pendingInviteCount', 'group.pendingMemberCount');
    fixed++;
    console.log(`Fixed line ${i+1}: badge condition`);
  }
  // Fix title attr
  if (lines[i].includes('group.pendingInviteCount') && lines[i].includes('个成员待进组')) {
    lines[i] = lines[i].replace('group.pendingInviteCount', 'group.pendingMemberCount').replace('个成员待进组', '个成员同步后待接受');
    fixed++;
    console.log(`Fixed line ${i+1}: title`);
  }
  // Fix badge text
  if (lines[i].includes('group.pendingInviteCount') && lines[i].includes('待进组')) {
    lines[i] = lines[i].replace('group.pendingInviteCount', 'group.pendingMemberCount').replace('待进组', '待接受');
    fixed++;
    console.log(`Fixed line ${i+1}: badge text`);
  }
  // Fix the subtitle line
  if (lines[i].includes('group.pendingInviteCount') && lines[i].includes('invites')) {
    lines[i] = lines[i]
      .replace('group.pendingInviteCount ?? group._count?.invites ?? 0', 'group.pendingMemberCount ?? 0')
      .replace('invites', '待接受');
    fixed++;
    console.log(`Fixed line ${i+1}: subtitle`);
  }
}

content = lines.join('\n');
fs.writeFileSync(file, content, 'utf-8');
console.log(`Done. Fixed ${fixed} lines.`);
