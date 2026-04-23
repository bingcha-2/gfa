import fs from 'fs';

const html = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\1.html', 'utf8');
const idx = html.indexOf('8348647433419558945');
console.log('Index:', idx);

// Get 2000 chars before and 2000 after
const start = Math.max(0, idx - 2000);
const end = Math.min(html.length, idx + 2000);
console.log('=== CONTEXT (2000 chars each side) ===');
console.log(html.substring(start, end));
