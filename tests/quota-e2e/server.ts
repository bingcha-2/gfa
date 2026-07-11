import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { RemoteCodexController } from "../../apps/server/src/leasing/remote-codex/controller/remote-codex.controller";
import { RemoteCodexService } from "../../apps/server/src/leasing/remote-codex/service/remote-codex.service";

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

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

const serviceProvider = {
  provide: RemoteCodexService,
  useFactory: () => {
    const service = new RemoteCodexService({
      accountsFilePath: process.env.QUOTA_E2E_ACCOUNTS,
      accessKeysFilePath: process.env.QUOTA_E2E_KEYS,
      tokenProvider: async () => "quota-e2e-upstream-token",
      minClientVersion: "",
      fairShareAlgorithm: "window-cu-v1",
      prisma,
    });
    service.accessKeyStore.setSessionResolver(sessionResolver);
    return service;
  },
};

@Module({ controllers: [RemoteCodexController], providers: [serviceProvider] })
class QuotaE2EModule {}

async function main() {
  await prisma.$connect();
  const app = await NestFactory.create(QuotaE2EModule, { logger: false });
  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  const port = Number(process.env.QUOTA_E2E_PORT || 0);
  await app.listen(port, "127.0.0.1");
  const address = app.getHttpServer().address();
  process.stdout.write(`QUOTA_E2E_READY ${address.port}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
