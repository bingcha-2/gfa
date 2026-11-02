"use client";

// 读取母号产品的库存等级，作为配置页提示；查询失败不等于没有库存。

import { useEffect, useMemo, useState } from "react";

export interface UseAccountLevelsResult {
  /** product → 该产品账号池里去重的 planType 列表(失败/未拉到 = [])。 */
  levels: Record<string, string[]>;
  /** 是否还在拉取(首轮)。 */
  loading: boolean;
}

async function fetchLevels(product: string): Promise<string[] | null> {
  try {
    const res = await fetch(`/api/console/account-levels?product=${encodeURIComponent(product)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { levels?: unknown };
    return Array.isArray(data.levels) ? data.levels.map((l) => String(l)) : null;
  } catch {
    return null;
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
        setLevels(Object.fromEntries(entries.filter((entry): entry is readonly [string, string[]] => entry[1] !== null)));
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
