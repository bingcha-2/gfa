"use client";

// 卡密列表取数 hook —— GET /api/console/rosetta/access-keys(沿用旧 page.tsx 的取数接口路径)。
// 返回 { ok, keys, totalAll?, totalActive? };keys 形状对齐 types.ts 的 AccessKeyListItem
// (服务端 listAccessKeys 重设计后追加 cardType/buckets/bindingsDetail/fairShare 摘要)。
//
// 职责:只管"拉列表 + 刷新 + loading/error",不做筛选/排序/分页(那些在 toolbar/页面层做)。
// search 作为查询参数透传给后端做服务端过滤(与旧实现一致);本地再筛由调用方决定。

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessKeyListItem } from "./types";

export interface UseAccessKeysResult {
  /** 当前列表(已按后端返回顺序;本地排序在页面层做)。 */
  keys: AccessKeyListItem[];
  /** 后端汇总:总数(缺省时回退为 keys.length)。 */
  totalAll: number;
  /** 后端汇总:有效数(缺省时回退为本地 active 计数)。 */
  totalActive: number;
  /** 首次/刷新加载中。 */
  loading: boolean;
  /** 最近一次取数的错误信息("" = 无错误)。 */
  error: string;
  /** 手动刷新(可传 search 覆盖当前搜索词;用于操作后 refetch)。 */
  refresh: (search?: string) => Promise<void>;
}

/**
 * 列表取数 hook。
 * @param search 服务端搜索词(透传 ?search=);变更后调用方应自行 refresh 或依赖此 hook 的 effect。
 * @param auto 是否在挂载/ search 变更时自动取数(默认 true)。
 */
export function useAccessKeys(search = "", auto = true): UseAccessKeysResult {
  const [keys, setKeys] = useState<AccessKeyListItem[]>([]);
  const [totalAll, setTotalAll] = useState(0);
  const [totalActive, setTotalActive] = useState(0);
  const [loading, setLoading] = useState(auto);
  const [error, setError] = useState("");

  // 最新 search 存 ref,refresh() 不传参时取它(避免把 refresh 绑死在某次 search 闭包上)。
  const searchRef = useRef(search);
  searchRef.current = search;

  const refresh = useCallback(async (override?: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const term = (override ?? searchRef.current).trim();
      if (term) params.set("search", term);
      const res = await fetch(
        `/api/console/rosetta/access-keys${params.toString() ? `?${params}` : ""}`,
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "加载卡密失败");
      const list: AccessKeyListItem[] = Array.isArray(data.keys) ? data.keys : [];
      setKeys(list);
      setTotalAll(
        typeof data.totalAll === "number" ? data.totalAll : list.length,
      );
      setTotalActive(
        typeof data.totalActive === "number"
          ? data.totalActive
          : list.filter((k) => k.status === "active").length,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载卡密失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载与 search 变更时自动取数(由调用方通过传入的 search 触发)。
  useEffect(() => {
    if (!auto) return;
    void refresh(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, auto]);

  return { keys, totalAll, totalActive, loading, error, refresh };
}
