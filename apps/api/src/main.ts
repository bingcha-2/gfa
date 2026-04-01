import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";

import { AppModule } from "./app.module";
import { PrismaService } from "./prisma/prisma.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.API_PORT ?? 3001);

  // S-01: HTTP security headers
  app.use(helmet());

  // S-02: CORS — allow origins from env, comma-separated
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  });

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );

  // --- Admin Initialization Script ---
  const prisma = app.get(PrismaService);
  const adminEmail = "system.admin@gfa-internal.com";
  const fixedPassword = "GfaAdmin2026Secure";
  const passwordHash = await bcrypt.hash(fixedPassword, 10);

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) {
    // 强制使用固定密码（更新以确保旧密码不生效），如果觉得不需要覆盖也可以注释掉 update 这一步
    await prisma.user.update({
      where: { email: adminEmail },
      data: { passwordHash }
    });
  } else {
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        displayName: "System Admin",
        role: "ADMIN"
      }
    });

  }
  // -----------------------------------

  await app.listen(port);

  console.log(`[api] listening on http://localhost:${port}/api`);
}

bootstrap().catch((error) => {
  console.error("[api] bootstrap failed", error);
  process.exit(1);
});
