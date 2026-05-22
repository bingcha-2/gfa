const fs = require('fs');
const filePath = 'apps/gfa-extension/bundled-rosetta/employee-auto-import/index.js';
let code = fs.readFileSync(filePath, 'utf8');

const atomicTypeFn = `
async function atomicType(page, element, text) {
  try {
    await page.evaluate((el, val) => {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, element, text);
  } catch(e) {
    if(e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) {
      emit({ type: "progress", message: "页面跳转，忽略交互错误" });
    } else throw e;
  }
}
`;

if (!code.includes('function atomicType')) {
  // insert before findButton
  code = code.replace('async function findButton', atomicTypeFn + '\nasync function findButton');
}

// Replace `.type(variable, { delay: 30 })` and others with `atomicType(page, element, variable)`
const lines = code.split('\n');
for (let i = 0; i < lines.length; i++) {
  let line = lines[i];
  if (line.includes('.type(')) {
    // Regex to match: try { await element.type(text, ...); } catch ...
    // or just element.type(text, ...)
    line = line.replace(/try\s*\{\s*await\s+([a-zA-Z0-9_]+)\.type\(([^,]+)(?:,\s*\{[^}]+\})?\);\s*\}\s*catch\s*\([^)]+\)\s*\{[^}]+\}/g, 'await atomicType(page, $1, $2);');
    // If not matched by the try catch block, replace standard ones
    line = line.replace(/await\s+([a-zA-Z0-9_]+)\.type\(([^,]+)(?:,\s*\{[^}]+\})?\)/g, 'await atomicType(page, $1, $2)');
    lines[i] = line;
  }
}

fs.writeFileSync(filePath, lines.join('\n'));
console.log('Successfully patched all .type() calls to atomicType()!');
