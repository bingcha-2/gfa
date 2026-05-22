const fs = require('fs');
let code = fs.readFileSync('apps/gfa-extension/bundled-rosetta/employee-auto-import/index.js', 'utf8');

const catchBlock = ` catch(e) { if(e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) { emit({ type: "progress", message: "页面跳转，忽略交互错误" }); } else throw e; }`;

code = code.replace(/await ([a-zA-Z0-9_]+Input|retryInput|retryEmail)\.type\(([^)]+)\);/g, 'try { await $1.type($2); }' + catchBlock);
code = code.replace(/await ([a-zA-Z0-9_]+Input|retryInput)\.click\(([^)]+)\);/g, 'try { await $1.click($2); }' + catchBlock);
code = code.replace(/await page\.keyboard\.press\(([^)]+)\);/g, 'try { await page.keyboard.press($1); } catch(e) {}');

fs.writeFileSync('apps/gfa-extension/bundled-rosetta/employee-auto-import/index.js', code);
console.log('Patched inputs');
