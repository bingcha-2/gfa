const fs = require('fs');

try {
  const content = fs.readFileSync('C:\\Users\\Administrator\\Desktop\\5.html', 'utf8');
  
  // Try to find emails
  const emails = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const uniqueEmails = [...new Set(emails)];
  
  console.log('--- Emails found in the file ---');
  uniqueEmails.forEach(e => console.log(e));
  
  if (uniqueEmails.length === 0) {
      console.log('No direct emails found. Let\'s look for encoded JSON data.');
      // Sometimes Google embeds data in AF_initDataCallback
      const matches = content.match(/AF_initDataCallback\(\{.*?data:\[(.*?)]\)/g);
      if (matches) {
          console.log(`Found ${matches.length} initData blocks.`);
          // Let's print out parts that might contain member IDs or names
          const gaiaPattern = /"\d{15,21}"/g;
          const gaiaIds = content.match(gaiaPattern) || [];
          console.log('--- Potential GAIA IDs ---');
          [...new Set(gaiaIds)].forEach(id => console.log(id));
      }
  }
} catch (e) {
  console.error('Error reading file:', e.message);
}
