"use client";

import { useCallback, useEffect, useState } from "react";

import { DataPagination } from "@/components/account/data-pagination";
import { AccountEmpty, AccountPill, AccountSkeleton } from "@/components/account/account-ui";
import { AccountStatusBadge } from "@/components/account/account-status-badge";
import { getUsage } from "@/lib/account/user-api";
import type { UsageDays, UsagePage } from "@/lib/account/user-types";
import { formatDateTime, formatTokens } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";

const PAGE_SIZE = 20;

function isSuccessStatus(status: number | string): boolean {
  // status 是 HTTP 状态码(number,如 200/429),旧数据可能是字符串 —— 两种都兜住。
  const n = Number(status);
  if (Number.isFinite(n) && n > 0) return n >= 200 && n < 300;
  const s = String(status).toLowerCase();
  return s === "success" || s === "ok";
}

/**
 * 用量明细表。`days` 受控于父级(UsageView 的分段控件);单独渲染时默认 7 天。
 * 切换窗口时父级用 key={days} 重挂本组件以重置分页。
 */
export function UsageTable({ days = 7 }: { days?: UsageDays }) {
  const dict = useDict();
  const u = dict.portalApp.usage;

  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsagePage | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (p: number, d: UsageDays) => {
    try {
      const next = await getUsage(p, PAGE_SIZE, d);
      setData(next);
      setLoadError(false);
    } catch {
      setData({ records: [], total: 0, page: p, pageSize: PAGE_SIZE });
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load(page, days);
  }, [page, days, load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="account-usage" data-testid="account-usage">
      {loadError && <p className="account-form-error">{u.loadFailed}</p>}

      {data === null ? (
        <div className="account-skeleton-stack">
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
        </div>
      ) : data.records.length === 0 ? (
        <AccountEmpty title={u.empty} description={u.emptyDesc} />
      ) : (
        <div className="account-data-section">
          <div className="account-data-table">
            <table>
              <thead>
                <tr>
                  <th>{u.colTime}</th>
                  <th>{u.colModel}</th>
                  <th>{u.colBucket}</th>
                  <th>{u.colStatus}</th>
                  <th className="account-data-table__number">{u.colInput}</th>
                  <th className="account-data-table__number">{u.colOutput}</th>
                  <th className="account-data-table__number">{u.colTotal}</th>
                </tr>
              </thead>
              <tbody>
                {data.records.map((record) => (
                  <tr key={record.id}>
                    <td className="account-data-table__muted">
                      {formatDateTime(record.timestamp)}
                    </td>
                    <td className="account-data-table__mono" title={record.modelKey}>
                      {record.modelKey}
                    </td>
                    <td>
                      <AccountPill tone="info">{record.bucket}</AccountPill>
                    </td>
                    <td>
                      <AccountStatusBadge
                        tone={isSuccessStatus(record.status) ? "success" : "destructive"}
                      >
                        {isSuccessStatus(record.status)
                          ? u.statusSuccess
                          : record.status}
                      </AccountStatusBadge>
                    </td>
                    <td className="account-data-table__number">
                      {formatTokens(record.inputTokens)}
                    </td>
                    <td className="account-data-table__number">
                      {formatTokens(record.outputTokens)}
                    </td>
                    <td className="account-data-table__number account-data-table__strong">
                      {formatTokens(record.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <DataPagination
            page={page}
            totalPages={totalPages}
            onPage={setPage}
            labels={{
              prevPage: u.prevPage,
              nextPage: u.nextPage,
              pageInfo: u.pageInfo,
            }}
          />
        </div>
      )}
    </div>
  );
}
