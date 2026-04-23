import fs from 'fs';

function analyzeFile(path) {
  const html = fs.readFileSync(path, 'utf8');
  console.log(`\n=== ${path} ===`);
  
  // Find all member links (href containing family/member)
  const memberLinkRegex = /href="[^"]*family\/member[^"]*"/gi;
  let match;
  const hrefs = [];
  while ((match = memberLinkRegex.exec(html)) !== null) {
    hrefs.push(match[0]);
  }
  console.log('\nAll family/member hrefs:');
  hrefs.forEach(h => console.log('  ', h));
  
  // Check for pending member links specifically (/i/ pattern)
  const pendingRegex = /family\/member\/i\/([-\d]+)/gi;
  const pendingIds = [];
  while ((match = pendingRegex.exec(html)) !== null) {
    pendingIds.push(match[1]);
  }
  console.log('\nPending member GAIA IDs (/i/ pattern):');
  pendingIds.forEach(id => console.log('  ', id));
  
  // Check for active member links (/g/ pattern)
  const activeRegex = /family\/member\/g\/([\d]+)/gi;
  const activeIds = [];
  while ((match = activeRegex.exec(html)) !== null) {
    activeIds.push(match[1]);
  }
  console.log('\nActive member GAIA IDs (/g/ pattern):');
  activeIds.forEach(id => console.log('  ', id));
  
  // Look specifically for 8348647433419558945 and its context
  const targetId = '8348647433419558945';
  let idx = html.indexOf(targetId);
  if (idx !== -1) {
    const start = Math.max(0, idx - 500);
    const end = Math.min(html.length, idx + 500);
    const context = html.substring(start, end);
    console.log(`\nContext around ${targetId}:`);
    console.log(context);
  } else {
    // Check for negative version
    const negId = '-' + targetId;
    idx = html.indexOf(negId);
    if (idx !== -1) {
      const start = Math.max(0, idx - 500);
      const end = Math.min(html.length, idx + 500);
      console.log(`\nContext around ${negId}:`);
      console.log(html.substring(start, end));
    } else {
      // try partial
      const partial = targetId.substring(0, 10);
      idx = html.indexOf(partial);
      if (idx !== -1) {
        console.log(`\nPartial match for ${partial} at index ${idx}`);
        console.log(html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + 200)));
      } else {
        console.log(`\n${targetId} NOT directly found in file`);
      }
    }
  }
}

analyzeFile('C:\\Users\\Administrator\\Desktop\\1.html');
analyzeFile('C:\\Users\\Administrator\\Desktop\\2.html');
