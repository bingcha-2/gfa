import fs from 'fs';

const html = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\3.html', 'utf8');

// We want to find substrings that have a GAIA ID (long number) and an email address in close proximity.
const emailRegex = /"([^"]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"/g;
let match;
const map = new Map();

while ((match = emailRegex.exec(html)) !== null) {
  const email = match[1].toLowerCase();
  const idx = match.index;
  // Look backwards for a 15-25 digit number enclosed in quotes
  const chunk = html.substring(Math.max(0, idx - 400), idx);
  // Match a string of digits, optionally with a minus sign (for pending ids)
  const gaiaMatch = Array.from(chunk.matchAll(/"(-?\d{15,25})"/g));
  if (gaiaMatch && gaiaMatch.length > 0) {
    // The closest one is the last one in the chunk
    const gaia = gaiaMatch[gaiaMatch.length - 1][1];
    if (!map.has(email)) {
      map.set(email, gaia);
    }
  }
}

console.log('Extracted mapping:');
for (const [email, gaia] of map.entries()) {
  console.log(`${email} => ${gaia}`);
}
