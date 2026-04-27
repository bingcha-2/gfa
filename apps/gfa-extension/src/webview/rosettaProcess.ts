/**
 * Rosetta process manager — handles launching/stopping detached Node.js proxy processes.
 * Ported from extension.js: startProxy, stopProxy, port management, process cleanup.
 */

import * as vscode from "vscode";
import * as path from "path";
import { spawn, execFile, execFileSync } from "child_process";
import {
  type RosettaState,
  postJson,
  writeIdeCloudCodeUrl,
  readIdeCloudCodeUrl,
  writeJsonFile,
  updateAccountRecord,
} from "./rosettaState.js";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const DEFAULT_REMOTE_TOKEN_SERVER_URL = "https://bcai.site/remote-token";

function isOldLocalRemoteTokenUrl(value: any): boolean {
  const raw = String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  return raw === "http://127.0.0.1:60700" || raw === "http://localhost:60700";
}

// Relay proxy status port — always independent of the proxy port.
// The relay proxy shares the token proxy port (60670) for actual traffic,
// but keeps a dedicated status port (default: 60681) for health checks.
function getRelayStatusPort(config: any): number {
  const v = Number(config?.tokenProxyPort);
  const tokenProxyPort = Number.isFinite(v) && v > 0 ? v : 60670;
  return tokenProxyPort + 1;
}

// ─── Diagnostic logging ────────────────────────────────────────────────
let _outputChannel: any = null;
export function setOutputChannel(ch: any) { _outputChannel = ch; }
function procLog(msg: string): void {
  if (!_outputChannel) return;
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  _outputChannel.appendLine(`[${ts}] [proc] ${msg}`);
}

function getPlatformString(): string {
  if (IS_WIN) return "WINDOWS_AMD64";
  if (IS_MAC) return "MAC_AMD64";
  return "LINUX_AMD64";
}

function getPlatformUA(): string {
  if (IS_WIN) return "windows/amd64";
  if (IS_MAC) return "darwin/amd64";
  return "linux/amd64";
}

let cachedNodeBinary: string | undefined;

// ─── Node binary resolution ────────────────────────────────────────────

function resolveNodeBinary(): string {
  if (cachedNodeBinary !== undefined) return cachedNodeBinary;

  const candidates: string[] = [];
  if (/node(\.exe)?$/i.test(path.basename(process.execPath || ""))) {
    candidates.push(process.execPath);
  }
  if (process.env.NODE_BINARY) candidates.push(process.env.NODE_BINARY);

  try {
    const whichCmd = IS_WIN ? "where.exe" : "which";
    const output = execFileSync(whichCmd, ["node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    for (const line of output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      candidates.push(line);
    }
  } catch { /* ignore */ }

  candidates.push("node");

  for (const c of candidates) {
    try {
      execFileSync(c, ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      cachedNodeBinary = c;
      return cachedNodeBinary;
    } catch { /* next */ }
  }

  throw new Error("找不到 Node.js，请先安装或把 node 加到 PATH。");
}

function launchDetachedNodeScript(nodeBinary: string, scriptPath: string, cwd: string, env?: Record<string, string>): number | undefined {
  const fs = require("fs");
  // Create a log file to capture stderr for debugging startup failures
  const logDir = path.join(cwd, "..", "..", "..", "logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* */ }
  const errLogPath = path.join(logDir, `detached-${path.basename(scriptPath, ".js")}.log`);
  let stderrFd: number | undefined;
  try { stderrFd = fs.openSync(errLogPath, "a"); } catch { /* */ }

  const child = spawn(nodeBinary, [scriptPath], {
    cwd,
    detached: true,
    stdio: ["ignore", stderrFd != null ? stderrFd : "ignore", stderrFd != null ? stderrFd : "ignore"],
    windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  });
  child.on("error", (err: any) => {
    try { fs.appendFileSync(errLogPath, `[spawn error] ${err.message}\n`); } catch { /* */ }
  });
  child.unref();
  return child.pid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── HTTP helpers ───────────────────────────────────────────────────────

function fetchJson(urlString: string, options: { headers?: Record<string, string> } = {}): Promise<any> {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "GET", headers: options.headers || {} },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`${res.statusCode}`)); return; }
          try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("bad json")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function isProxyRunning(statusUrl: string, requireRunning = true, options: any = {}): Promise<boolean> {
  try {
    const status = await fetchJson(statusUrl, options);
    return requireRunning ? Boolean(status?.running) : true;
  } catch { return false; }
}

async function waitForProxyStatus(statusUrl: string, timeoutMs = 15000, intervalMs = 400, requireRunning = true, options: any = {}): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isProxyRunning(statusUrl, requireRunning, options)) {
      return fetchJson(statusUrl, options).catch(() => ({}));
    }
    await sleep(intervalMs);
  }
  throw new Error("代理没有成功启动。");
}

async function waitForProxyOffline(statusUrl: string, timeoutMs = 8000, intervalMs = 400): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await fetchJson(statusUrl); } catch { return; }
    await sleep(intervalMs);
  }
}

// ─── Cross-platform process management ──────────────────────────────────

function runShellCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || stdout || error.message).trim())); return; }
      resolve(String(stdout || "").trim());
    });
  });
}

function runPowerShell(script: string): Promise<string> {
  return runShellCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

/**
 * Find PIDs listening on a given port.
 * Windows: PowerShell Get-NetTCPConnection
 * Unix: lsof -ti tcp:<port>
 */
async function findPidsByPort(port: number): Promise<number[]> {
  if (port <= 0) return [];
  try {
    if (IS_WIN) {
      const out = await runPowerShell(
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`
      );
      return out.split(",").map(Number).filter((n) => n > 0);
    } else {
      const out = await runShellCommand("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
      return out.split(/\r?\n/).map(Number).filter((n) => n > 0);
    }
  } catch { return []; }
}

/**
 * Check if a given PID's command line contains a pattern.
 * Windows: PowerShell Get-CimInstance
 * Unix: read /proc/{pid}/cmdline or use ps
 */
async function pidMatchesPattern(pid: number, pattern: string): Promise<boolean> {
  try {
    if (IS_WIN) {
      const out = await runPowerShell(
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue).CommandLine`
      );
      return out.includes(pattern);
    } else {
      const out = await runShellCommand("ps", ["-p", String(pid), "-o", "args="]);
      return out.includes(pattern);
    }
  } catch { return false; }
}

/**
 * Kill a process by PID.
 */
async function killPid(pid: number): Promise<void> {
  try {
    if (IS_WIN) {
      await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    } else {
      await runShellCommand("kill", ["-9", String(pid)]);
    }
  } catch { /* ignore */ }
}

async function stopProxyByPort(port: number, statusPort: number, processPattern: string): Promise<void> {
  const ports = [...new Set([port, statusPort].filter((v) => v > 0))];
  for (const p of ports) {
    const pids = await findPidsByPort(p);
    for (const pid of pids) {
      if (await pidMatchesPattern(pid, processPattern)) {
        await killPid(pid);
      }
    }
  }
}

async function cleanupDetachedNodeScripts(port: number, statusPort: number, processPattern: string): Promise<void> {
  const ports = [...new Set([port, statusPort].filter((v) => v > 0))];
  const listenerPids = new Set<number>();
  for (const p of ports) {
    for (const pid of await findPidsByPort(p)) {
      listenerPids.add(pid);
    }
  }

  try {
    if (IS_WIN) {
      const script = [
        "$procs = Get-CimInstance Win32_Process | Where-Object {",
        `  $_.Name -match '^node(\\.exe)?$' -and`,
        `  $_.CommandLine -like "*${processPattern}*"`,
        "}",
        "foreach ($proc in $procs) {",
        `  if (@(${[...listenerPids].join(",") || ""}) -notcontains $proc.ProcessId) {`,
        "    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue",
        "  }",
        "}",
      ].join("\n");
      await runPowerShell(script);
    } else {
      // Unix: use pgrep to find node processes matching the pattern
      try {
        const out = await runShellCommand("pgrep", ["-f", processPattern]);
        const pids = out.split(/\r?\n/).map(Number).filter((n) => n > 0);
        for (const pid of pids) {
          if (!listenerPids.has(pid)) {
            await killPid(pid);
          }
        }
      } catch { /* no matching processes */ }
    }
  } catch { /* ignore */ }
}

/**
 * Combined stop + cleanup in a SINGLE PowerShell invocation (Windows).
 * Replaces the serial stopProxyByPort + cleanupDetachedNodeScripts calls
 * which previously required 6-9 separate PowerShell invocations (~10-15s).
 * Now completes in a single ~2s PowerShell call.
 */
async function stopAndCleanup(port: number, statusPort: number, processPattern: string): Promise<void> {
  procLog(`[stopAndCleanup] port=${port} statusPort=${statusPort} pattern="${processPattern}"`);
  if (IS_WIN) {
    const ports = [...new Set([port, statusPort].filter((v) => v > 0))];
    const portsArray = ports.map(String).join(",");
    // Single PowerShell script that:
    // 1. Finds PIDs listening on the target ports
    // 2. Checks each PID's command line for the process pattern
    // 3. Kills matching port listeners
    // 4. Finds any orphan node processes with the pattern and kills them too
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ports = @(${portsArray})
$pattern = "*${processPattern}*"
$killedPids = @()
$diag = @()
$diag += "PORTS: $($ports -join ',')"
$diag += "PATTERN: $pattern"

# Step 1: Kill processes listening on target ports that match the pattern
foreach ($p in $ports) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  $diag += "PORT $p LISTENERS: $($conns.Count)"
  foreach ($conn in $conns) {
    $ownerPid = $conn.OwningProcess
    if ($ownerPid -gt 0 -and $killedPids -notcontains $ownerPid) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
      $cmdline = if ($proc) { $proc.CommandLine } else { '(none)' }
      $matched = if ($proc) { $proc.CommandLine -like $pattern } else { $false }
      $diag += "  PID $ownerPid CMD=$cmdline MATCH=$matched"
      if ($proc -and $matched) {
        Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        $killedPids += $ownerPid
        $diag += "  KILLED PID $ownerPid"
      }
    }
  }
}

# Step 2: Clean up any orphan node processes matching the pattern
$allNodeProcs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^node(\\.exe)?$' -and $_.CommandLine -like $pattern
}
$diag += "ORPHAN NODE PROCS: $($allNodeProcs.Count)"
foreach ($proc in $allNodeProcs) {
  $diag += "  ORPHAN PID $($proc.ProcessId) CMD=$($proc.CommandLine)"
  if ($killedPids -notcontains $proc.ProcessId) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    $diag += "  KILLED ORPHAN PID $($proc.ProcessId)"
  }
}

$diag += "TOTAL KILLED: $($killedPids.Count)"
$diag -join [char]10
`.trim();
    try {
      const output = await runPowerShell(script);
      procLog(`[stopAndCleanup] PowerShell output:\n${output}`);
    } catch (e: any) {
      procLog(`[stopAndCleanup] PowerShell error: ${e.message}`);
    }
  } else {
    // Unix: fall back to the original sequential approach (fast enough)
    await stopProxyByPort(port, statusPort, processPattern);
    await cleanupDetachedNodeScripts(port, statusPort, processPattern);
  }
  procLog(`[stopAndCleanup] done`);
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function startProxy(state: RosettaState): Promise<void> {
  const port = Number(state.config.tokenProxyPort || 60670);
  const statusPort = port + 1;
  const processPattern = state.workspace.paths.startProcessPattern || "start-token-proxy.js";
  procLog(`[startProxy] begin port=${port} statusPort=${statusPort} pattern="${processPattern}" statusUrl=${state.proxy.statusUrl}`);
  procLog(`[startProxy] scriptPath=${state.workspace.paths.startScriptPath}`);
  procLog(`[startProxy] rootPath=${state.workspace.rootPath}`);

  const config = readJsonFile(state.workspace.paths.configPath, { ...(state.config || {}) } as any);
  config.tokenProxyMode = "local";
  writeJsonFile(state.workspace.paths.configPath, config);
  procLog(`[startProxy] switched Token Proxy token source to local`);

  if (state.proxy.running || (await isProxyRunning(state.proxy.statusUrl))) {
    procLog(`[startProxy] skip: already running by state/check. state.proxy.running=${state.proxy.running}`);
    vscode.window.showInformationMessage("代理已经在运行。");
    return;
  }

  procLog(`[startProxy] stopAndCleanup before launch`);
  await stopAndCleanup(port, statusPort, processPattern);
  const nodeBinary = resolveNodeBinary();
  procLog(`[startProxy] launching: ${nodeBinary} ${state.workspace.paths.startScriptPath}`);
  const pid = launchDetachedNodeScript(nodeBinary, state.workspace.paths.startScriptPath, state.workspace.rootPath);
  procLog(`[startProxy] spawned PID=${pid}`);

  try {
    const status = await waitForProxyStatus(state.proxy.statusUrl, 15000, 400);
    procLog(`[startProxy] status confirmed: ${JSON.stringify(status).slice(0, 1200)}`);
  } catch (err: any) {
    procLog(`[startProxy] status check failed: ${err?.message || String(err)}`);
    await stopAndCleanup(port, statusPort, processPattern);
    if (await isProxyRunning(state.proxy.statusUrl)) {
      procLog(`[startProxy] status became running after cleanup race; accepting`);
      vscode.window.showInformationMessage("代理已经在运行。");
      return;
    }
    throw new Error("代理没有成功启动。");
  }
  vscode.window.showInformationMessage("代理已经启动。");

  // Auto-trigger quota refresh after startup so plan type & quota data
  // are available immediately (important on first run / Linux where
  // quota-data.json may not exist yet).
  if (state.proxy.refreshQuotaUrl) {
    postJson(state.proxy.refreshQuotaUrl, {}, { timeoutMs: 120000 }).catch(() => {
      // Non-fatal: quota will be refreshed by the poller within 5 minutes
    });
  }
}

export async function stopProxy(state: RosettaState): Promise<void> {
  const port = Number(state.config.tokenProxyPort || 60670);
  const statusPort = port + 1;
  const processPattern = state.workspace.paths.startProcessPattern || "start-token-proxy.js";
  procLog(`[stopProxy] begin port=${port} statusPort=${statusPort} pattern="${processPattern}" statusUrl=${state.proxy.statusUrl}`);
  procLog(`[stopProxy] state proxy.running=${state.proxy.running} active=${state.proxy.activeEmail || "(none)"} requests=${state.proxy.totalRequests}`);

  if (!state.proxy.running) {
    const live = await isProxyRunning(state.proxy.statusUrl).catch(() => false);
    procLog(`[stopProxy] skip by state, live status check=${live}`);
    vscode.window.showInformationMessage("代理已经停止。");
    return;
  }

  procLog(`[stopProxy] calling stopAndCleanup`);
  await stopAndCleanup(port, statusPort, processPattern);
  procLog(`[stopProxy] stopAndCleanup done; waiting for offline`);
  try {
    await waitForProxyOffline(state.proxy.statusUrl);
    procLog(`[stopProxy] confirmed offline`);
  } catch (err: any) {
    const live = await isProxyRunning(state.proxy.statusUrl).catch(() => false);
    procLog(`[stopProxy] waitForProxyOffline failed: ${err?.message || String(err)}; live status check=${live}`);
    throw err;
  }
  vscode.window.showInformationMessage("代理已经停止。");
}

export async function startReverseProxy(state: RosettaState): Promise<void> {
  const rpPort = Number(state.config.port) || 8787;
  const rpHeaders = state.reverseProxy.apiKey ? { Authorization: `Bearer ${state.reverseProxy.apiKey}` } : {};
  const rpStatusUrl = `http://127.0.0.1:${rpPort}/v1/proxy/status`;
  const processPattern = state.workspace.paths.reverseProxyProcessPattern || path.join("reverse-proxy", "index.js");

  if (state.reverseProxy.running || (await isProxyRunning(rpStatusUrl, false, { headers: rpHeaders }))) {
    vscode.window.showInformationMessage("OpenAI 反代已经在运行。");
    return;
  }

  await stopAndCleanup(rpPort, rpPort, processPattern);
  const nodeBinary = resolveNodeBinary();
  launchDetachedNodeScript(nodeBinary, state.workspace.paths.reverseProxyScriptPath, state.workspace.rootPath);

  try {
    await waitForProxyStatus(rpStatusUrl, 15000, 400, false, { headers: rpHeaders });
  } catch (err: any) {
    procLog(`[startReverseProxy] status check error detail=${err?.message || String(err)}`);
    await stopAndCleanup(rpPort, rpPort, processPattern);
    if (await isProxyRunning(rpStatusUrl, false, { headers: rpHeaders })) {
      vscode.window.showInformationMessage("OpenAI 反代已经在运行。");
      return;
    }
    throw new Error("反代没有成功启动。");
  }
  vscode.window.showInformationMessage("OpenAI 反代已启动。");
}

export async function stopReverseProxy(state: RosettaState): Promise<void> {
  const rpPort = Number(state.config.port) || 8787;
  const processPattern = state.workspace.paths.reverseProxyProcessPattern || path.join("reverse-proxy", "index.js");

  if (!state.reverseProxy.running) {
    vscode.window.showInformationMessage("OpenAI 反代已经停止。");
    return;
  }

  await stopAndCleanup(rpPort, rpPort, processPattern);
  // Also clean up legacy
  await stopAndCleanup(rpPort, rpPort, "antigravity-openai-proxy.js");
  await sleep(1000);
  vscode.window.showInformationMessage("OpenAI 反代已停止。");
}

export async function startRelayProxy(state: RosettaState): Promise<void> {
  {
  const tokenProxyPort = Number(state.config?.tokenProxyPort) || 60670;
  const statusPort = tokenProxyPort + 1;
  const statusUrl = `http://127.0.0.1:${statusPort}/status`;
  const config = readJsonFile(state.workspace.paths.configPath, { ...(state.config || {}) } as any);
  config.tokenProxyMode = "remote";
  if (!config.relayProxy) config.relayProxy = {};
  if (!config.relayProxy.tokenServerUrl || isOldLocalRemoteTokenUrl(config.relayProxy.tokenServerUrl)) {
    config.relayProxy.tokenServerUrl = DEFAULT_REMOTE_TOKEN_SERVER_URL;
  }
  writeJsonFile(state.workspace.paths.configPath, config);
  procLog(`[startRelayProxy] switched Token Proxy token source to remote; tokenServerUrl=${config.relayProxy.tokenServerUrl}; port remains ${tokenProxyPort}`);

  if (!(await isProxyRunning(statusUrl))) {
    const nodeBinary = resolveNodeBinary();
    const pid = launchDetachedNodeScript(
      nodeBinary,
      state.workspace.paths.startScriptPath,
      state.workspace.rootPath
    );
    procLog(`[startRelayProxy] spawned token proxy PID=${pid}`);
  }
  const status = await waitForProxyStatus(statusUrl, 15000, 400);
  procLog(`[startRelayProxy] token proxy status=${JSON.stringify(status).slice(0, 1200)}`);
  vscode.window.showInformationMessage("缁澂浠ｇ悊宸插惎鍔ㄣ€?");
  return;
  }

  // Relay proxy now listens on the SAME port as the token proxy (60670)
  // so we don't need to change cloudCodeUrl. The IDE keeps sending to :60670.
  const tokenProxyPort = Number(state.config?.tokenProxyPort) || 60670;
  const relayStatusPort = getRelayStatusPort(state.config);  // 60681
  const processPattern = state.workspace.paths.relayProxyProcessPattern || path.join("relay-proxy", "index.js");
  const relayStatusUrl = `http://127.0.0.1:${relayStatusPort}/status`;

  procLog(`[startRelayProxy] proxyPort=${tokenProxyPort} (shared with token proxy) statusPort=${relayStatusPort}`);
  procLog(`[startRelayProxy] scriptPath=${state.workspace.paths.relayProxyScriptPath}`);
  procLog(`[startRelayProxy] rootPath=${state.workspace.rootPath}`);
  procLog(`[startRelayProxy] incoming state proxy.running=${state.proxy.running} relay.running=${state.relay.running} relay.hasApiKey=${state.relay.hasApiKey} upstream=${state.relay.upstream || "(empty)"}`);
  procLog(`[startRelayProxy] config relayProxy=${JSON.stringify(state.config?.relayProxy || {})}`);

  if (await isProxyRunning(relayStatusUrl)) {
    procLog(`[startRelayProxy] already running (status on ${relayStatusPort}), skipping`);
    vscode.window.showInformationMessage("续杯代理已经在运行。");
    return;
  }

  // Clean up any leftover relay processes (using relay-specific pattern)
  procLog(`[startRelayProxy] cleaning up before start...`);
  await stopAndCleanup(tokenProxyPort, relayStatusPort, processPattern);
  procLog(`[startRelayProxy] cleanup complete; launching relay now`);
  const nodeBinary = resolveNodeBinary();
  procLog(`[startRelayProxy] launching: ${nodeBinary} ${state.workspace.paths.relayProxyScriptPath}`);
  procLog(`[startRelayProxy] env: RELAY_PROXY_PORT=${tokenProxyPort} RELAY_STATUS_PORT=${relayStatusPort}`);
  const pid = launchDetachedNodeScript(
    nodeBinary,
    state.workspace.paths.relayProxyScriptPath,
    state.workspace.rootPath,
    {
      RELAY_PROXY_PORT: String(tokenProxyPort),
      RELAY_STATUS_PORT: String(relayStatusPort),
    }
  );
  procLog(`[startRelayProxy] spawned PID=${pid}`);

  try {
    const status = await waitForProxyStatus(relayStatusUrl, 15000, 400);
    procLog(`[startRelayProxy] status payload=${JSON.stringify(status).slice(0, 1200)}`);
    procLog(`[startRelayProxy] ✅ status confirmed running on :${relayStatusPort}`);
  } catch (err: any) {
    procLog(`[startRelayProxy] status check error detail=${err?.message || String(err)}`);
    procLog(`[startRelayProxy] ❌ status check failed, cleaning up...`);
    await stopAndCleanup(tokenProxyPort, relayStatusPort, processPattern);
    if (await isProxyRunning(relayStatusUrl)) {
      procLog(`[startRelayProxy] but it IS running after cleanup (race?), accepting`);
      vscode.window.showInformationMessage("续杯代理已经在运行。");
      return;
    }
    throw new Error("续杯代理没有成功启动。");
  }
  vscode.window.showInformationMessage("续杯代理已启动。");
}

export async function stopRelayProxy(state: RosettaState): Promise<void> {
  {
  const config = readJsonFile(state.workspace.paths.configPath, { ...(state.config || {}) } as any);
  config.tokenProxyMode = "local";
  writeJsonFile(state.workspace.paths.configPath, config);
  procLog(`[stopRelayProxy] switched Token Proxy token source to local; port unchanged`);
  vscode.window.showInformationMessage("缁澂浠ｇ悊宸插仠姝€?");
  return;
  }

  // Relay proxy now runs on the token proxy port, with its own status port
  const tokenProxyPort = Number(state.config?.tokenProxyPort) || 60670;
  const relayStatusPort = getRelayStatusPort(state.config);  // 60681
  const processPattern = state.workspace.paths.relayProxyProcessPattern || path.join("relay-proxy", "index.js");
  const relayStatusUrl = `http://127.0.0.1:${relayStatusPort}/status`;

  procLog(`[stopRelayProxy] proxyPort=${tokenProxyPort} statusPort=${relayStatusPort} pattern="${processPattern}"`);

  // Check if it's actually running first
  const isRunning = await isProxyRunning(relayStatusUrl);
  procLog(`[stopRelayProxy] isRunning (pre-stop)=${isRunning}`);

  procLog(`[stopRelayProxy] calling stopAndCleanup...`);
  await stopAndCleanup(tokenProxyPort, relayStatusPort, processPattern);
  procLog(`[stopRelayProxy] stopAndCleanup done, waiting for offline...`);

  try {
    await waitForProxyOffline(relayStatusUrl);
    procLog(`[stopRelayProxy] ✅ confirmed offline`);
  } catch (e: any) {
    procLog(`[stopRelayProxy] ⚠️ waitForProxyOffline issue: ${e?.message || '(timeout?)'}`);
  }

  // Double check
  const stillRunning = await isProxyRunning(relayStatusUrl);
  procLog(`[stopRelayProxy] isRunning (post-stop)=${stillRunning}`);
  if (stillRunning) {
    procLog(`[stopRelayProxy] ⚠️ STILL RUNNING after stop! Attempting port-based kill...`);
    const pids = await findPidsByPort(tokenProxyPort);
    const statusPids = await findPidsByPort(relayStatusPort);
    const allPids = [...new Set([...pids, ...statusPids])];
    procLog(`[stopRelayProxy] found PIDs on ports: ${JSON.stringify(allPids)}`);
    for (const pid of allPids) {
      procLog(`[stopRelayProxy] force killing PID ${pid}`);
      await killPid(pid);
    }
    await sleep(1000);
    const finalCheck = await isProxyRunning(relayStatusUrl);
    procLog(`[stopRelayProxy] isRunning (final)=${finalCheck}`);
  }

  vscode.window.showInformationMessage("续杯代理已停止。");
}

export async function attachIdeRelay(state: RosettaState): Promise<void> {
  const relayUrl = state.relay.url || `http://127.0.0.1:${Number(state.config?.relayProxy?.port) || 60680}`;
  writeIdeCloudCodeUrl(state.workspace.paths.ideSettingsPath, relayUrl);
  try {
    await vscode.workspace.getConfiguration("jetski").update("cloudCodeUrl", relayUrl, vscode.ConfigurationTarget.Global);
  } catch { /* non-fatal */ }
  vscode.window.showInformationMessage("IDE 已切换到续杯代理。");
}

export async function attachIde(state: RosettaState): Promise<void> {
  writeIdeCloudCodeUrl(state.workspace.paths.ideSettingsPath, state.ide.expectedUrl);
  // Also update via VS Code API to ensure immediate internal change detection
  try {
    await vscode.workspace.getConfiguration("jetski").update("cloudCodeUrl", state.ide.expectedUrl, vscode.ConfigurationTarget.Global);
  } catch { /* non-fatal: API may not recognize this setting */ }
  vscode.window.showInformationMessage("IDE 已接管代理。");
}

export async function clearIde(state: RosettaState): Promise<void> {
  writeIdeCloudCodeUrl(state.workspace.paths.ideSettingsPath, "");
  // Also update via VS Code API to ensure immediate internal change detection
  try {
    await vscode.workspace.getConfiguration("jetski").update("cloudCodeUrl", undefined, vscode.ConfigurationTarget.Global);
  } catch { /* non-fatal */ }
  vscode.window.showInformationMessage("IDE 已取消接管。");
}

export async function refreshQuota(state: RosettaState): Promise<void> {
  if (!state.proxy.running) throw new Error("先开启一键接管，再刷新额度。");
  await postJson(state.proxy.refreshQuotaUrl, {}, { timeoutMs: 120000 });
  vscode.window.showInformationMessage("额度已经刷新。");
}

export async function switchAccount(state: RosettaState, accountId: number): Promise<void> {
  if (!state.proxy.running) throw new Error("代理未运行，无法切换账号。");
  if (state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 45000 }); } catch { /* non-fatal */ }
  }
  await postJson(state.proxy.switchUrl, { accountId });
  const acc = state.accounts.find((a) => a.id === accountId);
  vscode.window.showInformationMessage(`已切到 ${acc?.email || `账号 #${accountId}`}`);
}

export async function toggleAccount(state: RosettaState, accountId: number): Promise<void> {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("没找到这个账号。");
  const current = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const next = updateAccountRecord(current, accountId, { enabled: !acc.enabled });
  writeJsonFile(state.workspace.paths.accountsPath, next);
  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 45000 }); } catch { /* non-fatal */ }
  }
  vscode.window.showInformationMessage(acc.enabled ? "账号已停用。" : "账号已启用。");
}

export async function deleteAccount(state: RosettaState, accountId: number): Promise<void> {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("没找到这个账号。");

  const confirm = await vscode.window.showWarningMessage(
    `确认删除账号 ${acc.email}？此操作不可恢复。`,
    { modal: true },
    "确认删除"
  );
  if (confirm !== "确认删除") return;

  const fs = require("fs");
  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const accounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  const filtered = accounts.filter((a: any) => Number(a.id) !== accountId);
  writeJsonFile(state.workspace.paths.accountsPath, { ...accountsData, accounts: filtered });

  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 10000 }); } catch { /* non-fatal */ }
  }
  vscode.window.showInformationMessage(`已删除账号 ${acc.email}`);
}

export async function editAlias(state: RosettaState, accountId: number): Promise<void> {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("没找到这个账号。");
  const value = await vscode.window.showInputBox({
    prompt: `设置账号 ${acc.email} 的别名`,
    value: acc.alias || "",
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const current = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const next = updateAccountRecord(current, accountId, { alias: value.trim() });
  writeJsonFile(state.workspace.paths.accountsPath, next);
  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 45000 }); } catch { /* */ }
  }
  vscode.window.showInformationMessage("别名已更新。");
}

export async function editCredentials(state: RosettaState, accountId: number): Promise<void> {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("没找到这个账号。");

  // Read current credentials from accounts.json
  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const rawAccounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  const rawAcc = rawAccounts.find((a: any) => Number(a.id) === accountId);
  const currentPassword = String(rawAcc?.loginPassword || "").trim();
  const currentTotp = String(rawAcc?.totpSecret || "").trim();

  // Step 1: Input password
  const password = await vscode.window.showInputBox({
    title: `设置 ${acc.email} 的登录密码`,
    prompt: "输入 Google 账号密码（用于自动接受邀请）",
    value: currentPassword,
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return; // cancelled

  // Step 2: Input TOTP secret
  const totp = await vscode.window.showInputBox({
    title: `设置 ${acc.email} 的 TOTP 密钥`,
    prompt: "输入两步验证密钥（Base32 格式，或 2fa.live 链接）",
    value: currentTotp,
    ignoreFocusOut: true,
    placeHolder: "例如: JBSWY3DPEHPK3PXP 或 https://2fa.live/tok/xxxxx",
  });
  if (totp === undefined) return; // cancelled

  // Normalize TOTP: extract from 2fa.live URL if provided
  let normalizedTotp = totp.trim();
  const urlMatch = normalizedTotp.match(/2fa\.live\/tok\/([a-z0-9]+)/i);
  if (urlMatch) {
    normalizedTotp = urlMatch[1].toUpperCase();
  } else {
    normalizedTotp = normalizedTotp.replace(/[\s\-=]/g, "").toUpperCase();
  }

  // Save to accounts.json
  const current = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const next = updateAccountRecord(current, accountId, {
    loginPassword: password.trim(),
    totpSecret: normalizedTotp,
  });
  writeJsonFile(state.workspace.paths.accountsPath, next);

  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 45000 }); } catch { /* */ }
  }

  const status = password.trim() && normalizedTotp
    ? "密码和 TOTP 已保存。"
    : password.trim()
      ? "密码已保存（TOTP 未设置）。"
      : normalizedTotp
        ? "TOTP 已保存（密码未设置）。"
        : "凭据已清除。";
  vscode.window.showInformationMessage(status);
}

export function getStoredCredentialLine(state: RosettaState, accountId: number): string {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("没找到这个账号。");

  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const rawAccounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  const rawAcc = rawAccounts.find((a: any) => Number(a.id) === accountId);
  
  const email = String(rawAcc?.email || acc.email).trim();
  const password = String(rawAcc?.loginPassword || "").trim();
  const totp = String(rawAcc?.totpSecret || "").trim();

  if (!password) throw new Error(`账号 ${email} 未录入密码。`);

  return totp ? `${email}----${password}----${totp}` : `${email}----${password}`;
}

export async function setReverseProxyKey(state: RosettaState): Promise<void> {
  const currentKey = String(state.config.localApiKey || "").trim();
  const newKey = await vscode.window.showInputBox({
    title: "OpenAI 反代 API Key",
    prompt: "设置反代的访问密钥（留空则不需要密钥）",
    value: currentKey,
    password: false,
  });
  if (newKey === undefined) return;
  const fs = require("fs");
  const config = readJsonFile(state.workspace.paths.configPath, {} as any);
  config.localApiKey = newKey;
  writeJsonFile(state.workspace.paths.configPath, config);
  vscode.window.showInformationMessage(newKey ? "API Key 已更新。反代重启后生效。" : "API Key 已清除。反代重启后生效。");
}

export async function addAccountByToken(
  state: RosettaState,
  refreshToken: string,
  alias: string
): Promise<{ email: string }> {
  if (!refreshToken.trim()) throw new Error("Refresh Token 不能为空。");

  // Read existing accounts
  const fs = require("fs");
  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const accounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];

  // Try to read the client ID / secret from config for token exchange
  const config = readJsonFile(state.workspace.paths.configPath, {} as any);
  const clientId = String(config.clientId || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com").trim();
  const clientSecret = String(config.clientSecret || "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").trim();

  // Exchange refresh token for access token and get user info
  let email = "";
  let projectId = "";
  let accessToken = "";
  try {
    const tokenResp = await exchangeRefreshToken(refreshToken.trim(), clientId, clientSecret);
    accessToken = tokenResp.access_token;
    const userInfo = await fetchUserInfo(accessToken);
    email = String(userInfo.email || "").trim();
    if (!email) throw new Error("无法从 Token 获取邮箱。");
  } catch (err: any) {
    throw new Error(`Token 验证失败: ${err.message}`);
  }

  // Fetch project ID via loadCodeAssist API
  if (accessToken) {
    try {
      projectId = await fetchProjectId(accessToken);
    } catch { /* non-fatal — projectId will stay empty */ }
  }

  // Check for duplicates
  if (accounts.some((a: any) => String(a.email || "").trim().toLowerCase() === email.toLowerCase())) {
    throw new Error(`账号 ${email} 已存在。`);
  }

  // Assign next ID
  const maxId = accounts.reduce((max: number, a: any) => Math.max(max, Number(a.id) || 0), 0);
  const newAccount = {
    id: maxId + 1,
    email,
    refreshToken: refreshToken.trim(),
    enabled: true,
    alias: alias || "",
    oauthProfile: "antigravity",
    ...(projectId ? { projectId } : {}),
  };

  accounts.push(newAccount);
  writeJsonFile(state.workspace.paths.accountsPath, { ...accountsData, accounts });

  // Reload accounts in proxy if running
  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 10000 }); } catch { /* non-fatal */ }
  }

  // Trigger quota refresh if proxy running
  if (state.proxy.running && state.proxy.refreshQuotaUrl) {
    try { await postJson(state.proxy.refreshQuotaUrl, {}, { timeoutMs: 45000 }); } catch { /* non-fatal */ }
  }

  vscode.window.showInformationMessage(`已添加账号 ${email}`);
  return { email };
}

export interface BatchImportItem {
  refreshToken: string;
  alias?: string;
}

export interface BatchImportResult {
  total: number;
  success: number;
  skipped: number;
  failed: number;
  details: Array<{ alias: string; email?: string; status: "ok" | "skipped" | "error"; message: string }>;
}

export async function batchImportTokens(
  state: RosettaState,
  items: BatchImportItem[],
  onProgress?: (current: number, total: number, detail: string) => void
): Promise<BatchImportResult> {
  if (!items.length) throw new Error("导入列表为空。");

  const fs = require("fs");
  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const accounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  const config = readJsonFile(state.workspace.paths.configPath, {} as any);
  const clientId = String(config.clientId || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com").trim();
  const clientSecret = String(config.clientSecret || "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").trim();

  const result: BatchImportResult = { total: items.length, success: 0, skipped: 0, failed: 0, details: [] };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const token = (item.refreshToken || "").trim();
    const alias = (item.alias || "").trim();
    const label = alias || `#${i + 1}`;

    if (!token) {
      result.failed++;
      result.details.push({ alias: label, status: "error", message: "Token 为空" });
      continue;
    }

    onProgress?.(i + 1, items.length, `正在验证 ${label}…`);

    try {
      const tokenResp = await exchangeRefreshToken(token, clientId, clientSecret);
      const accessToken = tokenResp.access_token;
      const userInfo = await fetchUserInfo(accessToken);
      const email = String(userInfo.email || "").trim();
      if (!email) {
        result.failed++;
        result.details.push({ alias: label, status: "error", message: "无法获取邮箱" });
        continue;
      }

      if (accounts.some((a: any) => String(a.email || "").trim().toLowerCase() === email.toLowerCase())) {
        result.skipped++;
        result.details.push({ alias: label, email, status: "skipped", message: "已存在" });
        continue;
      }

      const maxId = accounts.reduce((max: number, a: any) => Math.max(max, Number(a.id) || 0), 0);
      accounts.push({
        id: maxId + 1,
        email,
        refreshToken: token,
        enabled: true,
        alias,
        oauthProfile: "antigravity",
      });

      result.success++;
      result.details.push({ alias: label, email, status: "ok", message: "Token 有效" });
    } catch (err: any) {
      result.failed++;
      result.details.push({ alias: label, status: "error", message: err.message || String(err) });
    }
  }

  writeJsonFile(state.workspace.paths.accountsPath, { ...accountsData, accounts });

  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 10000 }); } catch { /* non-fatal */ }
  }

  vscode.window.showInformationMessage(`批量导入完成: ${result.success} 成功, ${result.skipped} 跳过, ${result.failed} 失败`);
  return result;
}

// ─── Google OAuth helpers ───────────────────────────────────────────────

function exchangeRefreshToken(refreshToken: string, clientId: string, clientSecret: string): Promise<any> {
  const https = require("https");
  const postData = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: "oauth2.googleapis.com",
        path: "/token",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const data = JSON.parse(raw);
            if (data.error) reject(new Error(data.error_description || data.error));
            else resolve(data);
          } catch { reject(new Error("Token 响应解析失败")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Token 交换超时")));
    req.write(postData);
    req.end();
  });
}

function fetchUserInfo(accessToken: string): Promise<any> {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "GET",
        hostname: "www.googleapis.com",
        path: "/oauth2/v2/userinfo",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("用户信息解析失败")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("用户信息获取超时")));
    req.end();
  });
}

export async function addAccountTerminal(state: RosettaState): Promise<void> {
  const nodeBinary = resolveNodeBinary();
  const terminal = vscode.window.createTerminal({
    name: "Add Rosetta Account",
    cwd: state.workspace.rootPath,
  });
  terminal.show(false);
  const cmd = IS_WIN ? `& "${nodeBinary}" "${state.workspace.paths.addAccountPath}"` : `"${nodeBinary}" "${state.workspace.paths.addAccountPath}"`;
  terminal.sendText(cmd, true);
}

/**
 * Add account via browser OAuth login flow:
 * 1. Start local HTTP server on random port
 * 2. Open browser to Google OAuth consent screen
 * 3. User logs in and authorizes
 * 4. Google redirects back to localhost with authorization code
 * 5. Exchange code for refresh_token + access_token
 * 6. Get user email
 * 7. Save to accounts.json
 */
export async function addAccountBrowser(state: RosettaState): Promise<{ email: string }> {
  const http = require("http");
  const https = require("https");
  const crypto = require("crypto");

  const config = readJsonFile(state.workspace.paths.configPath, {} as any);
  const clientId = String(config.clientId || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com").trim();
  const clientSecret = String(config.clientSecret || "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").trim();

  const SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ].join(" ");

  // Generate PKCE-like state for CSRF protection
  const oauthState = crypto.randomBytes(16).toString("hex");

  return new Promise<{ email: string }>((resolve, reject) => {
    let settled = false;
    let server: any = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function cleanup() {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (server) { try { server.close(); } catch { /* */ } server = null; }
    }

    function fail(msg: string) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    }

    function succeed(result: { email: string }) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    // Timeout after 3 minutes
    timeoutTimer = setTimeout(() => fail("OAuth 登录超时（3分钟）"), 180000);

    // Create HTTP server to handle the OAuth redirect
    server = http.createServer(async (req: any, res: any) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          const successHtml = getResultHtml(false, `授权被拒绝: ${error}`);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(successHtml);
          fail(`授权被拒绝: ${error}`);
          return;
        }

        if (!code || returnedState !== oauthState) {
          const errorHtml = getResultHtml(false, "无效的授权回调");
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml);
          fail("无效的授权回调（state 不匹配或缺少 code）");
          return;
        }

        // Show "processing" page immediately
        const processingHtml = getResultHtml(true, "正在处理，请稍候…");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(processingHtml);

        // Exchange authorization code for tokens
        const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const tokenData = await exchangeAuthCode(code, clientId, clientSecret, redirectUri);

        if (!tokenData.refresh_token) {
          fail("未获得 refresh_token。请检查 OAuth 配置或使用不同账号重试。");
          return;
        }

        // Get user info
        const userInfo = await fetchUserInfo(tokenData.access_token);
        const email = String(userInfo.email || "").trim();
        if (!email) {
          fail("无法从 Token 获取邮箱。");
          return;
        }

        // Fetch project ID via loadCodeAssist API
        let projectId = "";
        try {
          projectId = await fetchProjectId(tokenData.access_token);
        } catch { /* non-fatal */ }

        // Save to accounts.json
        const fs = require("fs");
        const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
        const accounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];

        if (accounts.some((a: any) => String(a.email || "").trim().toLowerCase() === email.toLowerCase())) {
          vscode.window.showWarningMessage(`账号 ${email} 已存在。`);
          succeed({ email });
          return;
        }

        const maxId = accounts.reduce((max: number, a: any) => Math.max(max, Number(a.id) || 0), 0);
        accounts.push({
          id: maxId + 1,
          email,
          refreshToken: tokenData.refresh_token,
          enabled: true,
          alias: "",
          oauthProfile: "antigravity",
          ...(projectId ? { projectId } : {}),
        });
        writeJsonFile(state.workspace.paths.accountsPath, { ...accountsData, accounts });

        // Reload accounts in proxy if running
        if (state.proxy.running && state.proxy.reloadAccountsUrl) {
          try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 10000 }); } catch { /* */ }
        }

        // Trigger quota refresh if proxy running (same as addAccountByToken)
        if (state.proxy.running && state.proxy.refreshQuotaUrl) {
          try { await postJson(state.proxy.refreshQuotaUrl, {}, { timeoutMs: 45000 }); } catch { /* non-fatal */ }
        }

        vscode.window.showInformationMessage(`✅ 已通过浏览器添加账号 ${email}`);
        succeed({ email });
      } catch (err: any) {
        fail(err.message || String(err));
      }
    });

    // Listen on random port
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&include_granted_scopes=true` +
        `&state=${oauthState}`;

      vscode.env.openExternal(vscode.Uri.parse(authUrl)).then(
        (opened) => {
          if (!opened) fail("无法打开浏览器。");
        },
        (err) => fail(`打开浏览器失败: ${err.message}`)
      );
    });

    server.on("error", (err: any) => fail(`本地服务器启动失败: ${err.message}`));
  });
}

// Exchange authorization code for tokens
function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<any> {
  const https = require("https");
  const postData = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: "oauth2.googleapis.com",
        path: "/token",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const data = JSON.parse(raw);
            if (data.error) reject(new Error(data.error_description || data.error));
            else resolve(data);
          } catch { reject(new Error("Token 响应解析失败")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Token 交换超时")));
    req.write(postData);
    req.end();
  });
}

// ─── Fetch project ID via loadCodeAssist API ───────────────────────────
// Reference: Antigravity-Manager project_resolver.rs
// Calls loadCodeAssist to get cloudaicompanionProject, and if not found,
// tries onboardUser to provision the project.

function fetchProjectId(accessToken: string): Promise<string> {
  const https = require("https");

  const METADATA = {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: "1.21.6",
    pluginVersion: "1.21.6",
    platform: getPlatformString(),
    updateChannel: "stable",
    pluginType: "GEMINI",
  };
  const LOAD_UA = `antigravity/1.21.6 ${getPlatformUA()} google-api-nodejs-client/10.3.0`;

  const bases = [
    "daily-cloudcode-pa.sandbox.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
  ];

  return new Promise<string>(async (resolve, reject) => {
    for (const host of bases) {
      try {
        const loadBody = JSON.stringify({ metadata: METADATA });
        const loadResult: any = await httpsPost(host, "/v1internal:loadCodeAssist", accessToken, loadBody, LOAD_UA);

        // Extract cloudaicompanionProject
        const project = loadResult?.cloudaicompanionProject;
        if (typeof project === "string" && project) {
          return resolve(project);
        }
        if (project?.id) {
          return resolve(project.id);
        }

        // No project — try onboardUser
        const allowedTiers = loadResult?.allowedTiers ?? [];
        const currentTier = loadResult?.currentTier;
        const tierId =
          allowedTiers.find((t: any) => t.isDefault)?.id ||
          allowedTiers.find((t: any) => t.id)?.id ||
          loadResult?.paidTier?.id || currentTier?.id;

        if (tierId) {
          try {
            const onboardBody = JSON.stringify({ tierId, metadata: METADATA });
            let onboardResult: any = await httpsPost(host, "/v1internal:onboardUser", accessToken, onboardBody, LOAD_UA);

            // Poll until done
            let polls = 0;
            while (!onboardResult?.done && polls < 10) {
              const opName = String(onboardResult?.name || "").trim();
              if (!opName) break;
              await new Promise(r => setTimeout(r, 500));
              onboardResult = await httpsGet(host, `/v1internal/${opName}`, accessToken, LOAD_UA);
              polls++;
            }

            const onboardProject = onboardResult?.response?.cloudaicompanionProject;
            if (typeof onboardProject === "string" && onboardProject) {
              return resolve(onboardProject);
            }
            if (onboardProject?.id) {
              return resolve(onboardProject.id);
            }
          } catch { /* try next base */ }
        }
      } catch { /* try next base */ }
    }
    reject(new Error("无法获取项目号"));
  });
}

function httpsPost(hostname: string, path: string, accessToken: string, body: string, userAgent: string): Promise<any> {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname,
        path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": userAgent,
          "Accept-Encoding": "identity",
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${res.statusCode}: ${raw.substring(0, 200)}`));
            return;
          }
          try { resolve(raw ? JSON.parse(raw) : {}); }
          catch { reject(new Error("JSON parse failed")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname: string, path: string, accessToken: string, userAgent: string): Promise<any> {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "GET",
        hostname,
        path,
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": userAgent,
          "Accept-Encoding": "identity",
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${res.statusCode}`));
            return;
          }
          try { resolve(raw ? JSON.parse(raw) : {}); }
          catch { reject(new Error("JSON parse failed")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// Generate callback result HTML page
function getResultHtml(success: boolean, message: string): string {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "⏳" : "❌";
  const title = success ? "正在处理" : "授权失败";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BCAI TOOLS - ${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
      background: #f5efe5; color: #1f1a17;
    }
    .card {
      text-align: center; padding: 48px 40px; border-radius: 24px;
      background: rgba(255,252,248,0.92); border: 1px solid rgba(31,26,23,0.1);
      box-shadow: 0 22px 72px rgba(56,39,30,0.12); max-width: 440px;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; color: ${color}; }
    p { color: rgba(31,26,23,0.68); line-height: 1.6; margin-top: 8px; }
    .hint { font-size: 13px; margin-top: 16px; color: rgba(31,26,23,0.45); }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="hint">可以关闭此页面并返回 Antigravity。</p>
  </div>
  <script>setTimeout(() => window.close(), ${success ? 3000 : 8000});</script>
</body>
</html>`;
}

/**
 * Detailed project ID fetch: returns both projectId and any termsOfServiceUri
 * (verification URL) found in the loadCodeAssist response.
 */
function fetchProjectIdDetailed(accessToken: string): Promise<{
  projectId?: string;
  termsOfServiceUri?: string;
  error?: string;
}> {
  const METADATA = {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: "1.21.6",
    pluginVersion: "1.21.6",
    platform: getPlatformString(),
    updateChannel: "stable",
    pluginType: "GEMINI",
  };
  const LOAD_UA = `antigravity/1.21.6 ${getPlatformUA()} google-api-nodejs-client/10.3.0`;

  const bases = [
    "daily-cloudcode-pa.sandbox.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
  ];

  return (async () => {
    let lastTosUri: string | undefined;

    for (const host of bases) {
      try {
        const loadBody = JSON.stringify({ metadata: METADATA });
        const loadResult: any = await httpsPost(host, "/v1internal:loadCodeAssist", accessToken, loadBody, LOAD_UA);

        // Extract termsOfServiceUri from response (may appear at top level or inside currentTier/allowedTiers)
        const tosUri =
          loadResult?.termsOfServiceUri ||
          loadResult?.currentTier?.termsOfServiceUri ||
          (Array.isArray(loadResult?.allowedTiers) && loadResult.allowedTiers.find((t: any) => t.termsOfServiceUri)?.termsOfServiceUri) ||
          undefined;
        if (tosUri) lastTosUri = String(tosUri);

        // Extract cloudaicompanionProject
        const project = loadResult?.cloudaicompanionProject;
        if (typeof project === "string" && project) {
          return { projectId: project, termsOfServiceUri: lastTosUri };
        }
        if (project?.id) {
          return { projectId: project.id, termsOfServiceUri: lastTosUri };
        }

        // No project — try onboardUser
        const allowedTiers = loadResult?.allowedTiers ?? [];
        const currentTier = loadResult?.currentTier;
        const tierId =
          allowedTiers.find((t: any) => t.isDefault)?.id ||
          allowedTiers.find((t: any) => t.id)?.id ||
          loadResult?.paidTier?.id || currentTier?.id;

        if (tierId) {
          try {
            const onboardBody = JSON.stringify({ tierId, metadata: METADATA });
            let onboardResult: any = await httpsPost(host, "/v1internal:onboardUser", accessToken, onboardBody, LOAD_UA);

            // Check for TOS in onboard response too
            const onboardTos = onboardResult?.termsOfServiceUri || onboardResult?.response?.termsOfServiceUri;
            if (onboardTos) lastTosUri = String(onboardTos);

            // Poll until done
            let polls = 0;
            while (!onboardResult?.done && polls < 10) {
              const opName = String(onboardResult?.name || "").trim();
              if (!opName) break;
              await new Promise(r => setTimeout(r, 500));
              onboardResult = await httpsGet(host, `/v1internal/${opName}`, accessToken, LOAD_UA);
              polls++;
            }

            const onboardProject = onboardResult?.response?.cloudaicompanionProject;
            if (typeof onboardProject === "string" && onboardProject) {
              return { projectId: onboardProject, termsOfServiceUri: lastTosUri };
            }
            if (onboardProject?.id) {
              return { projectId: onboardProject.id, termsOfServiceUri: lastTosUri };
            }
          } catch { /* try next base */ }
        }
      } catch (err: any) {
        // Check if the error body contains a verification URL
        const errStr = String(err?.message || "");
        const urlMatch = errStr.match(/https:\/\/[^\s"'<>]+/);
        if (urlMatch) lastTosUri = urlMatch[0];
      }
    }

    return {
      error: "无法获取项目号",
      termsOfServiceUri: lastTosUri,
    };
  })();
}

/**
 * Warmup an account: re-attempt to fetch/provision the projectId.
 * This is useful when addAccount succeeds but fetchProjectId fails.
 * Returns { ok, email, projectId?, verificationUrl?, error? }.
 */
export async function warmupAccount(
  state: RosettaState,
  accountId: number
): Promise<{ ok: boolean; email: string; projectId?: string; verificationUrl?: string; error?: string }> {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error("没找到这个账号。");

  // Read accounts.json to get the refresh token
  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const rawAccounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  const rawAcc = rawAccounts.find((a: any) => Number(a.id) === accountId);
  if (!rawAcc) throw new Error("在 accounts.json 中未找到此账号。");

  const refreshToken = String(rawAcc.refreshToken || "").trim();
  if (!refreshToken) throw new Error(`账号 ${acc.email} 没有存储 refresh_token，无法预热。`);

  const config = readJsonFile(state.workspace.paths.configPath, {} as any);
  const clientId = String(config.clientId || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com").trim();
  const clientSecret = String(config.clientSecret || "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").trim();

  // Step 1: Exchange refresh token for access token
  let accessToken: string;
  try {
    const tokenResp = await exchangeRefreshToken(refreshToken, clientId, clientSecret);
    accessToken = tokenResp.access_token;
    if (!accessToken) throw new Error("返回的 access_token 为空");
  } catch (err: any) {
    return { ok: false, email: acc.email, error: `Token 交换失败: ${err.message}` };
  }

  // Step 2: Fetch project ID with detailed response (including verification URL)
  const detailed = await fetchProjectIdDetailed(accessToken);

  if (!detailed.projectId) {
    const errorMsg = detailed.error || "loadCodeAssist 返回了空的项目号";
    const hint = detailed.termsOfServiceUri
      ? `${errorMsg}。需要验证，请点击验证链接完成验证后重试。`
      : errorMsg;
    return {
      ok: false,
      email: acc.email,
      error: hint,
      verificationUrl: detailed.termsOfServiceUri,
    };
  }

  // Step 3: Save projectId to accounts.json
  const freshData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const freshAccounts: any[] = Array.isArray(freshData.accounts) ? freshData.accounts : [];
  const target = freshAccounts.find((a: any) => Number(a.id) === accountId);
  if (target) {
    target.projectId = detailed.projectId;
    writeJsonFile(state.workspace.paths.accountsPath, { ...freshData, accounts: freshAccounts });
  }

  // Step 4: Reload accounts in proxy if running
  if (state.proxy.running && state.proxy.reloadAccountsUrl) {
    try { await postJson(state.proxy.reloadAccountsUrl, {}, { timeoutMs: 10000 }); } catch { /* non-fatal */ }
  }

  return { ok: true, email: acc.email, projectId: detailed.projectId };
}

export async function runDiagnose(state: RosettaState): Promise<void> {
  const nodeBinary = resolveNodeBinary();
  const terminal = vscode.window.createTerminal({
    name: "Rosetta Diagnose",
    cwd: state.workspace.rootPath,
  });
  terminal.show(false);
  const cmd = IS_WIN ? `& "${nodeBinary}" "${state.workspace.paths.diagnosePath}"` : `"${nodeBinary}" "${state.workspace.paths.diagnosePath}"`;
  terminal.sendText(cmd, true);
}

export async function openFile(state: RosettaState, kind: string): Promise<void> {
  const filePath = (state.workspace.paths as any)[`${kind}Path`];
  if (!filePath || !require("fs").existsSync(filePath)) throw new Error("目标文件不存在。");
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc, { preview: false });
}

// Helper for readJsonFile (duplicated here to avoid circular import for the fs-based helpers)
function readJsonFile<T>(filePath: string, fallback: T): T {
  const fs = require("fs");
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
  } catch { return fallback; }
}
