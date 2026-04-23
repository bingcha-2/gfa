const fs = require('fs');
let out = '';
['2.html', '3.html'].forEach(filename => {
  try {
    const p = 'C:/Users/Administrator/Desktop/' + filename;
    let c = fs.readFileSync(p, 'utf8');
    const matches = [...c.matchAll(/.{0,200}galdamez.{0,200}/gi)];
    out += filename + ' matches: ' + matches.length + '\n';
    matches.forEach(m => out += m[0].replace(/\r?\n/g, ' ') + '\n---\n');
  } catch(e) { out += e + '\n'; }
});
fs.writeFileSync('C:/Users/Administrator/Desktop/ExtractResults.txt', out);
