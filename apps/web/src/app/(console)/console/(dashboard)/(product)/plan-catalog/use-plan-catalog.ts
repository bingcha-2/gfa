"use client";

// 套餐配置页取数 + 落库 hook。
//
// 取数:GET /api/plan-catalog(公开代理)—— 当前 PUBLISHED 的 {version, config},
//   用来预填表单(在现有发布版上改)并显示「当前发布 vM」徽章。无发布版时 config=null。
// 落库:
//   - saveDraft(config) → POST /api/console/plan-catalog(ConsoleJwt,cookie 自动带)
//     建草稿,返回 {id, version}。
//   - publish(id)       → POST /api/console/plan-catalog/:id/publish 发布(旧版归档)。
// 后端 console 接口经 next.config 的 /api/console/* rewrite 直达 NestJS;鉴权走
//   gfa.console.token cookie(JwtStrategy 同时认 cookie + Bearer)。

import { useCallback, useEffect, useState } from "react";

import type { CatalogConfig } from "@/lib/account/catalog-pricing";

/** 后端建草稿 / 发布返回的版本行(只取页面要用的字段)。 */
export interface CatalogVersionRow {
  id: string;
  version: number;
  status: string;
}

export interface UsePlanCatalogResult {
  /** 当前 PUBLISHED 的 config(无发布版 → null)。用于预填表单。 */
  publishedConfig: CatalogConfig | null;
  /** 当前 PUBLISHED 的版本号(无 → null)。 */
  publishedVersion: number | null;
  /** 首次加载中。 */
  loading: boolean;
  /** 加载错误("" = 无)。 */
  error: string;
  /** 重新拉取发布版(发布后刷新徽章用)。 */
  refresh: () => Promise<void>;
  /** 建草稿:返回新草稿行(含 id / version)。失败抛错。 */
  saveDraft: (config: CatalogConfig) => Promise<CatalogVersionRow>;
  /** 发布指定版本。失败抛错。 */
  publish: (id: string) => Promise<CatalogVersionRow>;
}

/** 从 fetch 响应里取后端的错误消息(NestJS 风格 {message})。 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    const msg = data?.message ?? data?.error;
    if (Array.isArray(msg)) return msg.join(", ");
    if (typeof msg === "string") return msg;
  } catch {
    /* 非 JSON 响应,落回 fallback */
  }
  return fallback;
}

export function usePlanCatalog(): UsePlanCatalogResult {
  const [publishedConfig, setPublishedConfig] = useState<CatalogConfig | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/plan-catalog", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "加载当前发布版失败"));
      const data = (await res.json()) as { version: number | null; config: CatalogConfig | null };
      setPublishedConfig(data.config ?? null);
      setPublishedVersion(typeof data.version === "number" ? data.version : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载当前发布版失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveDraft = useCallback(async (config: CatalogConfig): Promise<CatalogVersionRow> => {
    const res = await fetch("/api/console/plan-catalog", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ config }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(await readError(res, "存草稿失败"));
    return (await res.json()) as CatalogVersionRow;
  }, []);

  const publish = useCallback(async (id: string): Promise<CatalogVersionRow> => {
    const res = await fetch(`/api/console/plan-catalog/${id}/publish`, {
      method: "POST",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(await readError(res, "发布失败"));
    return (await res.json()) as CatalogVersionRow;
  }, []);

  return {
    publishedConfig,
    publishedVersion,
    loading,
    error,
    refresh,
    saveDraft,
    publish,
  };
}
