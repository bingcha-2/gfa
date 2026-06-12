/**
 * Worker entry point.
 *
 * Initializes infrastructure (Prisma, Redis, AdsPower client, BrowserPool)
 * and registers BullMQ workers for each task queue.
 */

import { config } from "dotenv";
import * as path from "path";

// Load .env from repo root (pnpm --filter runs from apps/worker/)
config({ path: path.resolve(__dirname, "../../../.env") });

import { Job, Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";

import {
  InviteMemberPayload,
  RemoveMemberPayload,
  ReplaceMemberPayload,
  SyncFamilyGroupPayload,
  HealthCheckAccountPayload,
  AutomationPayload,
  Change2FAPayload,
  QUEUE_NAMES,
} from "@gfa/shared";

import { AdsPowerClient } from "./adspower-client";
import { BrowserPool } from "./browser-pool";
import { processInvite } from "./processors/invite.processor";
import { processRemove } from "./processors/remove.processor";
import { processReplace } from "./processors/replace.processor";
import { processSync } from "./processors/sync.processor";
import { processHealth } from "./processors/health.processor";
import { processAutomation } from "./processors/automation.processor";
import { processAgentReplace, processAgentMigrate, processRosettaFamilyJoin } from "./processors/agent-pool.processor";
import { processChange2FA } from "./processors/change-2fa.processor";
import { processBulk2FA } from "./processors/bulk-2fa.processor";

// ---- Configuration ----

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
// Use stable WORKER_NAME — NOT process.pid, which changes on every hot-reload.
// If pid-based lock was acquired, release would fail after reload (different pid = different token).
const hostname = (() => { try { return require("os").hostname(); } catch { return "worker"; } })();
const workerId = process.env.WORKER_NAME ?? `gfa-worker-${hostname}`;
const adspowerHost =
  process.env.ADSPOWER_HOST ?? "http://localhost:50325";
const adspowerApiKey = process.env.ADSPOWER_API_KEY || "72b3bff4dfd7dafca46046dd4c5c1992008379d6ce494bed";

// ---- Infrastructure ----

const redis = new Redis(redisUrl);
const prisma = new PrismaClient();
const adspower = new AdsPowerClient({
  baseUrl: adspowerHost,
  apiKey: adspowerApiKey || undefined,
});
const pool = new BrowserPool(redis);

const deps = { prisma, adspower, pool, workerId };

// BullMQ needs explicit connection options (not the ioredis instance).
// Parse the URL to extract host/port/password/db for BullMQ's own connections.
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port, 10) || 6379,
    password: parsed.password || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
  };
}

const connection = parseRedisUrl(redisUrl);

// Create a Queue instance for invite — needed by transfer batch callback
// to enqueue Phase 2 invite tasks from within the remove processor.
const inviteQueueRef = new Queue(QUEUE_NAMES.invite, { connection });
const syncQueueRef = new Queue(QUEUE_NAMES.sync, { connection });
const depsWithInviteQueue = { ...deps, inviteQueue: inviteQueueRef, syncQueue: syncQueueRef };

// ---- Workers ----

// Concurrency = pool size: each job needs an AdsPower profile, so there's no
// point dispatching more concurrent jobs than available profiles — extras would
// just spin in acquireForAccount() waiting for a free profile.
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKER_CONCURRENCY = Math.min(
  pool.poolSize,
  parsePositiveIntEnv("WORKER_CONCURRENCY", pool.poolSize)
);
const AUTOMATION_CONCURRENCY = Math.min(
  WORKER_CONCURRENCY,
  parsePositiveIntEnv("AUTOMATION_CONCURRENCY", Math.min(3, WORKER_CONCURRENCY))
);
console.log(
  `[${workerId}] Pool size: ${pool.poolSize}, worker concurrency: ${WORKER_CONCURRENCY}, ` +
    `automation concurrency: ${AUTOMATION_CONCURRENCY}`
);

const inviteWorker = new Worker<InviteMemberPayload>(
  QUEUE_NAMES.invite,
  (job) => processInvite(job, depsWithInviteQueue),
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000, // 10 min — heartbeat extends Redis locks up to 5 min, BullMQ lock must outlast
    stalledInterval: 120_000, // check every 2 min
  }
);

const removeWorker = new Worker<RemoveMemberPayload & { taskId: string }>(
  QUEUE_NAMES.remove,
  (job) => processRemove(job, depsWithInviteQueue),
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000,
    stalledInterval: 120_000,
  }
);

const replaceWorker = new Worker<ReplaceMemberPayload>(
  QUEUE_NAMES.replace,
  (job) => processReplace(job, depsWithInviteQueue),
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000,
    stalledInterval: 120_000,
  }
);

const syncWorker = new Worker<SyncFamilyGroupPayload>(
  QUEUE_NAMES.sync,
  (job) => processSync(job, deps),
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000,
    stalledInterval: 120_000,
  }
);

const healthWorker = new Worker<HealthCheckAccountPayload>(
  QUEUE_NAMES.health,
  (job) => processHealth(job, deps),
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000,
    stalledInterval: 120_000,
  }
);

const automationWorker = new Worker<AutomationPayload>(
  QUEUE_NAMES.automation,
  (job) => {
    // Route agent-pool compound tasks to their dedicated processors
    const action = (job.data as any)?.action;
    if (action === "agent-replace") return processAgentReplace(job as any, deps);
    if (action === "agent-migrate") return processAgentMigrate(job as any, deps);
    if (action === "family-join") return processRosettaFamilyJoin(job as any, deps);
    return processAutomation(job, deps);
  },
  {
    connection,
    concurrency: AUTOMATION_CONCURRENCY,
    lockDuration: 600_000, // 10 min — compound tasks with multiple logins need extra time
    stalledInterval: 120_000,
  }
);

const change2faWorker = new Worker<Change2FAPayload>(
  QUEUE_NAMES.change2fa,
  (job) => processChange2FA(job, deps),
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000,
    stalledInterval: 120_000,
  }
);

const bulk2faWorker = new Worker<{ jobId: string }>(
  QUEUE_NAMES.bulk2fa,
  (job) => processBulk2FA(job, deps),
  {
    connection,
    concurrency: 2,
    lockDuration: 1800_000,
    stalledInterval: 120_000,
  }
);

const workers = [
  inviteWorker,
  removeWorker,
  replaceWorker,
  syncWorker,
  healthWorker,
  automationWorker,
  change2faWorker,
  bulk2faWorker
];

// ---- Startup: clean up orphaned RUNNING tasks from previous crash ----
// If the worker crashed mid-task, the DB task stays in RUNNING forever.
// On restart, reset any RUNNING tasks to FAILED_RETRYABLE so they can be retried.
async function cleanupStalledTasks(): Promise<void> {
  const rosettaResult = await prisma.task.updateMany({
    where: {
      status: { in: ["RUNNING", "PENDING"] },
      OR: [
        { source: "rosetta-account-repair" },
        { payload: { contains: '"source":"rosetta-account-repair"' } },
      ],
    },
    data: {
      status: "FAILED_FINAL",
      lastErrorCode: "WORKER_RESTART",
      lastErrorMessage: `Worker ${workerId} restarted during Rosetta account repair - task will not be retried`,
    },
  });
  const result = await prisma.task.updateMany({
    where: {
      status: { in: ["RUNNING", "PENDING"] },
      NOT: {
        OR: [
          { source: "rosetta-account-repair" },
          { payload: { contains: '"source":"rosetta-account-repair"' } },
        ],
      },
    },
    data: {
      status: "FAILED_RETRYABLE",
      lastErrorCode: "WORKER_RESTART",
      lastErrorMessage: `Worker ${workerId} restarted — task may have been in progress`,
    },
  });
  if (rosettaResult.count > 0) {
    console.log(`[${workerId}] Cleaned up ${rosettaResult.count} Rosetta repair RUNNING/PENDING task(s) -> FAILED_FINAL`);
  }
  if (result.count > 0) {
    console.log(`[${workerId}] Cleaned up ${result.count} orphaned RUNNING/PENDING task(s) → FAILED_RETRYABLE`);
  }
}

// Run cleanup before accepting jobs, then recover stuck transfer batches
cleanupStalledTasks()
  .then(() => recoverStuckTransferBatches())
  .catch((err) =>
    console.error(`[${workerId}] Failed to cleanup stalled tasks:`, err)
  );

/**
 * After worker restart, transfer batches may be stuck (all tasks terminal but
 * phase still REMOVING/INVITING) because the crash prevented the callback.
 * Find such batches and run the progress check once to advance them.
 */
async function recoverStuckTransferBatches(): Promise<void> {
  const { checkTransferBatchProgress } = await import("./check-transfer-progress");

  const stuckBatches = await prisma.transferBatch.findMany({
    where: { phase: { in: ["REMOVING", "INVITING"] } },
    include: {
      tasks: { select: { id: true, status: true }, take: 1 },
    },
  });

  for (const batch of stuckBatches) {
    if (batch.tasks.length === 0) continue;
    // Use any task from the batch to trigger the progress check
    try {
      await checkTransferBatchProgress(prisma, batch.tasks[0].id, inviteQueueRef);
      console.log(`[${workerId}] Recovered stuck transfer batch ${batch.id}`);
    } catch (err) {
      console.warn(`[${workerId}] Failed to recover transfer batch ${batch.id}:`, err);
    }
  }
}

// Also force-release any Redis profile locks AND account locks this worker left behind on crash
Promise.all([
  pool.releaseAllByWorker(workerId),
  pool.releaseAllAccountsByWorker(workerId),
]).catch((err: Error) =>
  console.error(`[${workerId}] Failed to release pool/account locks on startup:`, err.message)
);

// ---- Event Logging ----

for (const worker of workers) {
  worker.on("completed", (job: Job) => {
    console.log(`[${workerId}] ✓ ${worker.name} completed job=${job.id}`);
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    // pool.release() is guaranteed by the finally block in each processor;
    // no secondary cleanup needed here.
    console.error(
      `[${workerId}] ✗ ${worker.name} failed job=${job?.id}`,
      error.message
    );
  });

  // BullMQ stalled event: job was active but worker stopped renewing the lock.
  // The DB task is still RUNNING — update it so the admin console shows correct state.
  // Also force-release any Redis pool locks held by this worker instance.
  worker.on("stalled", (jobId: string) => {
    console.warn(`[${workerId}] ⚠ stalled job=${jobId} on ${worker.name} — releasing pool locks & updating DB`);

    // Force-release pool locks AND account locks so the next job doesn't have to wait
    Promise.all([
      pool.releaseAllByWorker(workerId),
      pool.releaseAllAccountsByWorker(workerId),
    ]).catch((err: Error) =>
      console.error(`[${workerId}] Failed to release locks on stall:`, err.message)
    );

    // Extract taskId from the BullMQ jobId (format: "automation-<taskId>")
    // Only update THIS specific task, not all RUNNING tasks.
    // Rosetta account repair is manual by design: never mark it retryable,
    // otherwise BullMQ can re-open the browser after the user closes it.
    const taskId = jobId.replace(/^automation-/, "");
    prisma.task.updateMany({
      where: {
        id: taskId,
        status: { in: ["RUNNING", "PENDING"] },
        OR: [
          { source: "rosetta-account-repair" },
          { payload: { contains: '"source":"rosetta-account-repair"' } },
        ],
      },
      data: {
        status: "FAILED_FINAL",
        lastErrorCode: "STALLED",
        lastErrorMessage: `BullMQ job ${jobId} stalled during Rosetta account repair - task will not be retried`,
      },
    }).catch((err: Error) =>
      console.error(`[${workerId}] Failed to update stalled Rosetta repair task in DB:`, err.message)
    );
    prisma.task.updateMany({
      where: {
        id: taskId,
        status: { in: ["RUNNING", "PENDING"] },
        NOT: {
          OR: [
            { source: "rosetta-account-repair" },
            { payload: { contains: '"source":"rosetta-account-repair"' } },
          ],
        },
      },
      data: {
        status: "FAILED_RETRYABLE",
        lastErrorCode: "STALLED",
        lastErrorMessage: `BullMQ job ${jobId} stalled — worker lock expired (worker may have been overloaded or crashed)`,
      },
    }).catch((err: Error) =>
      console.error(`[${workerId}] Failed to update stalled task in DB:`, err.message)
    );
  });

  worker.on("error", (error: Error) => {
    console.error(`[${workerId}] Worker error on ${worker.name}:`, error);
  });
}

console.log(`[${workerId}] online — consuming ${workers.length} queues`);
console.log(
  `[${workerId}] queues: ${Object.values(QUEUE_NAMES).join(", ")}`
);

// ---- Graceful Shutdown ----

const shutdown = async (signal: string) => {
  console.log(`[${workerId}] Received ${signal}, shutting down...`);

  await Promise.allSettled(workers.map((w) => w.close()));
  await prisma.$disconnect();
  redis.disconnect();

  console.log(`[${workerId}] Shutdown complete`);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
