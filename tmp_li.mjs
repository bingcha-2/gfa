import fs from 'fs';

for (const f of ['../1.html', '../2.html']) {
  console.log(`\n\n=== ${f} ===`);
  const html = fs.readFileSync(f, 'utf8');
  // Match all <li> elements and get their plain text
  let m;
  const rx = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((m = rx.exec(html))) {
    let content = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (content) {
      console.log(`- ${content}`);
    }
  }
}
