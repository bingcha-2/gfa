#!/usr/bin/env node
"use strict";
const fs = require("fs");
const filePath = "c:/Users/Administrator/Desktop/GFA/apps/gfa-extension/src/webview/rosettaProcess.ts";
let content = fs.readFileSync(filePath, "utf8");

// ─── Fix 1: restartAntigravityLanguageServer — add Mac/Linux support ───
const oldRestart = `    } else {
      procLog(\`[languageServer] automatic restart is only enabled on Windows\`);
      return;
    }`;

const newRestart = `    } else if (IS_MAC) {
      // macOS: kill language_server_darwin_* processes belonging to Antigravity
      const output = await runShellCommand("/bin/sh", ["-c",
        "pgrep -fl 'language_server_darwin' | grep -i antigravity | awk '{print $1}' | xargs -r kill 2>/dev/null; " +
        "pgrep -fl 'language_server_darwin' | grep -i antigravity | awk '{print $1}' || echo '(none)'"
      ]).catch(() => "(pgrep failed)");
      procLog(\`[languageServer] macOS kill: \${output || "no process found"}\`);
    } else {
      // Linux: similar approach
      const output = await runShellCommand("/bin/sh", ["-c",
        "pgrep -fl 'language_server_linux' | grep -i antigravity | awk '{print $1}' | xargs -r kill 2>/dev/null; " +
        "pgrep -fl 'language_server_linux' | grep -i antigravity | awk '{print $1}' || echo '(none)'"
      ]).catch(() => "(pgrep failed)");
      procLog(\`[languageServer] linux kill: \${output || "no process found"}\`);
    }`;

if (content.includes(oldRestart)) {
  content = content.replace(oldRestart, newRestart);
  console.log("Fix 1: Added Mac/Linux support to restartAntigravityLanguageServer");
} else {
  console.log("Fix 1: SKIPPED - pattern not found");
}

// ─── Fix 2: restartMismatchedAntigravityLanguageServers — add Mac/Linux mismatch detection ───
// Current code only checks IS_WIN. We need to add Mac/Linux detection after the Windows block.
const oldMismatch = `  } catch (err: any) {
    procLog(\`[languageServer] mismatch check failed: \${err?.message || String(err)}\`);
  }
}`;

// Find it in the context of restartMismatchedAntigravityLanguageServers
const mismatchFnStart = content.indexOf("restartMismatchedAntigravityLanguageServers");
const mismatchEnd = content.indexOf(oldMismatch, mismatchFnStart);

if (mismatchEnd > 0) {
  // Insert Mac/Linux mismatch check. We need to find the IS_WIN block and add else-if for Mac.
  // Actually, let's just add Mac/Linux support before the closing catch.

  // Find the `if (IS_WIN) {` inside this function
  const funcBody = content.substring(mismatchFnStart, mismatchEnd + oldMismatch.length);
  const isWinBlock = funcBody.indexOf("if (IS_WIN) {");

  if (isWinBlock > 0) {
    // Find the closing `}` of the IS_WIN block (before the catch)
    // The structure is: try { if (IS_WIN) { ... } } catch { ... }
    // We need to add `else if (IS_MAC)` after the IS_WIN block

    // Find "if (hasIds)" section ending
    const hasIdsEnd = content.indexOf("promptReloadWindow(", mismatchFnStart);
    const afterPrompt = content.indexOf("}", hasIdsEnd) + 1; // close of if (hasIds)
    const afterWinBlock = content.indexOf("}", afterPrompt) + 1; // close of if (IS_WIN)

    // Insert Mac/Linux block after IS_WIN block
    const macLinuxBlock = ` else if (IS_MAC) {
      // macOS: detect language_server_darwin processes with mismatched endpoint
      const macOutput = await runShellCommand("/bin/sh", ["-c",
        "ps -eo pid,command | grep 'language_server_darwin' | grep 'cloud_code_endpoint' | grep -v '${expected.replace(/'/g, "'\\''")}' | grep -v grep | awk '{print $1}' || echo ''"
      ]).catch(() => "");
      procLog(\`[languageServer] macOS mismatch check: \${macOutput || "no mismatched process found"}\`);
      const macHasIds = /\\d/.test(macOutput || "");
      if (macHasIds) {
        procLog(\`[languageServer] macOS mismatched LS detected, prompting reload window\`);
        promptReloadWindow("续杯代理已配置，需要重新加载窗口以使 Language Server 切换到代理端点。");
      }
    }`;

    // Actually this approach is too fragile. Let me just replace the whole function body.
    console.log("Fix 2: Will handle via full function replacement");
  }
}

// Fix 2: Replace the whole restartMismatchedAntigravityLanguageServers function
const oldMismatchFn = `export async function restartMismatchedAntigravityLanguageServers(expectedCloudCodeUrl: string, reason = "cloudCodeUrl changed"): Promise<void> {
  const expected = String(expectedCloudCodeUrl || "").trim();
  if (!expected) return;
  procLog(\`[languageServer] checking endpoint mismatch: expected=\${expected} reason=\${reason}\`);
  try {
    if (IS_WIN) {
      const escapedExpected = expected.replace(/'/g, "''");
      // Check-only: detect mismatched LS processes but do NOT kill them.
      // Killing externally causes Antigravity's renderer to hold stale port refs.
      const script = \`
$ErrorActionPreference = 'SilentlyContinue'
$expected = '\${escapedExpected}'
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'language_server_windows_x64.exe' -and
  $_.CommandLine -like '*--cloud_code_endpoint*' -and
  $_.CommandLine -notlike "*$expected*"
}
$ids = @($procs | ForEach-Object { $_.ProcessId }) | Where-Object { $_ }
"MISMATCHED: $($ids -join ',')"
\`.trim();
      const output = await runPowerShell(script);
      procLog(\`[languageServer] \${output || "no mismatched process found"}\`);

      // If mismatched LS processes exist, prompt user to reload window
      const hasIds = /MISMATCHED:\\s*\\d/.test(output || "");
      if (hasIds) {
        procLog(\`[languageServer] mismatched LS detected, prompting reload window\`);
        promptReloadWindow("续杯代理已配置，需要重新加载窗口以使 Language Server 切换到代理端点。");
      }
    }
  } catch (err: any) {
    procLog(\`[languageServer] mismatch check failed: \${err?.message || String(err)}\`);
  }
}`;

const newMismatchFn = `export async function restartMismatchedAntigravityLanguageServers(expectedCloudCodeUrl: string, reason = "cloudCodeUrl changed"): Promise<void> {
  const expected = String(expectedCloudCodeUrl || "").trim();
  if (!expected) return;
  procLog(\`[languageServer] checking endpoint mismatch: expected=\${expected} reason=\${reason}\`);
  try {
    if (IS_WIN) {
      const escapedExpected = expected.replace(/'/g, "''");
      // Check-only: detect mismatched LS processes but do NOT kill them.
      // Killing externally causes Antigravity's renderer to hold stale port refs.
      const script = \`
$ErrorActionPreference = 'SilentlyContinue'
$expected = '\${escapedExpected}'
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'language_server_windows_x64.exe' -and
  $_.CommandLine -like '*--cloud_code_endpoint*' -and
  $_.CommandLine -notlike "*$expected*"
}
$ids = @($procs | ForEach-Object { $_.ProcessId }) | Where-Object { $_ }
"MISMATCHED: $($ids -join ',')"
\`.trim();
      const output = await runPowerShell(script);
      procLog(\`[languageServer] \${output || "no mismatched process found"}\`);

      // If mismatched LS processes exist, prompt user to reload window
      const hasIds = /MISMATCHED:\\s*\\d/.test(output || "");
      if (hasIds) {
        procLog(\`[languageServer] mismatched LS detected, prompting reload window\`);
        promptReloadWindow("续杯代理已配置，需要重新加载窗口以使 Language Server 切换到代理端点。");
      }
    } else {
      // macOS / Linux: detect mismatched language server processes via ps + grep
      const lsBinary = IS_MAC ? "language_server_darwin" : "language_server_linux";
      const checkOutput = await runShellCommand("/bin/sh", ["-c",
        \`ps -eo pid,command | grep '\${lsBinary}' | grep 'cloud_code_endpoint' | grep -v '\${expected}' | grep -v grep | awk '{print $1}' || echo ''\`
      ]).catch(() => "");
      procLog(\`[languageServer] \${IS_MAC ? "macOS" : "Linux"} mismatch check: \${checkOutput || "no mismatched process found"}\`);
      const hasIds = /\\d/.test(checkOutput || "");
      if (hasIds) {
        procLog(\`[languageServer] mismatched LS detected on \${IS_MAC ? "macOS" : "Linux"}, prompting reload window\`);
        promptReloadWindow("续杯代理已配置，需要重新加载窗口以使 Language Server 切换到代理端点。");
      }
    }
  } catch (err: any) {
    procLog(\`[languageServer] mismatch check failed: \${err?.message || String(err)}\`);
  }
}`;

if (content.includes(oldMismatchFn)) {
  content = content.replace(oldMismatchFn, newMismatchFn);
  console.log("Fix 2: Added Mac/Linux support to restartMismatchedAntigravityLanguageServers");
} else {
  console.log("Fix 2: SKIPPED - exact pattern not found, trying relaxed match...");
  // The issue might be \r\n vs \n. Just check if the key markers are present.
  const hasMarker = content.includes("automatic restart is only enabled on Windows");
  console.log("  Has 'automatic restart' marker:", hasMarker);
}

// Also check if promptReloadWindow exists
if (!content.includes("function promptReloadWindow")) {
  console.log("WARNING: promptReloadWindow function not found, checking if it exists elsewhere...");
  const hasPrompt = content.includes("promptReloadWindow");
  console.log("  promptReloadWindow referenced:", hasPrompt);
}

fs.writeFileSync(filePath, content, "utf8");
console.log("Done. File saved.");
