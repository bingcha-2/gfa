import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import * as bcrypt from "bcrypt";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

import { AppModule } from "./app.module";
import { PrismaService } from "./prisma/prisma.service";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Fire onModuleDestroy/onApplicationShutdown on SIGTERM/SIGINT so services
  // (e.g. TokenServerService) can flush buffered state before the process exits.
  app.enableShutdownHooks();

  // Increase JSON body size limit for FAQ rich-text content with images
  app.useBodyParser("json", { limit: "20mb" });
  // Parse form-encoded bodies so the epay (易支付) async callback, which posts
  // application/x-www-form-urlencoded, is read by the notify controller.
  app.useBodyParser("urlencoded", { extended: true });

  // Ensure faq-images directory exists and serve static files
  const faqImagesDir = join(process.cwd(), "data", "faq-images");
  if (!existsSync(faqImagesDir)) {
    mkdirSync(faqImagesDir, { recursive: true });
  }
  app.useStaticAssets(faqImagesDir, { prefix: "/api/faq-images" });
  const port = Number(process.env.API_PORT ?? 3001);

  app.use(cookieParser());
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

  // --- Default Account Initialization ---
  // Only CREATE accounts if they don't exist. Never overwrite passwordHash
  // so that password changes via change-password API persist across restarts.
  const prisma = app.get(PrismaService);
  const defaultPassword = "admin123";
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  const defaultUsers = [
    { email: "admin@gfa.local", displayName: "Admin", role: "ADMIN" as const },
    { email: "test1@gfa.local", displayName: "Admin", role: "ADMIN" as const },

    { email: "support@gfa.local", displayName: "Support", role: "SUPPORT" as const },
  ];

  for (const user of defaultUsers) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {},  // Don't overwrite anything — preserves changed passwords
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
