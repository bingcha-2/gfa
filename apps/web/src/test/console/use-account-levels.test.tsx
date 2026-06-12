/**
 * Tests for the account-levels fetch hook:
 *   src/app/(console)/console/(dashboard)/(product)/plan-catalog/use-account-levels.ts
 *
 * 给定产品集合,逐产品拉 GET /api/console/account-levels?product=xxx,合并成
 * { product: levels[] } 供套餐配置页等级下拉用。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useAccountLevels } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/use-account-levels";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("useAccountLevels", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("逐产品拉账号池等级并合并成 { product: levels }", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("product=anthropic")) {
        return jsonResponse({ ok: true, product: "anthropic", levels: ["pro", "max-20x"] });
      }
      if (url.includes("product=codex")) {
        return jsonResponse({ ok: true, product: "codex", levels: ["plus"] });
      }
      return jsonResponse({ ok: false, levels: [] });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() => useAccountLevels(["anthropic", "codex"]));

    await waitFor(() => {
      expect(result.current.levels.anthropic).toEqual(["pro", "max-20x"]);
    });
    expect(result.current.levels.codex).toEqual(["plus"]);

    // 命中正确端点。
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/console/account-levels?product=anthropic"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/console/account-levels?product=codex"))).toBe(true);
  });

  it("某产品请求失败 → 该产品等级为空数组,不抛错", async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() => useAccountLevels(["anthropic"]));

    await waitFor(() => {
      expect(result.current.levels.anthropic).toEqual([]);
    });
  });
});
