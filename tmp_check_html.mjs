import fs from 'fs';

function checkFile(path) {
  if (!fs.existsSync(path)) {
    console.log(`${path} does not exist.`);
    return;
  }
  const content = fs.readFileSync(path, 'utf8');
  
  // Extract all emails
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const emails = content.match(emailRegex) || [];
  
  // Also check if the ID 8348647433419558945 or similar is there
  const idRegex = /8348647433419558945/g;
  const hasId = idRegex.test(content);

  console.log(`\n--- Analysis of ${path} ---`);
  console.log(`Has ID 8348647433419558945: ${hasId}`);
  
  // Count distinct emails
  const uniqueEmails = [...new Set(emails)];
  console.log(`Found ${uniqueEmails.length} unique emails:`);
  console.log(uniqueEmails);
}

checkFile('C:\\Users\\Administrator\\Desktop\\1.html');
checkFile('C:\\Users\\Administrator\\Desktop\\2.html');
