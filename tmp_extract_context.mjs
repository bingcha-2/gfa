import fs from 'fs';

for (const file of ['../1.html', '../2.html']) {
  console.log(`\n\n=== FILE: ${file} ===`);
  try {
    const text = fs.readFileSync(file, 'utf8');
    // We will find occurrences of "family/member/" and print 200 characters before and after to inspect the HTML.
    const rx = /family\/member\/([^\/]+)\/([^\"]+)/g;
    let m;
    while ((m = rx.exec(text))) {
      const start = Math.max(0, m.index - 200);
      const end = Math.min(text.length, m.index + 200);
      console.log(`\n--- MATCH: ${m[1]}/${m[2]} ---`);
      console.log(text.substring(start, end));
    }
  } catch (err) {
    console.log(err.message);
  }
}
