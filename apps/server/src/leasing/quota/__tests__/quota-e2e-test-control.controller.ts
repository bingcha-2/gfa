import { Body, Controller, Post } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { RemoteCodexService } from "../../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../../remote-anthropic/service/remote-anthropic.service";
import { RequestLogTracker } from "../../token-server/request-log-tracker";
import { checkpointKey } from "../fair-share-window-repository";
import { QuotaWriteCoordinator } from "../quota-write-coordinator";

let dependencies: {
  prisma: PrismaClient;
  requestLogs: RequestLogTracker;
  codex: RemoteCodexService;
  anthropic: RemoteAnthropicService;
  setNow: (value: number | null) => void;
};

type Provider = "codex" | "anthropic";
type CheckpointFault = {
  armed: number;
  failures: number;
  patched: boolean;
  expected?: { accountId: number; bucket: string; primary: number; weekly: number };
  /** When set, only checkpoints that carry a receipt for this target fail. */
  matchReceipt?: { accountId: number; bucket: string } | null;
};
const checkpointFaults = new Map<Provider, CheckpointFault>();

function serviceFor(provider: Provider): RemoteCodexService | RemoteAnthropicService {
  return provider === "anthropic" ? dependencies.anthropic : dependencies.codex;
}

function trackerFor(provider: Provider): any {
  const tracker = serviceFor(provider).fairShareTracker as any;
  if (!tracker?.windowCu || !tracker?.windowRepository) {
    throw new Error(`window-cu tracker unavailable for ${provider}`);
  }
  return tracker;
}

export function configureQuotaE2ETestControl(value: typeof dependencies) {
  dependencies = value;
}

/** Registered only by tests/quota-e2e/server-fixture.ts. */
@Controller("__quota-e2e")
export class QuotaE2ETestControlController {
  @Post("time")
  time(@Body() body: { now?: number; realtime?: boolean }) {
    if (body?.realtime === true) {
      dependencies.setNow(null);
      return { ok: true, realtime: true };
    }
    const value = Number(body?.now || 0);
    if (!Number.isFinite(value) || value <= 0) return { ok: false };
    dependencies.setNow(value);
    return { ok: true, now: value };
  }

  @Post("flush")
  async flush() {
    await dependencies.codex.fairShareTracker?.flush();
    await dependencies.anthropic.fairShareTracker?.flush();
    await dependencies.requestLogs.flush();
    return {
      ok: true,
      receipts: await dependencies.prisma.quotaReportReceipt.count(),
      requestLogs: await dependencies.prisma.requestLog.count(),
    };
  }

  @Post("check")
  check(@Body() body: { provider?: Provider; accountId?: number; cardId?: string; bucket?: string }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    return serviceFor(provider).fairShareTracker?.checkFairShare(
      Number(body.accountId || 0), String(body.cardId || ""), String(body.bucket || ""),
    );
  }

  @Post("stale-checkpoint")
  async staleCheckpoint(@Body() body: { provider?: Provider; accountId?: number; bucket?: string; reportId?: string }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    const accountId = Number(body.accountId || 0);
    const bucket = String(body.bucket || "");
    const reportId = String(body.reportId || "stale-e2e-receipt");
    const tracker = trackerFor(provider);
    const current = tracker.windowCu.entry(accountId, bucket);
    if (!current) throw new Error(`missing window state ${provider}/${accountId}/${bucket}`);
    const windows = structuredClone(current.windows);
    for (const scope of ["primary", "weekly"] as const) {
      windows[scope].revision = Math.max(0, Number(windows[scope].revision) - 1);
      windows[scope].fraction = 0;
    }
    await tracker.windowRepository.checkpointBatch([{
      accountId,
      bucket,
      windows,
      reportIds: [reportId],
      accountings: [],
      createdAt: new Date(),
    }]);
    return { ok: true, attemptedRevision: Math.max(windows.primary.revision, windows.weekly.revision) };
  }

  /** Exercise the production repository + write coordinator partial-success contract. */
  @Post("stale-checkpoint-batch")
  async staleCheckpointBatch(@Body() body: {
    provider?: Provider;
    staleAccountId?: number;
    healthyAccountId?: number;
    bucket?: string;
    via?: "batch" | "accounting";
  }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    const staleAccountId = Number(body.staleAccountId || 0);
    const healthyAccountId = Number(body.healthyAccountId || 0);
    const bucket = String(body.bucket || "");
    const tracker = trackerFor(provider);
    const staleCurrent = tracker.windowCu.entry(staleAccountId, bucket);
    if (!staleCurrent) {
      throw new Error(`missing stale-batch state ${provider}/${staleAccountId}/${healthyAccountId}/${bucket}`);
    }
    // Use the production coordinator against the production repository, but a
    // fresh queue: the tracker's 50ms background E2E flush may otherwise merge
    // this deliberately old payload with a pending current revision before it
    // reaches SQLite, making the fault injection nondeterministic.
    // via="accounting" drives the request hot path (checkpointReportAccounting);
    // via="batch" (default) drives the background combined path (checkpointBatch).
    // Both must isolate a stale sibling so a healthy sibling's receipt survives.
    const commit = body.via === "accounting"
      ? async (batch: any[]) => tracker.windowRepository.checkpointReportAccounting(batch.map((entry: any) => entry.payload))
      : async (batch: any[]) => tracker.windowRepository.checkpointBatch(batch.map((entry: any) => entry.payload));
    const coordinator = new QuotaWriteCoordinator<any>({
      maxDelayMs: 1,
      maxBatchSize: 64,
      commit,
    });
    const staleWindows = structuredClone(staleCurrent.windows);
    const durableHeads = await dependencies.prisma.fairShareWindowHead.findMany({
      where: { provider, accountId: staleAccountId, bucket },
      select: { scope: true, revision: true },
    });
    const durableRevision = new Map(durableHeads.map((head) => [head.scope, Number(head.revision)]));
    for (const scope of ["primary", "weekly"] as const) {
      const headRevision = durableRevision.get(scope);
      if (headRevision == null || headRevision <= 0) {
        throw new Error(`missing positive durable ${scope} revision for stale-batch test`);
      }
      staleWindows[scope].revision = headRevision - 1;
    }
    const payload = (accountId: number, windows: typeof staleWindows, reportId: string) => ({
      accountId,
      bucket,
      windows,
      reportIds: [reportId],
      accountings: [],
      createdAt: new Date(),
    });
    const staleRevision = Math.max(staleWindows.primary.revision, staleWindows.weekly.revision);
    const healthyWindows = structuredClone(staleCurrent.windows);
    const healthyRevision = Math.max(healthyWindows.primary.revision, healthyWindows.weekly.revision);
    // Distinct receipts per path so a batch run's INSERT OR IGNORE receipt can't
    // mask whether the accounting run actually wrote its own healthy receipt.
    const receiptSuffix = body.via === "accounting" ? "accounting" : "batch";
    const [stale, healthy] = await Promise.allSettled([
      coordinator.enqueue(
        checkpointKey(staleAccountId, bucket),
        staleRevision,
        payload(staleAccountId, staleWindows, `stale-${receiptSuffix}-receipt`),
        true,
      ),
      coordinator.enqueue(
        checkpointKey(healthyAccountId, bucket),
        healthyRevision,
        payload(healthyAccountId, healthyWindows, `healthy-${receiptSuffix}-receipt`),
        true,
      ),
    ]);
    const staleReason = stale.status === "rejected"
      ? stale.reason as { code?: string; staleKeys?: string[] }
      : null;
    return {
      ok: true,
      stale: { status: stale.status, code: staleReason?.code, staleKeys: staleReason?.staleKeys },
      healthy: { status: healthy.status, revision: healthy.status === "fulfilled" ? healthy.value : null },
    };
  }

  @Post("background-flush-failure")
  backgroundFlushFailure(@Body() body: { provider?: Provider; accountId?: number; bucket?: string; requireReceipt?: boolean }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    const tracker = trackerFor(provider);
    let fault = checkpointFaults.get(provider);
    if (!fault) {
      fault = { armed: 0, failures: 0, patched: false };
      checkpointFaults.set(provider, fault);
    }
    if (!fault.patched) {
      const repository = tracker.windowRepository;
      // Production splits the old checkpointBatch into two paths: background
      // window flushes go through checkpointWindows, and the hot-path receipt +
      // hourly commit goes through checkpointReportAccounting. Fault each on the
      // side its scenario targets — window flush when no receipt is required,
      // the accounting commit when a specific receipt must fail.
      const originalWindows = repository.checkpointWindows.bind(repository);
      repository.checkpointWindows = async (...args: any[]) => {
        const current = checkpointFaults.get(provider)!;
        if (current.armed > 0 && !current.matchReceipt) {
          current.armed--;
          current.failures++;
          throw new Error(`quota-e2e injected ${provider} window checkpoint failure`);
        }
        return originalWindows(...args);
      };
      const originalAccounting = repository.checkpointReportAccounting.bind(repository);
      repository.checkpointReportAccounting = async (...args: any[]) => {
        const current = checkpointFaults.get(provider)!;
        const matcher = current.matchReceipt;
        const matches = matcher && (args[0] || []).some((entry: any) =>
          entry.accountId === matcher.accountId
          && entry.bucket === matcher.bucket
          && (entry.reportIds || []).length > 0);
        if (current.armed > 0 && matches) {
          current.armed--;
          current.failures++;
          throw new Error(`quota-e2e injected ${provider} accounting checkpoint failure`);
        }
        return originalAccounting(...args);
      };
      fault.patched = true;
    }
    fault.armed++;
    const accountId = Number(body.accountId || 0);
    const bucket = String(body.bucket || "");
    fault.matchReceipt = body.requireReceipt === true ? { accountId, bucket } : null;
    // Mark real reducer state dirty without awaiting an explicit flush. The next
    // production interval tick owns the rejected promise and retry behavior.
    // (Skipped in requireReceipt mode: there the fault targets the acknowledging
    // report checkpoint itself, not a background tick.)
    if (!fault.matchReceipt) serviceFor(provider).fairShareTracker?.refreshAllParticipants();
    const entry = tracker.windowCu.entry(accountId, bucket);
    if (!entry) throw new Error(`missing fault target ${provider}/${accountId}/${bucket}`);
    fault.expected = {
      accountId,
      bucket,
      primary: Number(entry.windows.primary.revision),
      weekly: Number(entry.windows.weekly.revision),
    };
    return { ok: true, armed: true, expected: fault.expected };
  }

  /** Arm/release the production subscription-readiness barrier on the shared store. */
  @Post("subscription-barrier")
  async subscriptionBarrier(@Body() body: { provider?: Provider; ready?: boolean }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    const store = (serviceFor(provider) as any).accessKeyStore;
    if (body?.ready === true) await store.markSubscriptionsReady();
    else store.beginSubscriptionBarrier();
    return { ok: true, ready: store.areSubscriptionsReady() };
  }

  @Post("fault-status")
  async faultStatus(@Body() body: { provider?: Provider }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    const fault = checkpointFaults.get(provider);
    const expected = fault?.expected;
    const heads = expected ? await dependencies.prisma.fairShareWindowHead.findMany({
      where: { provider, accountId: expected.accountId, bucket: expected.bucket },
      select: { scope: true, revision: true },
    }) : [];
    const durable = Object.fromEntries(heads.map((head) => [head.scope, Number(head.revision)]));
    const recovered = Boolean(expected
      && Number(durable.primary || 0) >= expected.primary
      && Number(durable.weekly || 0) >= expected.weekly);
    return { ok: true, armed: fault?.armed || 0, failures: fault?.failures || 0, expected, durable, recovered };
  }

  @Post("request-log-failure")
  async requestLogFailure(@Body() body: { reportId?: string }) {
    const reportId = String(body.reportId || "request-log-retry-e2e");
    // Drain unrelated scenario logs first so the queue-size assertion below is
    // about exactly the injected incident.
    await dependencies.requestLogs.flush();
    const delegate = dependencies.prisma.requestLog as any;
    const original = delegate.createMany.bind(delegate);
    let failedOnce = false;
    try {
      delegate.createMany = async (...args: any[]) => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("quota-e2e injected request-log failure");
        }
        return original(...args);
      };
      dependencies.requestLogs.record({ provider: "codex", reportId, reason: "injected diagnostic retry" });
      await dependencies.requestLogs.flush();
      const queuedAfterFailure = dependencies.requestLogs.getQueueForTesting().length;
      await dependencies.requestLogs.flush();
      const persisted = await dependencies.prisma.requestLog.count({ where: { reportId } });
      return { ok: true, failedOnce, queuedAfterFailure, persisted };
    } finally {
      delegate.createMany = original;
    }
  }
}
