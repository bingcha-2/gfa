import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";

import { AppModule } from "./app.module";

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

  await app.listen(port);

  console.log(`[api] listening on http://localhost:${port}/api`);
}

bootstrap().catch((error) => {
  console.error("[api] bootstrap failed", error);
  process.exit(1);
});
