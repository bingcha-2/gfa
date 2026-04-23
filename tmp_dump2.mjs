import fs from 'fs';
const h1 = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\1.html', 'utf8');
const h2 = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\2.html', 'utf8');

let out = '';
function dump(h) {
  const ids = ["105936892050488486754", "115941690162555882273", "8348647433419558945", "-5132322204943513891"];
  for (const id of ids) {
    const idx = h.indexOf(`family/member/g/${id}`) !== -1 ? h.indexOf(`family/member/g/${id}`) : h.indexOf(`family/member/i/${id}`);
    if (idx !== -1) {
       out += `\n=== ID ${id} ===\n`;
       let s = h.substring(idx-600, idx+600);
       const text = s.replace(/<[^>]+>/g, '\n').split('\n').map(x=>x.trim()).filter(x=>x.length>0).join(' | ');
       out += text + '\n';
    }
  }
}

out += '-- 1.html --\n'; dump(h1);
out += '\n-- 2.html --\n'; dump(h2);

fs.writeFileSync('tmp_result.txt', out);
