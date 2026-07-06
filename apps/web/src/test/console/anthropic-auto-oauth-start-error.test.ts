import { describe, expect, it } from "vitest";

import { formatAutoOAuthStartError } from "@/lib/console/anthropic-auto-oauth";

describe("formatAutoOAuthStartError", () => {
  it("includes HTTP status and response summary when the start response has no business error", () => {
    expect(
      formatAutoOAuthStartError({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: { message: "Unauthorized" },
      }),
    ).toBe('启动失败 (HTTP 401 Unauthorized): {"message":"Unauthorized"}');
  });

  it("explains that a successful-looking response is missing taskId", () => {
    expect(
      formatAutoOAuthStartError({
        ok: true,
        status: 200,
        statusText: "OK",
        body: { ok: true },
      }),
    ).toBe('启动失败: 启动接口未返回 taskId: {"ok":true}');
  });
});
