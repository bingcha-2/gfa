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

function isSuccessStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "success" || s === "ok" || s === "200";
}

export function UsageTable() {
  const dict = useDict();
  const u = dict.portalApp.usage;

  const [days, setDays] = useState<UsageDays>(7);
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

  function handleDaysChange(value: UsageDays) {
    setDays(value);
    setPage(1); // window change resets pagination
    setData(null); // show skeleton while reloading
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="account-usage" data-testid="account-usage">
      <div className="account-segmented-control" role="group" aria-label="使用记录时间范围">
        {[
          [1, u.daysToday],
          [7, u.days7],
          [30, u.days30],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={days === value}
            onClick={() => handleDaysChange(value as UsageDays)}
          >
            {label}
          </button>
        ))}
      </div>

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
