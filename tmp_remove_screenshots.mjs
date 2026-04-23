import fs from 'fs';
import path from 'path';

const dir = 'C:\\Users\\Administrator\\Desktop\\GFA\\apps\\worker\\src\\processors';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

files.forEach(file => {
  const filePath = path.join(dir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  
  const lines = content.split('\n');
  const newLines = lines.filter(line => {
    return !line.includes('.takeScreenshot(') && !line.includes('.recordScreenshot(');
  });
  
  if (lines.length !== newLines.length) {
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
    console.log(`Updated ${file} (removed ${lines.length - newLines.length} lines)`);
  }
});
