#!/usr/bin/env node
"use strict";
const fs = require("fs");
const filePath = "c:/Users/Administrator/Desktop/GFA/apps/gfa-extension/src/webview/rosettaHandler.ts";
let content = fs.readFileSync(filePath, "utf8");

// Step 1: Add os/path/fs imports after the vscode import
if (!content.includes('import * as os from "os"')) {
  content = content.replace(
    'import * as vscode from "vscode";',
    'import * as vscode from "vscode";\nimport * as os from "os";\nimport * as path from "path";\nimport * as fs from "fs";'
  );
  console.log("Added os/path/fs imports");
}

// Step 2: Replace the log function
// Find the exact block using indexOf
const marker = "// \u2500\u2500\u2500 Logging helper";
const startIdx = content.indexOf(marker);
if (startIdx < 0) {
  console.error("Cannot find Logging helper marker");
  process.exit(1);
}

// Find the end of the log function (closing brace + newline before next section)
const afterMarker = content.substring(startIdx);
// Match pattern: ends with "}\r\n" or "}\n" followed by a blank line
const funcEndMatch = afterMarker.match(/function log\(msg: string\): void \{[\s\S]*?\n\}\s*\n/);
if (!funcEndMatch) {
  console.error("Cannot find end of log function");
  process.exit(1);
}

const endIdx = startIdx + funcEndMatch.index + funcEndMatch[0].length;
console.log(`Found log function at ${startIdx}-${endIdx} (${endIdx - startIdx} chars)`);

const replacement = `// \u2500\u2500\u2500 Logging helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Persistent log file: writes to DATA_DIR/logs/extension.log alongside Output Channel.
const _extensionLogPath: string = (() => {
  const appData = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  const logsDir = path.join(appData, "Antigravity", "rosetta", "logs");
  try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch { /* best effort */ }
  return path.join(logsDir, "extension.log");
})();

function log(msg: string): void {
  const ts = new Date().toISOString();
  // Write to VS Code Output Channel
  if (outputChannel) {
    outputChannel.appendLine(\`[\${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] \${msg}\`);
  }
  // Append to persistent log file (truncate when > 2MB)
  try {
    const line = \`[\${ts}] \${msg}\\n\`;
    try {
      const stat = fs.statSync(_extensionLogPath);
      if (stat.size > 2 * 1024 * 1024) {
        fs.writeFileSync(_extensionLogPath, line, "utf8");
        return;
      }
    } catch { /* file doesn't exist yet, will be created */ }
    fs.appendFileSync(_extensionLogPath, line, "utf8");
  } catch { /* best effort */ }
}

`;

content = content.substring(0, startIdx) + replacement + content.substring(endIdx);
fs.writeFileSync(filePath, content, "utf8");
console.log("SUCCESS: log function replaced with persistent file logging");
