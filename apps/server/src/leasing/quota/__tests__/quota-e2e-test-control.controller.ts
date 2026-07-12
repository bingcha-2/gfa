import { Body, Controller, Post } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { RemoteCodexService } from "../../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../../remote-anthropic/service/remote-anthropic.service";
import { RequestLogTracker } from "../../token-server/request-log-tracker";

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

  @Post("background-flush-failure")
  backgroundFlushFailure(@Body() body: { provider?: Provider; accountId?: number; bucket?: string }) {
    const provider = body.provider === "anthropic" ? "anthropic" : "codex";
    const tracker = trackerFor(provider);
    let fault = checkpointFaults.get(provider);
    if (!fault) {
      fault = { armed: 0, failures: 0, patched: false };
      checkpointFaults.set(provider, fault);
    }
    if (!fault.patched) {
      const repository = tracker.windowRepository;
      const original = repository.checkpointBatch.bind(repository);
      repository.checkpointBatch = async (...args: any[]) => {
        const current = checkpointFaults.get(provider)!;
        if (current.armed > 0) {
          current.armed--;
          current.failures++;
          throw new Error(`quota-e2e injected ${provider} checkpoint failure`);
        }
        return original(...args);
      };
      fault.patched = true;
    }
    fault.armed++;
    // Mark real reducer state dirty without awaiting an explicit flush. The next
    // production interval tick owns the rejected promise and retry behavior.
    serviceFor(provider).fairShareTracker?.refreshAllParticipants();
    const accountId = Number(body.accountId || 0);
    const bucket = String(body.bucket || "");
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
}
