"use client";

// 账号下拉数据 hook —— 供「产品与绑定」选号 + 份额校验用。
// 跨三个号池并发取数(沿用旧 page.tsx 的接口路径),用 lib/console/bindable-accounts 的 toBindableAccounts
// 合并成 provider-tagged 列表(含 usedShares / shareCapacity / planType)。
//   - 选号:product-binding-manager 按 provider + planType 分组展示。
//   - 份额校验:usedShares + 本卡 weight <= shareCapacity 才可绑(不足禁选)。
// 另外抽出各池存在的会员等级(planType 去重),供创建向导/编辑里需要"按等级筛号"的场景。

import { useCallback, useEffect, useState } from "react";
import { toBindableAccounts } from "@/lib/console/bindable-accounts";
import type { BindableAccount } from "./types";

/** 每产品(provider)去重后的会员等级列表(升序);键为 provider。 */
export type LevelsByProduct = Record<string, string[]>;

export interface UseLeaseAccountsResult {
  /** 合并后的可绑定账号(provider 区分,含份额信息)。 */
  accounts: BindableAccount[];
  /** 各池存在的会员等级(去重升序),供按等级筛号。 */
  levels: LevelsByProduct;
  /** 取数加载中。 */
  loading: boolean;
  /** 手动刷新(操作后 refetch,如换绑改变 usedShares)。 */
  refresh: () => Promise<void>;
}

// 三个号池的 API 路径(与旧 page.tsx 一致):codex / antigravity / anthropic。
const ENDPOINTS = {
  codex: "/api/rosetta/codex-accounts",
  antigravity: "/api/rosetta/accounts",
  anthropic: "/api/rosetta/anthropic-accounts",
} as const;

// 某池里非空 planType 去重升序。
function levelsOf(list: Array<{ planType?: string }> | undefined): string[] {
  return [
    ...new Set(
      (list || [])
        .map((a) => String(a.planType || "").trim())
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * 账号下拉数据 hook。
 * @param auto 是否在挂载时自动取数(默认 true)。
 */
export function useLeaseAccounts(auto = true): UseLeaseAccountsResult {
  const [accounts, setAccounts] = useState<BindableAccount[]>([]);
  const [levels, setLevels] = useState<LevelsByProduct>({});
  const [loading, setLoading] = useState(auto);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [codexRes, antiRes, claudeRes] = await Promise.all([
        fetch(ENDPOINTS.codex),
        fetch(ENDPOINTS.antigravity),
        fetch(ENDPOINTS.anthropic),
      ]);
      const [codex, anti, claude] = await Promise.all([
        codexRes.json(),
        antiRes.json(),
        claudeRes.json(),
      ]);
      setAccounts(
        toBindableAccounts(codex.accounts, anti.accounts, claude.accounts),
      );
      setLevels({
        codex: levelsOf(codex.accounts),
        antigravity: levelsOf(anti.accounts),
        anthropic: levelsOf(claude.accounts),
      });
    } catch {
      // 非致命:选号下拉显示"暂无可绑定账号"即可,不打断页面。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!auto) return;
    void refresh();
  }, [auto, refresh]);

  return { accounts, levels, loading, refresh };
}
