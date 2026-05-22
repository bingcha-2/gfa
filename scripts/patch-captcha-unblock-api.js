#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const filePath = path.resolve(__dirname, "../apps/web/src/app/api/rosetta/[...path]/route.ts");
let content = fs.readFileSync(filePath, "utf8");
const hadCRLF = content.includes("\r\n");
content = content.replace(/\r\n/g, "\n");

// ── Step 1: Add captcha-unblock data file path ──
const dataPathInsertPoint = 'const EMPLOYEES_PATH = path.join(DATA_DIR, "employees.json");';
if (!content.includes("CAPTCHA_UNBLOCK_PATH")) {
  content = content.replace(
    dataPathInsertPoint,
    dataPathInsertPoint + '\nconst CAPTCHA_UNBLOCK_PATH = path.join(DATA_DIR, "captcha-unblock.json");'
  );
  console.log("✅ Added CAPTCHA_UNBLOCK_PATH");
} else {
  console.log("⏭ CAPTCHA_UNBLOCK_PATH already exists");
}

// ── Step 2: Add handler functions before the GET export ──
const handlerCode = `
// ─── Captcha Unblock (file-based state) ──────────────────────────────────

interface CaptchaUnblockTask {
  id: string;
  email: string;
  password: string;
  recoveryEmail: string;
  totpSecret: string;
  phase: "first" | "second";
  source: string;
  status: string; // PENDING | RUNNING | CAPTCHA_WAITING | PHONE_VERIFYING | APPEAL_REQUIRED | WAITING_SECOND_VERIFY | UNBLOCKED | FAILED_FINAL
  taskId?: string;
  usedPhone?: string;
  appealAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

function readCaptchaUnblockData(): { tasks: CaptchaUnblockTask[] } {
  if (!fs.existsSync(CAPTCHA_UNBLOCK_PATH)) return { tasks: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(CAPTCHA_UNBLOCK_PATH, "utf8"));
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

function writeCaptchaUnblockData(data: { tasks: CaptchaUnblockTask[] }) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAPTCHA_UNBLOCK_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function handleCaptchaUnblock(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const creds = payload.credentials || {};
    const email = normalizeEmail(creds.email);
    const password = String(creds.password || "");
    const recoveryEmail = String(creds.recoveryEmail || "");
    const totpSecret = String(creds.totpSecret || "");
    const phase = String(payload.phase || "first");
    const source = String(payload.source || "captcha-unblock");

    if (!email) return json({ ok: false, error: "email 不能为空" }, { status: 400 });
    if (!password) return json({ ok: false, error: "password 不能为空" }, { status: 400 });

    const data = readCaptchaUnblockData();

    // Create task
    const task: CaptchaUnblockTask = {
      id: newId("unblock"),
      email,
      password,
      recoveryEmail,
      totpSecret,
      phase: phase === "second" ? "second" : "first",
      source,
      status: "PENDING",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // For phase 2, try to find existing phase 1 task to get usedPhone
    if (phase === "second") {
      const existing = data.tasks.find(
        (t) => normalizeEmail(t.email) === email && t.usedPhone && t.status === "WAITING_SECOND_VERIFY"
      );
      if (existing) {
        task.usedPhone = existing.usedPhone;
        existing.status = "PHASE2_STARTED";
        existing.updatedAt = nowIso();
      }
    }

    data.tasks.unshift(task);
    // Keep last 500 tasks
    data.tasks = data.tasks.slice(0, 500);
    writeCaptchaUnblockData(data);

    // Submit to backend worker queue
    try {
      const automationPayload = {
        action: "oauth",
        credentials: { email, password, recoveryEmail, totpSecret },
        source: source,
        keepBrowserOpenOnChallenge: true,
        taskType: "OAUTH_AUTHORIZE",
      };
      const backendResp = await fetch(\`\${BACKEND_BASE_URL}/tasks/automation\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(automationPayload),
        signal: AbortSignal.timeout(10000),
      });
      const backendData = await backendResp.json().catch(() => ({}));
      if (backendData.taskId) {
        task.taskId = backendData.taskId;
        task.status = "RUNNING";
        task.updatedAt = nowIso();
        writeCaptchaUnblockData(data);
      }
    } catch (err: any) {
      console.warn("[captcha-unblock] Failed to submit to backend:", err.message);
    }

    return json({ ok: true, task: { id: task.id, email, status: task.status } });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

async function handleCaptchaUnblockStatus(): Promise<NextResponse> {
  const data = readCaptchaUnblockData();

  // Refresh status from backend for running tasks
  for (const task of data.tasks) {
    if (task.taskId && ["RUNNING", "PENDING"].includes(task.status)) {
      try {
        const resp = await fetch(\`\${BACKEND_BASE_URL}/tasks/\${task.taskId}\`, {
          signal: AbortSignal.timeout(5000),
        });
        const taskData = await resp.json().catch(() => null);
        if (taskData) {
          const backendStatus = String(taskData.status || "");
          if (backendStatus === "SUCCESS") {
            task.status = task.phase === "second" ? "UNBLOCKED" : "APPEAL_REQUIRED";
            task.updatedAt = nowIso();
          } else if (backendStatus === "MANUAL_REVIEW") {
            const code = String(taskData.lastErrorCode || "");
            if (code === "PHONE_VERIFIED_APPEAL_REQUIRED") {
              task.status = "APPEAL_REQUIRED";
              // Extract used phone from task payload
              try {
                const pl = JSON.parse(taskData.payload || "{}");
                if (pl.result?.usedPhone?.phoneNumber) {
                  task.usedPhone = pl.result.usedPhone.phoneNumber;
                }
              } catch {}
            } else if (code === "CAPTCHA") {
              task.status = "CAPTCHA_WAITING";
            } else {
              task.status = "MANUAL_REVIEW";
              task.lastErrorCode = code;
              task.lastErrorMessage = taskData.lastErrorMessage || "";
            }
            task.updatedAt = nowIso();
          } else if (backendStatus === "FAILED_FINAL" || backendStatus === "FAILED_RETRYABLE") {
            task.status = "FAILED_FINAL";
            task.lastErrorCode = taskData.lastErrorCode || "";
            task.lastErrorMessage = taskData.lastErrorMessage || "";
            task.updatedAt = nowIso();
          }
        }
      } catch {
        // silent
      }
    }
  }

  // Save updated statuses
  writeCaptchaUnblockData(data);

  // Split into active tasks and phase2 waiting
  const tasks = data.tasks.filter((t) => t.status !== "WAITING_SECOND_VERIFY");
  const phase2 = data.tasks.filter((t) => t.status === "WAITING_SECOND_VERIFY" || t.status === "APPEAL_REQUIRED");

  return json({ tasks, phase2 });
}

async function handleCaptchaUnblockRetry(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const taskId = String(payload.taskId || "");
    if (!taskId) return json({ ok: false, error: "taskId required" }, { status: 400 });

    const data = readCaptchaUnblockData();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return json({ ok: false, error: "Task not found" }, { status: 404 });

    // Re-submit
    task.status = "PENDING";
    task.lastErrorCode = undefined;
    task.lastErrorMessage = undefined;
    task.updatedAt = nowIso();

    try {
      const automationPayload = {
        action: "oauth",
        credentials: {
          email: task.email,
          password: task.password,
          recoveryEmail: task.recoveryEmail || "",
          totpSecret: task.totpSecret || "",
        },
        source: task.source || "captcha-unblock",
        keepBrowserOpenOnChallenge: true,
        taskType: "OAUTH_AUTHORIZE",
      };
      const resp = await fetch(\`\${BACKEND_BASE_URL}/tasks/automation\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(automationPayload),
        signal: AbortSignal.timeout(10000),
      });
      const result = await resp.json().catch(() => ({}));
      if (result.taskId) {
        task.taskId = result.taskId;
        task.status = "RUNNING";
      }
    } catch (err: any) {
      console.warn("[captcha-unblock] Retry submit failed:", err.message);
    }

    task.updatedAt = nowIso();
    writeCaptchaUnblockData(data);
    return json({ ok: true });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

`;

// Insert handler code before the GET export
const getExportLine = "export async function GET(";
const getExportIdx = content.indexOf(getExportLine);
if (getExportIdx < 0) { console.error("Cannot find GET export"); process.exit(1); }
if (!content.includes("handleCaptchaUnblock")) {
  content = content.slice(0, getExportIdx) + handlerCode + content.slice(getExportIdx);
  console.log("✅ Added captcha-unblock handler functions");
} else {
  console.log("⏭ Captcha unblock handlers already exist");
}

// ── Step 3: Add GET route case ──
if (!content.includes('case "/captcha-unblock/status"')) {
  content = content.replace(
    'case "/adspower-import-status":\n      return handleAdspowerImportStatus(req);\n    case "/adspower-import-history":\n      return handleAdspowerImportHistory(req);',
    'case "/captcha-unblock/status":\n      return handleCaptchaUnblockStatus();\n    case "/adspower-import-status":\n      return handleAdspowerImportStatus(req);\n    case "/adspower-import-history":\n      return handleAdspowerImportHistory(req);'
  );
  console.log("✅ Added captcha-unblock/status GET route");
} else {
  console.log("⏭ GET route already exists");
}

// ── Step 4: Add POST route cases ──
if (!content.includes('case "/captcha-unblock"')) {
  content = content.replace(
    'case "/adspower-import":\n      return handleAdspowerImport(req);',
    'case "/captcha-unblock":\n      return handleCaptchaUnblock(req);\n    case "/captcha-unblock/retry":\n      return handleCaptchaUnblockRetry(req);\n    case "/adspower-import":\n      return handleAdspowerImport(req);'
  );
  console.log("✅ Added captcha-unblock POST routes");
} else {
  console.log("⏭ POST routes already exist");
}

// Restore CRLF
if (hadCRLF) content = content.replace(/\n/g, "\r\n");
fs.writeFileSync(filePath, content, "utf8");
console.log("\n🎉 route.ts patched with captcha-unblock endpoints!");
