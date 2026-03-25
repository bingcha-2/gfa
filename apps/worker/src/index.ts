/**
 * Worker entry point.
 *
 * Initializes infrastructure (Prisma, Redis, AdsPower client, ProfileLock)
 * and registers BullMQ workers for each task queue.
 */

import { config } from "dotenv";
import * as path from "path";

// Load .env from repo root (pnpm --filter runs from apps/worker/)
config({ path: path.resolve(__dirname, "../../../.env") });

import { Job, Worker } from "bullmq";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";

import {
  InviteMemberPayload,
  ReplaceMemberPayload,
  SyncFamilyGroupPayload,
  HealthCheckAccountPayload,
  QUEUE_NAMES,
} from "@gfa/shared";

import { AdsPowerClient } from "./adspower-client";
import { ProfileLock } from "./profile-lock";
import { processInvite } from "./processors/invite.processor";
import { processReplace } from "./processors/replace.processor";
import { processSync } from "./processors/sync.processor";
import { processHealth } from "./processors/health.processor";

// ---- Configuration ----

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const workerId = process.env.WORKER_NAME ?? `worker-${process.pid}`;
const adspowerHost =
  process.env.ADSPOWER_HOST ?? "http://localhost:50325";
const adspowerApiKey = process.env.ADSPOWER_API_KEY ?? "";

// ---- Infrastructure ----

const redis = new Redis(redisUrl);
const prisma = new PrismaClient();
const adspower = new AdsPowerClient({
  baseUrl: adspowerHost,
  apiKey: adspowerApiKey || undefined,
});
const lock = new ProfileLock(redis);

const deps = { prisma, adspower, lock, workerId };

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

// ---- Workers ----

const inviteWorker = new Worker<InviteMemberPayload>(
  QUEUE_NAMES.invite,
  (job) => processInvite(job, deps),
  {
    connection,
    concurrency: 1, // one profile at a time per worker instance
  }
);

const replaceWorker = new Worker<ReplaceMemberPayload>(
  QUEUE_NAMES.replace,
  (job) => processReplace(job, deps),
  {
    connection,
    concurrency: 1,
  }
);

const syncWorker = new Worker<SyncFamilyGroupPayload>(
  QUEUE_NAMES.sync,
  (job) => processSync(job, deps),
  {
    connection,
    concurrency: 1,
  }
);

const healthWorker = new Worker<HealthCheckAccountPayload>(
  QUEUE_NAMES.health,
  (job) => processHealth(job, deps),
  {
    connection,
    concurrency: 1,
  }
);

const workers = [inviteWorker, replaceWorker, syncWorker, healthWorker];

// ---- Event Logging ----

for (const worker of workers) {
  worker.on("completed", (job: Job) => {
    console.log(`[${workerId}] ✓ ${worker.name} completed job=${job.id}`);
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(
      `[${workerId}] ✗ ${worker.name} failed job=${job?.id}`,
      error.message
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
