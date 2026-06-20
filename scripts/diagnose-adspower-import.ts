import { Queue } from "bullmq";
import * as fs from "node:fs";
import * as path from "node:path";

import { AgentAccountService } from "../apps/server/src/google-family/automation/agent-account.service";
import { AutomationService } from "../apps/server/src/google-family/automation/automation.service";
import { PrismaService } from "../apps/server/src/shared/prisma/prisma.service";
import { RosettaService } from "../apps/server/src/leasing/rosetta/rosetta.service";
import { QUEUE_NAMES } from "../packages/shared/src";
import {
  parseCredentialLine,
  type RosettaAdspowerCredential,
} from "../apps/web/src/lib/console/rosetta-adspower-parser";

type CliOptions = {
  credentialFile?: string;
  line?: string;
  pollMs: number;
  timeoutMs: number;
  stallMs: number;
  noSubmit: boolean;
};

type TaskSnapshot = {
  id: string;
  status: string;
  type: string;
  source: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  payload: string;
  logs: Array<{ level: string; message: string; createdAt: Date }>;
};

const TERMINAL_ITEM_STATUSES = new Set(["success", "failed"]);
const TERMINAL_TASK_STATUSES = new Set([
  "SUCCESS",
  "FAILED_FINAL",
  "MANUAL_REVIEW",
  "CANCELLED",
]);

function usage(): string {
  return [
    "Usage:",
    "  $env:TSX_TSCONFIG_PATH='apps/server/tsconfig.json'",
    "  pnpm exec tsx scripts/diagnose-adspower-import.ts --credential-file .tmp/adspower-credential.txt",
    "",
    "Options:",
    "  --credential-file <path>  File containing one ADS credential line",
    "  --line <text>            Inline credential line (avoid for real secrets)",
    "  --poll-ms <ms>           Poll interval, default 3000",
    "  --timeout-ms <ms>        Max wait, default 900000",
    "  --stall-ms <ms>          No-progress threshold, default 120000",
    "  --no-submit              Parse and inspect environment only",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    pollMs: 3000,
    timeoutMs: 15 * 60 * 1000,
    stallMs: 2 * 60 * 1000,
    noSubmit: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--credential-file") {
      opts.credentialFile = requireValue(arg, next);
      i++;
    } else if (arg === "--line") {
      opts.line = requireValue(arg, next);
      i++;
    } else if (arg === "--poll-ms") {
      opts.pollMs = Number(requireValue(arg, next));
      i++;
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = Number(requireValue(arg, next));
      i++;
    } else if (arg === "--stall-ms") {
      opts.stallMs = Number(requireValue(arg, next));
      i++;
    } else if (arg === "--no-submit") {
      opts.noSubmit = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (!Number.isFinite(opts.pollMs) || opts.pollMs < 500) {
    throw new Error("--poll-ms must be >= 500");
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be >= 1000");
  }
  if (!Number.isFinite(opts.stallMs) || opts.stallMs < opts.pollMs) {
    throw new Error("--stall-ms must be >= --poll-ms");
  }

  return opts;
}

function requireValue(flag: string, value?: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function loadCredentialLine(opts: CliOptions): string {
  if (opts.line) return opts.line.trim();
  if (!opts.credentialFile) {
    throw new Error(`Missing --credential-file\n\n${usage()}`);
  }
  const filePath = path.resolve(opts.credentialFile);
  const line = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#"));
  if (!line) throw new Error(`No credential line found in ${filePath}`);
  return line;
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return mask(email);
  if (name.length <= 2) return `${name[0] ?? ""}***@${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
}

function mask(value?: string): string {
  if (!value) return "missing";
  if (value.length <= 8) return `${value.slice(0, 1)}***(${value.length})`;
  return `${value.slice(0, 4)}...${value.slice(-4)}(${value.length})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(value: string): Record<string, any> {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function sanitizeTaskPayload(payload: string): Record<string, any> {
  const parsed = safeJsonParse(payload);
  const token = parsed.token || parsed.result || {};
  return {
    action: parsed.action,
    email: parsed.email ? maskEmail(String(parsed.email)) : undefined,
    childEmail: parsed.childEmail ? maskEmail(String(parsed.childEmail)) : undefined,
    profileId: parsed.profileId,
    source: parsed.source,
    hasResult: Boolean(parsed.result),
    hasToken: Boolean(parsed.token || parsed.result?.refresh_token || parsed.result?.refreshToken),
    hasRefreshToken: Boolean(token.refresh_token || token.refreshToken),
    restrictedAge: Boolean(parsed.restrictedAge),
    projectId: parsed.projectId ? mask(String(parsed.projectId)) : undefined,
  };
}

function summarizeCredential(credential: RosettaAdspowerCredential) {
  return {
    email: maskEmail(credential.email),
    password: mask(credential.password),
    recoveryEmail: credential.recoveryEmail
      ? maskEmail(credential.recoveryEmail)
      : "missing",
    totpSecret: mask(credential.totpSecret),
    phones: credential.phones?.map((phone) => ({
      phoneNumber: mask(phone.phoneNumber),
      smsUrl: phone.smsUrl ? "present" : "missing",
    })) ?? [],
  };
}

function progressSignature(task: TaskSnapshot | null, batch: any): string {
  const item = Array.isArray(batch?.items) ? batch.items[0] : undefined;
  const lastLog = task?.logs?.[task.logs.length - 1];
  return JSON.stringify({
    itemStatus: item?.status,
    itemMessage: item?.message,
    itemError: item?.error,
    taskStatus: task?.status,
    taskErrorCode: task?.lastErrorCode,
    taskErrorMessage: task?.lastErrorMessage,
    logCount: task?.logs?.length ?? 0,
    lastLogAt: lastLog?.createdAt?.toISOString?.(),
    lastLogMessage: lastLog?.message,
  });
}

async function getTask(prisma: PrismaService, taskId?: string): Promise<TaskSnapshot | null> {
  if (!taskId) return null;
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      logs: {
        orderBy: { createdAt: "asc" },
        take: 200,
      },
    },
  });
  return task as TaskSnapshot | null;
}

async function printQueueDiagnostics(queue: Queue) {
  const [counts, workers] = await Promise.all([
    queue.getJobCounts("waiting", "active", "delayed", "completed", "failed", "paused"),
    queue.getWorkers().catch(() => []),
  ]);
  console.log("[queue]", {
    name: QUEUE_NAMES.automation,
    counts,
    workers: workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      addr: worker.addr,
      ageMs: worker.age,
    })),
  });
}

async function printJobDiagnostics(queue: Queue, taskId?: string) {
  if (!taskId) return;
  const job = await queue.getJob(`automation-${taskId}`);
  if (!job) {
    console.log("[queue-job]", { taskId, found: false });
    return;
  }
  const state = await job.getState();
  console.log("[queue-job]", {
    taskId,
    jobId: job.id,
    name: job.name,
    state,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  });
}

async function printAgentAccountDiagnostics(prisma: PrismaService, email: string) {
  const account = await prisma.agentAccount.findUnique({
    where: { loginEmail: email },
    select: {
      id: true,
      loginEmail: true,
      status: true,
      pool: true,
      banned: true,
      lastTaskId: true,
      refreshToken: true,
      tokenObtainedAt: true,
      recoveryEmail: true,
      totpSecret: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!account) {
    console.log("[agent-account]", { email: maskEmail(email), found: false });
    return;
  }

  console.log("[agent-account]", {
    id: account.id,
    email: maskEmail(account.loginEmail),
    status: account.status,
    pool: account.pool,
    banned: account.banned,
    lastTaskId: account.lastTaskId,
    hasRefreshToken: Boolean(account.refreshToken),
    tokenObtainedAt: account.tokenObtainedAt,
    hasRecoveryEmail: Boolean(account.recoveryEmail),
    hasTotpSecret: Boolean(account.totpSecret),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
}

async function printExistingTaskDiagnostics(prisma: PrismaService, email: string) {
  const tasks = await prisma.task.findMany({
    where: {
      type: "OAUTH_AUTHORIZE" as any,
      status: { in: ["PENDING", "RUNNING"] as any },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const matching = tasks.filter((task) => safeJsonParse(task.payload).email === email);
  console.log("[dedupe-check]", {
    email: maskEmail(email),
    activeOauthTasksForEmail: matching.map((task) => ({
      id: task.id,
      status: task.status,
      source: task.source,
      createdAt: task.createdAt,
      payload: sanitizeTaskPayload(task.payload),
    })),
  });
}

async function printAdsPowerDiagnostics() {
  const host = process.env.ADSPOWER_HOST || "http://127.0.0.1:50325";
  const apiKey = process.env.ADSPOWER_API_KEY || "";
  const poolIds = String(process.env.ADSPOWER_POOL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log("[adspower-config]", {
    host,
    apiKey: mask(apiKey),
    poolCount: poolIds.length,
    poolIds,
  });

  if (!poolIds.length) return;

  const statuses: Array<Record<string, unknown>> = [];
  const checkedPoolIds = poolIds.slice(0, 20);
  for (let i = 0; i < checkedPoolIds.length; i++) {
    const profileId = checkedPoolIds[i];
    if (i > 0) await sleep(800);
    try {
      const url = new URL("/api/v1/browser/active", host);
      if (apiKey) url.searchParams.set("api_key", apiKey);
      url.searchParams.set("user_id", profileId);
      const res = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(3000),
      });
      const body = await res.json().catch(() => null);
      statuses.push({
        profileId,
        httpStatus: res.status,
        code: body?.code,
        msg: body?.msg,
        status: body?.data?.status,
      });
    } catch (err) {
      statuses.push({
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  console.log("[adspower-profiles]", statuses);
}

function printTaskSnapshot(task: TaskSnapshot | null) {
  if (!task) {
    console.log("[task]", { found: false });
    return;
  }
  const logs = task.logs.slice(-12).map((log) => ({
    at: log.createdAt,
    level: log.level,
    message: log.message,
  }));
  console.log("[task]", {
    id: task.id,
    type: task.type,
    status: task.status,
    source: task.source,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    lastErrorCode: task.lastErrorCode,
    lastErrorMessage: task.lastErrorMessage,
    payload: sanitizeTaskPayload(task.payload),
    recentLogs: logs,
  });
}

function analyzeStop(batch: any, task: TaskSnapshot | null, reason: string) {
  const item = Array.isArray(batch?.items) ? batch.items[0] : undefined;
  const logs = task?.logs ?? [];
  const lastLog = logs[logs.length - 1];
  const messages = logs.map((log) => log.message).join("\n");

  let likelyStage = "unknown";
  if (!item?.taskId) {
    likelyStage = "import-submit/ensure-agent-account";
  } else if (!task) {
    likelyStage = "task-created-but-not-readable";
  } else if (task.status === "PENDING") {
    likelyStage = "queue-waiting-or-worker-not-consuming";
  } else if (/AdsPower|profile|browser/i.test(messages)) {
    likelyStage = "adspower-profile-or-browser";
  } else if (/login|password|captcha|challenge|TOTP|recovery/i.test(messages)) {
    likelyStage = "google-login-or-challenge";
  } else if (/OAuth|Token exchange|authorization code/i.test(messages)) {
    likelyStage = "oauth-token-exchange";
  } else if (item?.status === "failed" && /入池|Rosetta|Token/i.test(String(item.error || ""))) {
    likelyStage = "upload-to-rosetta";
  }

  console.log("[stop-analysis]", {
    reason,
    likelyStage,
    batchStatus: batch?.status,
    itemStatus: item?.status,
    itemMessage: item?.message,
    itemError: item?.error,
    taskStatus: task?.status,
    lastErrorCode: task?.lastErrorCode,
    lastErrorMessage: task?.lastErrorMessage,
    lastLog: lastLog
      ? {
          at: lastLog.createdAt,
          level: lastLog.level,
          message: lastLog.message,
        }
      : null,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawLine = loadCredentialLine(opts);
  const credential = parseCredentialLine(rawLine);
  if (!credential) {
    throw new Error("Credential line could not be parsed by the ADS parser");
  }

  console.log("[input]", summarizeCredential(credential));

  const queue = new Queue(QUEUE_NAMES.automation, {
    connection: {
      url: process.env.REDIS_URL || "redis://localhost:6379",
      maxRetriesPerRequest: null,
    } as any,
  });
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const automation = new AutomationService(prisma, queue);
  const agentAccounts = new AgentAccountService(prisma, queue);
  const rosetta = new RosettaService(
    {},
    automation,
    agentAccounts,
    undefined,
    prisma,
  );

  try {
    await printAdsPowerDiagnostics();
    await printQueueDiagnostics(queue);
    await printExistingTaskDiagnostics(prisma, credential.email);
    await printAgentAccountDiagnostics(prisma, credential.email);

    if (opts.noSubmit) {
      console.log("[no-submit] Diagnostics completed without creating a task.");
      return;
    }

    const start = await rosetta.adspowerImport({ credentials: [credential] });
    console.log("[import-submit]", start);
    if (!start?.ok || !start?.batchId) {
      analyzeStop(start, null, "submit-failed");
      return;
    }

    const startedAt = Date.now();
    let lastProgressAt = Date.now();
    let lastSignature = "";
    let lastBatch: any = null;
    let lastTask: TaskSnapshot | null = null;

    while (Date.now() - startedAt < opts.timeoutMs) {
      const batch = await rosetta.adspowerImportStatus(start.batchId);
      const item = Array.isArray(batch?.items) ? batch.items[0] : undefined;
      const task = await getTask(prisma, item?.taskId);
      const signature = progressSignature(task, batch);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastProgressAt = Date.now();
        console.log("[progress]", {
          elapsedMs: Date.now() - startedAt,
          batchStatus: batch?.status,
          itemStatus: item?.status,
          itemMessage: item?.message,
          itemError: item?.error,
          taskId: item?.taskId,
          taskStatus: task?.status,
          taskLastErrorCode: task?.lastErrorCode,
          taskLastErrorMessage: task?.lastErrorMessage,
          logCount: task?.logs?.length ?? 0,
          lastLog: task?.logs?.[task.logs.length - 1]?.message,
        });
      }

      lastBatch = batch;
      lastTask = task;

      if (item?.status && TERMINAL_ITEM_STATUSES.has(item.status)) {
        await printJobDiagnostics(queue, item.taskId);
        printTaskSnapshot(task);
        await printAgentAccountDiagnostics(prisma, credential.email);
        analyzeStop(batch, task, item.status === "success" ? "completed" : "terminal-failed");
        return;
      }

      if (task?.status && TERMINAL_TASK_STATUSES.has(task.status) && item?.status !== "success") {
        await printJobDiagnostics(queue, item?.taskId);
        printTaskSnapshot(task);
        await printAgentAccountDiagnostics(prisma, credential.email);
        analyzeStop(batch, task, "task-terminal-before-batch-success");
        return;
      }

      if (Date.now() - lastProgressAt >= opts.stallMs) {
        await printQueueDiagnostics(queue);
        await printJobDiagnostics(queue, item?.taskId);
        printTaskSnapshot(task);
        await printAgentAccountDiagnostics(prisma, credential.email);
        analyzeStop(batch, task, `no-progress-for-${opts.stallMs}ms`);
        process.exitCode = 2;
        return;
      }

      await sleep(opts.pollMs);
    }

    await printQueueDiagnostics(queue);
    await printJobDiagnostics(queue, lastBatch?.items?.[0]?.taskId);
    printTaskSnapshot(lastTask);
    await printAgentAccountDiagnostics(prisma, credential.email);
    analyzeStop(lastBatch, lastTask, `timeout-after-${opts.timeoutMs}ms`);
    process.exitCode = 2;
  } finally {
    await queue.close().catch(() => undefined);
    await prisma.onModuleDestroy().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
