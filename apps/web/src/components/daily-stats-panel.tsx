"use client";

import { useState, useEffect } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { Spinner } from "./spinner";

type DailyStatsData = {
  date: string;
  importedAccounts: number;
  suspendedAccounts: number;
  verificationAccounts: number;
  transferredMembers: number;
  redeemInvites: number;
  consoleInvites: number;
};

function todayDateStr(): string {
  const now = new Date();
  const offset = now.getTime() + 8 * 60 * 60 * 1000;
  const local = new Date(offset);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

export function DailyStatsPanel() {
  const [date, setDate] = useState(todayDateStr());
  const [stats, setStats] = useState<DailyStatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function loadStats(targetDate: string) {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiRequest<DailyStatsData>("stats/daily", {
        search: { date: targetDate },
      });
      setStats(data);
    } catch (err) {
      setError(getErrorMessage(err));
      setStats(null);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadStats(date);
  }, []);

  function handleDateChange(newDate: string) {
    setDate(newDate);
    loadStats(newDate);
  }

  function shiftDate(days: number) {
    const current = new Date(date + "T00:00:00");
    current.setDate(current.getDate() + days);
    const shifted = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    handleDateChange(shifted);
  }

  const metrics: { label: string; value: number; description: string }[] = stats
    ? [
        { label: "导入母号", value: stats.importedAccounts, description: "当日新导入的母号数量。" },
        { label: "订阅暂停", value: stats.suspendedAccounts, description: "当日被暂停订阅的母号数量。" },
        { label: "需验证", value: stats.verificationAccounts, description: "当日触发验证（手机/CAPTCHA）的母号数量。" },
        { label: "迁移成员", value: stats.transferredMembers, description: "当日被迁移的家庭组成员总数。" },
        { label: "卡密邀请", value: stats.redeemInvites, description: "通过卡密兑换产生的邀请订单数量。" },
        { label: "控制台邀请", value: stats.consoleInvites, description: "通过控制台手动发起的邀请数量。" },
      ]
    : [];

  return (
    <div className="panel-stack">
      {/* Date selector */}
      <article className="glass-panel">
        <div className="panel-stack">
          <div className="section-copy">
            <p className="label">Daily Summary</p>
            <h2 className="panel-title">每日数据汇总</h2>
            <p className="muted">查看指定日期的运营核心指标，默认展示今日数据。</p>
          </div>

          <div className="action-row" style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <button
              className="button secondary"
              onClick={() => shiftDate(-1)}
              type="button"
              style={{ minWidth: "36px" }}
            >
              ←
            </button>
            <input
              type="date"
              className="mono"
              value={date}
              max={todayDateStr()}
              onChange={(e) => handleDateChange(e.target.value)}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                padding: "6px 12px",
                color: "var(--foreground)",
                fontSize: "14px",
              }}
            />
            <button
              className="button secondary"
              onClick={() => shiftDate(1)}
              type="button"
              disabled={date >= todayDateStr()}
              style={{ minWidth: "36px" }}
            >
              →
            </button>
            <button
              className="button secondary"
              onClick={() => handleDateChange(todayDateStr())}
              type="button"
              disabled={date === todayDateStr()}
            >
              今日
            </button>
            <button
              className="button secondary"
              onClick={() => loadStats(date)}
              type="button"
              disabled={isLoading}
              style={{ gap: 8 }}
            >
              {isLoading ? (
                <><Spinner size={14} color="currentColor" /> 加载中...</>
              ) : "刷新"}
            </button>
          </div>
        </div>
      </article>

      {error ? <div className="notice error">{error}</div> : null}

      {/* Metrics grid */}
      {stats ? (
        <section className="surface-grid three-up">
          {metrics.map((m) => (
            <article className="glass-panel" key={m.label}>
              <div className="panel-stack" style={{ gap: "4px" }}>
                <p className="label">{m.label}</p>
                <div className="strong" style={{ fontSize: "28px", fontVariantNumeric: "tabular-nums" }}>
                  {m.value}
                </div>
                <p className="muted" style={{ fontSize: "12px" }}>{m.description}</p>
              </div>
            </article>
          ))}
        </section>
      ) : !isLoading && !error ? (
        <div className="empty-state">暂无数据</div>
      ) : null}

      {isLoading && !stats ? (
        <div className="empty-state" style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "center" }}>
          <Spinner size={16} color="currentColor" /> 正在加载 {date} 的数据...
        </div>
      ) : null}
    </div>
  );
}
