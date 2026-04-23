import fs from 'fs';

for (const file of ['../1.html', '../2.html']) {
  console.log(`\n--- ${file} ---`);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const rx = /href=\\?"\\?(\/?family\/member\/[^\\]+?)\\?"|href="(\/?family\/member\/[^"]+?)"/g;
    let m;
    const matches = new Set();
    while ((m = rx.exec(text))) {
      matches.add(m[1] || m[2]);
    }
    for (const match of matches) {
      console.log(match);
    }
  } catch (err) {
    console.error(err.message);
  }
}
