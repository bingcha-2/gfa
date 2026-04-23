const fs = require('fs');
['2.html', '3.html'].forEach(filename => {
  try {
    const p = 'C:/Users/Administrator/Desktop/' + filename;
    let c = fs.readFileSync(p, 'utf8');
    const matches = [...c.matchAll(/.{0,40}galdamez.{0,40}/gi)];
    console.log(filename + ' matches:', matches.length);
    matches.forEach(m => console.log(m[0].replace(/\r?\n/g, ' ')));
  } catch(e) { console.error(e); }
});
