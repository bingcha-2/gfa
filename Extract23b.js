const fs = require('fs');
['2.html', '3.html'].forEach(filename => {
  try {
    const p = 'C:/Users/Administrator/Desktop/' + filename;
    let c = fs.readFileSync(p, 'utf8');
    const matches = [...c.matchAll(/.{0,100}galdamezwicinsky\@gmail\.com.{0,100}/gi)];
    console.log(filename + ' EXPLICIT matches:', matches.length);
    matches.forEach(m => console.log(m[0].replace(/\r?\n/g, ' ')));
  } catch(e) { console.error(e); }
});
