import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";

// repo root: this file sits at apps/server/src/shared/prisma/ (5 levels deep)
const projectRoot = resolve(__dirname, "../../../../../");

function resolveDatabaseUrl() {
  const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";

  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const rawPath = rawUrl.slice("file:".length);

  if (!rawPath || /^[A-Za-z]:/.test(rawPath) || rawPath.startsWith("/")) {
    return rawUrl;
  }

  const absolutePath = resolve(projectRoot, "prisma", rawPath).replace(/\\/g, "/");
  return `file:${absolutePath}`;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      datasourceUrl: resolveDatabaseUrl()
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
