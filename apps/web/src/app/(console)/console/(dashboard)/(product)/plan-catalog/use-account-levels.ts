"use client";

// 套餐配置页等级下拉取数 hook。
//
// 给定产品集合,逐产品拉 GET /api/console/account-levels?product=xxx(ConsoleJwt,cookie
// 自动带,经 next.config 的 /api/console/* rewrite 直达 NestJS),返回该产品账号池里实际
// 存在的 planType 去重列表。合并成 { product: levels[] } 供 ProductsSection 的等级选择用 ——
// 账号池里没有的等级选不了,使 console 档名 ↔ account.planType ↔ 绑定匹配天然一致。
//
// 容错:任一产品请求失败 → 该产品等级落空数组(不阻塞整页、不抛错)。

import { useEffect, useMemo, useState } from "react";

export interface UseAccountLevelsResult {
  /** product → 该产品账号池里去重的 planType 列表(失败/未拉到 = [])。 */
  levels: Record<string, string[]>;
  /** 是否还在拉取(首轮)。 */
  loading: boolean;
}

async function fetchLevels(product: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/console/account-levels?product=${encodeURIComponent(product)}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { levels?: unknown };
    return Array.isArray(data.levels) ? data.levels.map((l) => String(l)) : [];
  } catch {
    return [];
  }
}

export function useAccountLevels(products: string[]): UseAccountLevelsResult {
  const [levels, setLevels] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);

  // 用稳定 key(排序后逗号串)避免数组引用每渲染都变导致反复拉取。
  const key = useMemo(() => [...products].sort().join(","), [products]);

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split(",") : [];
    if (list.length === 0) {
      setLevels({});
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(list.map(async (product) => [product, await fetchLevels(product)] as const))
      .then((entries) => {
        if (cancelled) return;
        setLevels(Object.fromEntries(entries));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { levels, loading };
}
