import { readFileSync, writeFileSync } from 'fs';

const files = [
  'src/webview/rosettaProcess.ts',
  'src/webview/rosettaHandler.ts',
  'webview-ui/src/components/ultra-swap-flow.tsx',
  'webview-ui/src/components/redeem-form.tsx',
  'webview-ui/src/components/rosetta-panel.tsx',
  'bundled-rosetta/relay-proxy/token-passthrough.js',
];

const replacements = [
  ['一键接管', '本地号池'],
  ['临时续杯', '远程续杯'],
];

for (const file of files) {
  let content = readFileSync(file, 'utf8');
  let changed = false;
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.replaceAll(from, to);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(file, content, 'utf8');
    console.log(`Updated: ${file}`);
  } else {
    console.log(`No changes: ${file}`);
  }
}
