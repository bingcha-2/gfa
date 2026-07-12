import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { RemoteCodexController } from "../../apps/server/src/leasing/remote-codex/controller/remote-codex.controller";
import { RemoteCodexService } from "../../apps/server/src/leasing/remote-codex/service/remote-codex.service";
import { RemoteAnthropicController } from "../../apps/server/src/leasing/remote-anthropic/controller/remote-anthropic.controller";
import { RemoteAnthropicService } from "../../apps/server/src/leasing/remote-anthropic/service/remote-anthropic.service";
import { RequestLogTracker } from "../../apps/server/src/leasing/token-server/request-log-tracker";
import { configureQuotaE2ETestControl, QuotaE2ETestControlController } from "../../apps/server/src/leasing/quota/__tests__/quota-e2e-test-control.controller";

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const requestLogs = new RequestLogTracker(prisma, { autoStart: false });
let virtualNow: number | null = null;
const now = () => virtualNow ?? Date.now();

const sessionResolver = {
  async resolve(token: string) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      return { ok: true as const, cardId: String(payload.cardId || "") };
    } catch {
      return { ok: false as const, statusCode: 401, error: "SESSION_INVALID", message: "bad token" };
    }
  },
};

const codex = new RemoteCodexService({
      accountsFilePath: process.env.QUOTA_E2E_ACCOUNTS,
      accessKeysFilePath: process.env.QUOTA_E2E_KEYS,
      tokenProvider: async () => "quota-e2e-upstream-token",
      minClientVersion: "",
      now,
      fairShareAlgorithm: "window-cu-v1",
      fairShareFlushIntervalMs: Number(process.env.QUOTA_E2E_FLUSH_INTERVAL_MS || 30_000),
      requestLogRecorder: requestLogs,
      prisma,
});
codex.accessKeyStore.setSessionResolver(sessionResolver);

const anthropic = new RemoteAnthropicService({
      accountsFilePath: process.env.QUOTA_E2E_ACCOUNTS,
      accessKeysFilePath: process.env.QUOTA_E2E_KEYS,
      tokenProvider: async () => "quota-e2e-anthropic-token",
      minClientVersion: "",
      now,
      fairShareAlgorithm: "window-cu-v1",
      fairShareFlushIntervalMs: Number(process.env.QUOTA_E2E_FLUSH_INTERVAL_MS || 30_000),
      requestLogRecorder: requestLogs,
      prisma,
});
anthropic.accessKeyStore.setSessionResolver(sessionResolver);
configureQuotaE2ETestControl({ prisma, requestLogs, codex, anthropic, setNow: (value) => { virtualNow = value; } });

@Module({
  controllers: [RemoteCodexController, RemoteAnthropicController, QuotaE2ETestControlController],
  providers: [
    { provide: RemoteCodexService, useValue: codex },
    { provide: RemoteAnthropicService, useValue: anthropic },
  ],
})
class QuotaE2EModule {}

async function main() {
  await prisma.$connect();
  const app = await NestFactory.create(QuotaE2EModule, { logger: false });
  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.QUOTA_E2E_PORT || 0), "127.0.0.1");
  const address = app.getHttpServer().address();
  process.stdout.write(`QUOTA_E2E_READY ${address.port}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
