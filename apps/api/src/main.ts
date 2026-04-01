import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import * as bcrypt from "bcrypt";

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

  // --- Default Account Initialization (matches seed.mjs & startup banner) ---
  const prisma = app.get(PrismaService);
  const defaultPassword = "admin123";
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  const defaultUsers = [
    { email: "admin@gfa.local",   displayName: "Admin",   role: "ADMIN" as const },
    { email: "support@gfa.local", displayName: "Support", role: "SUPPORT" as const },
  ];

  for (const user of defaultUsers) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: { passwordHash },
      create: {
        email: user.email,
        passwordHash,
        displayName: user.displayName,
        role: user.role,
      },
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
