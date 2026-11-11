import type { NestExpressApplication } from "@nestjs/platform-express";

/** Requires NestFactory's rawBody option. Keep original JSON bytes only for the
 * forwarding endpoints; other routes do not retain a second copy of the body. */
export function configureGatewayJsonParser(app: NestExpressApplication) {
  app.useBodyParser("json", { limit: "20mb" });
  app.use((req: any, _res: any, next: () => void) => {
    const path = (req.originalUrl ?? req.url ?? "").split("?", 1)[0];
    const json = /^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "");
    if (!json || !/^\/api\/gateway\/v1\/messages(?:\/count_tokens)?\/?$/i.test(path)) delete req.rawBody;
    next();
  });
}
