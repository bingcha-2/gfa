const fs = require('fs');
const filePath = 'apps/gfa-extension/bundled-rosetta/employee-auto-import/index.js';
let code = fs.readFileSync(filePath, 'utf8');

// Fix all broken atomicType lines:
// "await atomicType(page, X, Y);); } else throw e; }" => "await atomicType(page, X, Y);"
code = code.replace(/await atomicType\(([^)]+)\);\);\s*\}\s*else\s*throw\s*e;\s*\}/g, 'await atomicType($1);');

fs.writeFileSync(filePath, code);

// Verify
const lines = code.split('\n');
let count = 0;
lines.forEach((l, i) => {
  if (l.includes('atomicType') && !l.includes('function atomicType')) {
    count++;
    console.log((i+1) + ': ' + l.trim());
  }
});
console.log(`\nFixed ${count} atomicType call sites.`);
