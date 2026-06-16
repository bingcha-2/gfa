"use client";

import { useCallback, useEffect, useState } from "react";

import { AccountEmpty, AccountSkeleton } from "@/components/account/account-ui";
import { getUsageStats } from "@/lib/account/user-api";
import type { UsageDays, UsageStats } from "@/lib/account/user-types";
import { formatTokens } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";

function formatUSD(n: number): string {
  const v = Math.max(0, n || 0);
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/**
 * 按模型汇总表:把所选时间窗内的用量按模型逐行列出
 * (请求数 / 输入·输出·缓存 token / 合计 / 官方 API 价估算 / 占比)。
 * 数据来自服务端 getUsageStats 的 byModel(源:CardTokenUsage,按 modelKey 聚合)。
 */
export function UsageModelTable({ days = 7 }: { days?: UsageDays }) {
  const u = useDict().portalApp.usage;

  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (d: UsageDays) => {
    try {
      setStats(await getUsageStats(d));
      setLoadError(false);
    } catch {
      setLoadError(true);
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  if (loadError) return <p className="account-form-error">{u.loadFailed}</p>;
  if (stats === null) {
    return (
      <div className="account-skeleton-stack">
        <AccountSkeleton className="account-skeleton--row" />
        <AccountSkeleton className="account-skeleton--row" />
        <AccountSkeleton className="account-skeleton--row" />
      </div>
    );
  }

  const rows = stats.byModel;
  if (rows.length === 0) {
    return <AccountEmpty title={u.empty} description={u.emptyDesc} />;
  }
  const totalCost = rows.reduce((s, r) => s + (r.estimatedUSD || 0), 0);

  return (
    <div className="account-data-section">
      <p style={{ fontSize: "12px", color: "var(--ink-muted)", margin: "0 0 8px" }}>
        服务端账单口径(含你全部设备);成本按官方 API 价估算(含缓存读)。
      </p>
      <div className="account-data-table">
        <table>
          <thead>
            <tr>
              <th>{u.colModel}</th>
              <th className="account-data-table__number">请求数</th>
              <th className="account-data-table__number">{u.colInput}</th>
              <th className="account-data-table__number">{u.colOutput}</th>
              <th className="account-data-table__number">缓存</th>
              <th className="account-data-table__number">{u.colTotal}</th>
              <th className="account-data-table__number">官方 API 价估算</th>
              <th className="account-data-table__number">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.modelKey}>
                <td className="account-data-table__mono" title={m.modelKey}>{m.modelKey}</td>
                <td className="account-data-table__number">{m.requests.toLocaleString()}</td>
                <td className="account-data-table__number">{formatTokens(m.inputTokens)}</td>
                <td className="account-data-table__number">{formatTokens(m.outputTokens)}</td>
                <td className="account-data-table__number">{formatTokens(m.cachedTokens)}</td>
                <td className="account-data-table__number account-data-table__strong">{formatTokens(m.totalTokens)}</td>
                <td className="account-data-table__number">{formatUSD(m.estimatedUSD)}</td>
                <td className="account-data-table__number">
                  {totalCost > 0 ? `${((m.estimatedUSD / totalCost) * 100).toFixed(1)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
