#!/usr/bin/env node
"use strict";
const fs = require("fs");
const filePath = "c:/Users/Administrator/Desktop/GFA/apps/gfa-extension/src/webview/rosettaProcess.ts";
let content = fs.readFileSync(filePath, "utf8");

// Step 1: Add os/fs imports (path already imported)
if (!content.includes('import * as os from "os"')) {
  content = content.replace(
    'import * as vscode from "vscode";',
    'import * as vscode from "vscode";\nimport * as os from "os";'
  );
  console.log("Added os import");
}
if (!content.includes('import * as fs from "fs"')) {
  content = content.replace(
    'import * as os from "os";',
    'import * as os from "os";\nimport * as fs from "fs";'
  );
  console.log("Added fs import");
}

// Step 2: Replace procLog function
const marker = "// \u2500\u2500\u2500 Diagnostic logging";
const startIdx = content.indexOf(marker);
if (startIdx < 0) {
  console.error("Cannot find Diagnostic logging marker");
  process.exit(1);
}

const afterMarker = content.substring(startIdx);
const funcEndMatch = afterMarker.match(/function procLog\(msg: string\): void \{[\s\S]*?\n\}\s*\n/);
if (!funcEndMatch) {
  console.error("Cannot find end of procLog function");
  process.exit(1);
}

const endIdx = startIdx + funcEndMatch.index + funcEndMatch[0].length;
console.log(`Found procLog at ${startIdx}-${endIdx} (${endIdx - startIdx} chars)`);

const replacement = `// \u2500\u2500\u2500 Diagnostic logging \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let _outputChannel: any = null;
export function setOutputChannel(ch: any) { _outputChannel = ch; }

// Persistent log file path (same location as rosettaHandler)
const _procLogPath: string = (() => {
  const appData = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  const logsDir = path.join(appData, "Antigravity", "rosetta", "logs");
  try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch { /* best effort */ }
  return path.join(logsDir, "extension.log");
})();

function procLog(msg: string): void {
  const ts = new Date().toISOString();
  if (_outputChannel) {
    _outputChannel.appendLine(\`[\${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] [proc] \${msg}\`);
  }
  // Append to persistent log file (shared with rosettaHandler)
  try {
    const line = \`[\${ts}] [proc] \${msg}\\n\`;
    try {
      const stat = fs.statSync(_procLogPath);
      if (stat.size > 2 * 1024 * 1024) {
        fs.writeFileSync(_procLogPath, line, "utf8");
        return;
      }
    } catch { /* file doesn't exist yet */ }
    fs.appendFileSync(_procLogPath, line, "utf8");
  } catch { /* best effort */ }
}

`;

content = content.substring(0, startIdx) + replacement + content.substring(endIdx);
fs.writeFileSync(filePath, content, "utf8");
console.log("SUCCESS: procLog replaced with persistent file logging");
