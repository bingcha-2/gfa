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
import { existsSync, readFileSync, mkdirSync, createWriteStream } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOGS_DIR = join(ROOT, "logs");

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
      { path: join(ROOT, "apps/api/dist/main.js"), name: "API" },
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
      cwd: join(ROOT, "apps/api"),
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

  console.log(`${c.cyan}${c.bold}[start] GFA Production Launcher${c.reset}`);
  console.log(`${c.gray}[start] ${timestamp()}${c.reset}\n`);

  // Preflight
  checkBuildArtifacts();

  // Prepare logs directory
  mkdirSync(LOGS_DIR, { recursive: true });

  // Kill occupied ports
  await killOccupiedPorts([webPort, apiPort]);

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
  // Also handle process exit to clean up log writers
  process.on("exit", () => {
    for (const lw of logWriters) {
      lw.close();
    }
  });
})();
