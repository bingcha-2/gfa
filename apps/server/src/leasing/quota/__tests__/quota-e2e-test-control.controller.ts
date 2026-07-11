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
}
