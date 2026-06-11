#!/usr/bin/env node
/**
 * scripts/start.mjs
 *
 * Production launcher — runs all services (api, web, worker) with
 * persistent logging. Logs are written to logs/<service>-YYYY-MM-DD.log
 * and rotated daily.
 *
 * Usage:
 *   pnpm start          (after pnpm build)
 *   node scripts/start.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, createWriteStream, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOGS_DIR = join(ROOT, "logs");
const PID_FILE = join(ROOT, "gfa.pid");

// ── Daemon mode: --daemon re-launches as detached background process ─────────
if (process.argv.includes("--stop")) {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, "utf8").trim();
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`[stop] Sent SIGTERM to PID ${pid}`);
    } catch (e) {
      console.log(`[stop] Process ${pid} not running (${e.code})`);
    }
    try { unlinkSync(PID_FILE); } catch {}
  } else {
    console.log("[stop] No PID file found — is the daemon running?");
  }
  process.exit(0);
}

if (process.argv.includes("--daemon")) {
  const env = readEnv();
  const apiPort = env.API_PORT || "3001";

  // ── Auto-stop old daemon if running ──────────────────────────────────────
  if (existsSync(PID_FILE)) {
    const oldPid = readFileSync(PID_FILE, "utf8").trim();
    let isAlive = false;
    try { process.kill(Number(oldPid), 0); isAlive = true; } catch {}

    if (isAlive) {
      console.log(`[daemon] Stopping old instance (PID: ${oldPid})...`);
      // Use taskkill /T to kill entire process tree (api/web/worker children)
      // SIGTERM alone only hits parent; children hold Prisma DLL locks
      spawnSync("taskkill", ["/T", "/F", "/PID", oldPid], { shell: false, stdio: "ignore" });
      // Wait for ports and file locks to release
      await new Promise((r) => setTimeout(r, 3000));
    }
    try { unlinkSync(PID_FILE); } catch {}
  }
  // ── Launch detached child ────────────────────────────────────────────────
  // Safety net: also kill any processes on our ports (handles stale PID / manual kills)
  const webPort = env.WEB_PORT || "3000";
  killPort(apiPort);
  killPort(webPort);
  await new Promise((r) => setTimeout(r, 1000));

  const args = process.argv.slice(1).filter((a) => a !== "--daemon");
  const logPath = join(LOGS_DIR, "daemon.log");
  mkdirSync(LOGS_DIR, { recursive: true });

  const { openSync } = await import("node:fs");
  const outFd = openSync(logPath, "a");

  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    cwd: ROOT,
    env: { ...process.env, GFA_DAEMON: "1" },
  });
  child.unref();

  writeFileSync(PID_FILE, String(child.pid), "utf8");
  console.log(`[daemon] Launching in background (PID: ${child.pid})...`);

  // ── Health check: poll API until ready or timeout ────────────────────────
  const healthUrl = `http://127.0.0.1:${apiPort}/api/health`;
  const maxWaitMs = 90_000;
  const pollMs = 2_000;
  const start = Date.now();
  let ready = false;

  // Wait a bit for build + boot
  await new Promise((r) => setTimeout(r, 3000));

  while (Date.now() - start < maxWaitMs) {
    // Check if child died
    try { process.kill(child.pid, 0); } catch {
      console.log(`\n[daemon] ❌ Process exited unexpectedly.`);
      console.log(`[daemon] Check logs: ${logPath}`);
      try { unlinkSync(PID_FILE); } catch {}
      process.exit(1);
    }

    // Poll health
    try {
      const http = await import("node:http");
      const ok = await new Promise((resolve) => {
        const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ok) { ready = true; break; }
    } catch { /* retry */ }

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[daemon] Waiting for services... ${elapsed}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (ready) {
    console.log(`\n[daemon] ✅ All services started successfully (PID: ${child.pid})`);
    console.log(`[daemon] Logs: ${logPath}`);
    console.log(`[daemon] Stop: pnpm start:stop`);
  } else {
    console.log(`\n[daemon] ⚠️  Timed out waiting for health check (${maxWaitMs / 1000}s)`);
    console.log(`[daemon] Services may still be starting. Check logs: ${logPath}`);
  }
  process.exit(0);
}

// ── Read .env ─────────────────────────────────────────────────────────────────
function readEnv() {
  const envPath = resolve(ROOT, ".env");
  const env = {};
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ── Kill port occupying processes (Windows) ──────────────────────────────────
function killPort(port) {
  const result = spawnSync(
    "cmd",
    ["/c", `netstat -ano | findstr :${port}`],
    { encoding: "utf8", shell: false }
  );
  if (!result.stdout) return;

  const pids = new Set();
  for (const line of result.stdout.split("\n")) {
    const m = line.match(/\s+(\d+)\s*$/);
    if (m && line.includes(`:${port}`)) pids.add(m[1]);
  }

  for (const pid of pids) {
    if (pid === "0") continue;
    spawnSync("taskkill", ["/F", "/PID", pid], { shell: false });
    console.log(`[start] Killed PID ${pid} on port ${port}`);
  }
}

async function killOccupiedPorts(ports) {
  console.log(`[start] Checking ports: ${ports.join(", ")}...`);
  for (const port of ports) killPort(port);
  await new Promise((r) => setTimeout(r, 500));
}

// ── Log writer with daily rotation ───────────────────────────────────────────
class DailyLogWriter {
  constructor(serviceName) {
    this.serviceName = serviceName;
    this.currentDate = null;
    this.stream = null;
  }

  _ensureStream() {
    const d = today();
    if (this.currentDate === d && this.stream) return;

    if (this.stream) {
      this.stream.end();
    }

    this.currentDate = d;
    const logPath = join(LOGS_DIR, `${this.serviceName}-${d}.log`);
    // Append mode so we don't lose data on restart within same day
    this.stream = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  }

  write(text) {
    this._ensureStream();
    // Add timestamp prefix to each line
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        this.stream.write(`[${timestamp()}] ${line}\n`);
      }
    }
  }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

// ── Color helpers ─────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function banner(env) {
  const webPort = env.WEB_PORT || "3000";
  const apiPort = env.API_PORT || "3001";
  const adminPath = (env.ADMIN_PATH_PREFIX || "console").replace(
    /^\/|\/$/g,
    ""
  );
  const baseUrl = `http://localhost:${webPort}`;
  const apiUrl = `http://localhost:${apiPort}`;
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - stripAnsi(s).length));

  const w = 62;
  const line = "─".repeat(w);

  console.log(`\n${c.green}${c.bold}┌${line}┐${c.reset}`);
  console.log(
    `${c.green}│${c.reset}${c.bold}${"  🚀  GFA Production — All Services Ready".padEnd(w + 2)}${c.reset}${c.green}│${c.reset}`
  );
  console.log(`${c.green}├${line}┤${c.reset}`);
  console.log(
    `${c.green}│${c.reset}${c.bold}${"  Services".padEnd(w + 2)}${c.reset}${c.green}│${c.reset}`
  );
  console.log(
    `${c.green}│${c.reset}  ${pad(c.dim + "Public Portal" + c.reset, 18 + 8)}${c.cyan}${baseUrl}/${c.reset}`
  );
  console.log(
    `${c.green}│${c.reset}  ${pad(c.dim + "Admin Console" + c.reset, 18 + 8)}${c.cyan}${baseUrl}/${adminPath}/login${c.reset}`
  );
  console.log(
    `${c.green}│${c.reset}  ${pad(c.dim + "API Health" + c.reset, 18 + 8)}${c.cyan}${apiUrl}/api/health${c.reset}`
  );
  console.log(`${c.green}├${line}┤${c.reset}`);
  console.log(
    `${c.green}│${c.reset}${c.bold}${"  Logs".padEnd(w + 2)}${c.reset}${c.green}│${c.reset}`
  );
  console.log(
    `${c.green}│${c.reset}  ${c.dim}Directory${c.reset}  ${c.cyan}${LOGS_DIR}${c.reset}`
  );
  console.log(`${c.green}└${line}┘${c.reset}\n`);
}

// ── Preflight checks ─────────────────────────────────────────────────────────
function checkBuildArtifacts() {
  const skipBuild = process.argv.includes("--no-build");

  if (skipBuild) {
    // Only verify artifacts exist when skipping build
    const required = [
      { path: join(ROOT, "apps/server/dist/main.js"), name: "API" },
      { path: join(ROOT, "apps/worker/dist/index.js"), name: "Worker" },
      { path: join(ROOT, "apps/web/.next/BUILD_ID"), name: "Web" },
    ];
    const missing = required.filter((r) => !existsSync(r.path));
    if (missing.length > 0) {
      console.error(
        `${c.red}[start] Build artifacts missing: ${missing.map((m) => m.name).join(", ")}. Run without --no-build.${c.reset}`
      );
      process.exit(1);
    }
    console.log(`${c.dim}[start] --no-build: skipping build step${c.reset}`);
    return true;
  }

  // Always rebuild to ensure latest code is compiled
  console.log(
    `${c.cyan}[start] Building all services (use --no-build to skip)...${c.reset}\n`
  );

  const buildResult = spawnSync("pnpm", ["build"], {
    cwd: ROOT,
    shell: process.platform === "win32",
    stdio: "inherit",
    env: { ...process.env, ...readEnv() },
  });

  if (buildResult.status !== 0) {
    console.error(
      `${c.red}[start] Build failed. Please fix errors and retry.${c.reset}`
    );
    process.exit(1);
  }

  return true;
}

// ── Service definitions ──────────────────────────────────────────────────────
function getServices(env) {
  const webPort = env.WEB_PORT || "3000";
  const apiPort = env.API_PORT || "3001";
  const nextCli = join(
    ROOT,
    "apps/web/node_modules/next/dist/bin/next"
  );

  return [
    {
      name: "api",
      label: "api   ",
      command: "node",
      args: ["dist/main.js"],
      cwd: join(ROOT, "apps/server"),
      readyPattern: /\[api\] listening/i,
      port: apiPort,
    },
    {
      name: "worker",
      label: "worker",
      command: "node",
      args: ["dist/index.js"],
      cwd: join(ROOT, "apps/worker"),
      readyPattern: /\[worker-\d+\].*ready|worker is running/i,
      optional: true,
    },
    {
      name: "web",
      label: "web   ",
      command: "node",
      args: [nextCli, "start", "-p", String(webPort)],
      cwd: join(ROOT, "apps/web"),
      readyPattern: /Ready in|started server on/i,
      port: webPort,
    },
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const env = readEnv();
  const webPort = env.WEB_PORT || "3000";
  const apiPort = env.API_PORT || "3001";
  const isDaemon = process.env.GFA_DAEMON === "1";

  console.log(`${c.cyan}${c.bold}[start] GFA Production Launcher${isDaemon ? " (daemon)" : ""}${c.reset}`);
  console.log(`${c.gray}[start] ${timestamp()}${c.reset}\n`);

  // Write PID file for the main process (if launched as daemon, parent already wrote it)
  if (!isDaemon) {
    writeFileSync(PID_FILE, String(process.pid), "utf8");
  }

  // Prepare logs directory
  mkdirSync(LOGS_DIR, { recursive: true });

  // Kill occupied ports FIRST — old node processes lock Prisma DLL files
  await killOccupiedPorts([webPort, apiPort]);

  // Preflight (build if needed — must run AFTER port cleanup to avoid DLL locks)
  checkBuildArtifacts();

  // Merge .env into child env
  const childEnv = { ...process.env, ...env, NODE_ENV: "production" };

  const services = getServices(env);
  const procs = [];
  const logWriters = [];
  let allReadyPrinted = false;
  const readySet = new Set();
  const OPTIONAL_TIMEOUT_MS = 20_000;

  function checkAllReady() {
    if (allReadyPrinted) return;

    const requiredDone = services
      .filter((s) => !s.optional)
      .every((s) => readySet.has(s.name));

    if (requiredDone) {
      allReadyPrinted = true;
      banner(env);
    }
  }

  for (const svc of services) {
    const logger = new DailyLogWriter(svc.name);
    logWriters.push(logger);

    const proc = spawn(svc.command, svc.args, {
      cwd: svc.cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      env: childEnv,
    });

    procs.push(proc);

    const prefix = `${c.gray}[${svc.label}]${c.reset} `;
    let isReady = false;

    const onData = (chunk) => {
      const text = chunk.toString();

      // Write to log file
      logger.write(text);

      // Print to terminal with prefix
      for (const line of text.split("\n")) {
        if (line.trim()) process.stdout.write(prefix + line + "\n");
      }

      // Check ready signal
      if (!isReady && svc.readyPattern.test(text)) {
        isReady = true;
        readySet.add(svc.name);
        console.log(
          `${c.green}✓ ${svc.label.trim()} ready${c.reset}`
        );
        checkAllReady();
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("exit", (code) => {
      logger.close();
      if (code !== 0 && code !== null) {
        console.error(
          `${c.red}[${svc.label.trim()}] exited with code ${code}${c.reset}`
        );
      }
    });

    // Auto-mark optional services as ready after timeout
    if (svc.optional) {
      setTimeout(() => {
        if (!readySet.has(svc.name)) {
          readySet.add(svc.name);
          checkAllReady();
        }
      }, OPTIONAL_TIMEOUT_MS);
    }
  }

  // Graceful shutdown on Ctrl+C
  const shutdown = () => {
    console.log(`\n${c.yellow}[start] Shutting down all services...${c.reset}`);
    for (const proc of procs) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }
    for (const lw of logWriters) {
      lw.close();
    }
    // Force exit after 5s if processes don't stop
    setTimeout(() => {
      console.log(`${c.red}[start] Force exit.${c.reset}`);
      process.exit(1);
    }, 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // On Windows, handle Ctrl+C via SIGINT (already covered above)
  // Also handle process exit to clean up log writers and PID file
  process.on("exit", () => {
    for (const lw of logWriters) {
      lw.close();
    }
    try { unlinkSync(PID_FILE); } catch {}
  });
})();
