import fs from 'fs';
const h1 = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\1.html', 'utf8');
const h2 = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\2.html', 'utf8');

function dump(h) {
  const ids = ["105936892050488486754", "115941690162555882273", "8348647433419558945", "-5132322204943513891"];
  for (const id of ids) {
    const idx = h.indexOf(`family/member/g/${id}`) !== -1 ? h.indexOf(`family/member/g/${id}`) : h.indexOf(`family/member/i/${id}`);
    if (idx !== -1) {
       console.log(`\n=== ID ${id} ===`);
       // Get parent container (approx by tags)
       let s = h.substring(idx-300, idx+600);
       // Strip tags and dump text
       const text = s.replace(/<[^>]+>/g, '\n').split('\n').map(x=>x.trim()).filter(x=>x.length>0).join(' | ');
       console.log(text);
    }
  }
}

console.log('--- 1.html ---');
dump(h1);
console.log('\n--- 2.html ---');
dump(h2);
