#!/usr/bin/env node
/**
 * scripts/dev.mjs
 *
 * Dev launcher — runs all services in parallel, waits for their
 * ready signals, then prints a unified startup summary banner.
 *
 * Ready signals (matched in stdout / stderr):
 *   api    → "[api] listening"
 *   web    → "✓ Ready in"
 *   worker → "[worker-1] ready" | "Worker is running"
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Kill any process occupying the given ports (Windows) ──────────────────────
function killPort(port) {
  // netstat -ano | findstr :PORT  → find PID
  const result = spawnSync(
    "cmd",
    ["/c", `netstat -ano | findstr :${port}`],
    { encoding: "utf8", shell: false }
  );
  if (!result.stdout) return;

  const pids = new Set();
  for (const line of result.stdout.split("\n")) {
    // Match lines like "TCP  0.0.0.0:3001  ... LISTENING  1234"
    const m = line.match(/\s+(\d+)\s*$/);
    if (m && line.includes(`:${port}`)) pids.add(m[1]);
  }

  for (const pid of pids) {
    if (pid === "0") continue;
    spawnSync("taskkill", ["/F", "/PID", pid], { shell: false });
    console.log(`[dev] Killed PID ${pid} on port ${port}`);
  }
}

async function killOccupiedPorts(ports) {
  console.log(`[dev] Checking ports: ${ports.join(", ")}...`);
  for (const port of ports) killPort(port);
  // Brief pause so OS releases the ports before spawn
  await new Promise((r) => setTimeout(r, 500));
}

// ── Read .env for dynamic config ──────────────────────────────────────────────
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
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// ── Color helpers ─────────────────────────────────────────────────────────────
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  gray:   "\x1b[90m",
};

function banner(env) {
  const webPort    = env.WEB_PORT    || "3000";
  const apiPort    = env.API_PORT    || "3001";
  const adminPath  = (env.ADMIN_PATH_PREFIX || "console").replace(/^\/|\/$/g, "");
  const baseUrl    = `http://localhost:${webPort}`;
  const apiUrl     = `http://localhost:${apiPort}`;

  const w = 62;
  const line = "─".repeat(w);
  const pad  = (s, n) => s + " ".repeat(Math.max(0, n - stripAnsi(s).length));
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const row = (label, value, color = c.cyan) =>
    `│  ${c.bold}${pad(label, 18)}${c.reset}${color}${value}${c.reset}`;

  console.log(`\n${c.green}${c.bold}┌${line}┐${c.reset}`);
  console.log(`${c.green}│${c.reset}${c.bold}${"  🚀  GFA Dev Server — All Services Ready".padEnd(w + 2)}${c.reset}${c.green}│${c.reset}`);
  console.log(`${c.green}├${line}┤${c.reset}`);
  console.log(`${c.green}│${c.reset}${c.bold}${"  Services".padEnd(w + 2)}${c.reset}${c.green}│${c.reset}`);
  console.log(`${c.green}│${c.reset}  ${pad(c.dim + "Public Portal" + c.reset,   18 + 8)}${c.cyan}${baseUrl}/${c.reset}`);
  console.log(`${c.green}│${c.reset}  ${pad(c.dim + "Status Page" + c.reset,     18 + 8)}${c.cyan}${baseUrl}/status${c.reset}`);
  console.log(`${c.green}│${c.reset}  ${pad(c.dim + "Admin Console" + c.reset,   18 + 8)}${c.cyan}${baseUrl}/${adminPath}/login${c.reset}`);
  console.log(`${c.green}│${c.reset}  ${pad(c.dim + "API Health" + c.reset,      18 + 8)}${c.cyan}${apiUrl}/api/health${c.reset}`);
  console.log(`${c.green}├${line}┤${c.reset}`);
  console.log(`${c.green}│${c.reset}${c.bold}${"  Default Accounts".padEnd(w + 2)}${c.reset}${c.green}│${c.reset}`);
  console.log(`${c.green}│${c.reset}  ${pad(c.dim + "Admin" + c.reset,           18 + 8)}${c.yellow}admin@gfa.local${c.reset}  /  ${c.yellow}admin123${c.reset}`);
  console.log(`${c.green}│${c.reset}  ${pad(c.dim + "Support" + c.reset,         18 + 8)}${c.yellow}support@gfa.local${c.reset}  /  ${c.yellow}admin123${c.reset}`);
  console.log(`${c.green}└${line}┘${c.reset}\n`);
}

// ── Services config ───────────────────────────────────────────────────────────
const services = [
  {
    name: "shared",
    label: "shared",
    filter: "@gfa/shared",
    ready: /compiled|watching|done/i,
    optional: true,   // shared may not print a clear ready signal
  },
  {
    name: "api",
    label: "api   ",
    filter: "@gfa/server",
    ready: /\[api\] listening/i,
  },
  {
    name: "web",
    label: "web   ",
    filter: "@gfa/web",
    ready: /✓ Ready in/,
  },
  {
    name: "worker",
    label: "worker",
    filter: "@gfa/worker",
    ready: /\[worker-\d+\].*ready|worker is running/i,
    optional: true,   // worker may not have a clear ready signal in all configs
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const env = readEnv();

  // Kill any processes occupying our ports before starting
  const webPort = env.WEB_PORT || "3000";
  const apiPort = env.API_PORT || "3001";
  await killOccupiedPorts([webPort, apiPort]);

  // Auto-seed DB (idempotent — safe to run on every startup)
  console.log(`[dev] Ensuring database is seeded...`);
  const seedResult = spawnSync("node", ["scripts/seed.mjs"], {
    cwd: ROOT,
    shell: false,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (seedResult.status !== 0) {
    console.warn("[dev] db:seed exited non-zero — check DB init");
  }

  // Merge root .env into process.env so child processes inherit all vars.
  // This ensures Next.js middleware, NestJS, and Worker all see the same config.
  const childEnv = { ...process.env, ...env };

  const procs = [];
  let allReadyPrinted = false;
  const readySet = new Set();

  // Give optional services a timeout to auto-mark as ready
  const OPTIONAL_TIMEOUT_MS = 15_000;

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
    const proc = spawn(
      "pnpm",
      ["--filter", svc.filter, "dev"],
      {
        cwd: ROOT,
        shell: true,
        env: childEnv,   // inject root .env vars
      }
    );

    procs.push(proc);

    const prefix = `${c.gray}[${svc.label}]${c.reset} `;
    let isReady = false;

    const onData = (chunk) => {
      const text = chunk.toString();
      // Print each line with service prefix
      for (const line of text.split("\n")) {
        if (line.trim()) process.stdout.write(prefix + line + "\n");
      }
      // Check ready signal
      if (!isReady && svc.ready.test(text)) {
        isReady = true;
        readySet.add(svc.name);
        console.log(`${c.green}✓ ${svc.label.trim()} ready${c.reset}`);
        checkAllReady();
      }
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`${c.yellow}[${svc.label.trim()}] exited with code ${code}${c.reset}`);
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

  // Forward Ctrl+C to all child processes
  process.on("SIGINT", () => {
    console.log("\n[dev] Shutting down all services...");
    for (const proc of procs) {
      proc.kill("SIGINT");
    }
    process.exit(0);
  });
})();
