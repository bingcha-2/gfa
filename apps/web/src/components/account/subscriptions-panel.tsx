"use client";

import { useEffect, useState } from "react";
import { ArrowUpIcon, ArrowDownIcon } from "lucide-react";

import { getPortalOverview, setSubscriptionPriority } from "@/lib/account/user-api";
import type { OverviewSubscription } from "@/lib/account/user-types";
import { formatTokens } from "@/lib/format";

function sortByPriority(subs: OverviewSubscription[]): OverviewSubscription[] {
  return [...subs].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function statusLabel(status: string): { label: string; tone: "ok" | "muted" } {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return { label: "可用", tone: "ok" };
  if (s === "EXPIRED") return { label: "已过期", tone: "muted" };
  return { label: status, tone: "muted" };
}

function remainPct(sub: OverviewSubscription): number | null {
  const b = sub.quota?.buckets?.[0];
  if (!b || b.limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((b.limit - b.used) / b.limit) * 100)));
}

const card =
  "flex items-center gap-3 rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-tertiary)]/40 p-4";

export function SubscriptionsPanel() {
  const [subs, setSubs] = useState<OverviewSubscription[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    getPortalOverview()
      .then((o) => setSubs(sortByPriority(o.subscriptions)))
      .catch(() => setError(true));
  }, []);

  async function move(index: number, dir: -1 | 1) {
    if (!subs || busy) return;
    const j = index + dir;
    if (j < 0 || j >= subs.length) return;
    setBusy(true);
    const next = [...subs];
    [next[index], next[j]] = [next[j], next[index]];
    setSubs(next); // optimistic
    try {
      // Renumber the whole list so priority becomes a stable 0..n-1 sequence.
      let latest: Awaited<ReturnType<typeof setSubscriptionPriority>> | null = null;
      for (let i = 0; i < next.length; i++) {
        latest = await setSubscriptionPriority(next[i].id, i);
      }
      if (latest) setSubs(sortByPriority(latest.subscriptions));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <p className="rounded-[12px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3 text-[13px] text-[var(--text-secondary)]">
        订阅列表加载失败,请稍后重试。
      </p>
    );
  }
  if (!subs) {
    return <div className="py-8 text-center text-[13px] text-[var(--text-muted)]">加载中…</div>;
  }
  if (subs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-[14px] text-[var(--text-muted)]">你还没有任何订阅。</p>
        <a href="/account/billing" className="account-btn account-btn--primary">购买套餐</a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        按优先级从上到下使用:排在前面的订阅会被<b className="text-[var(--text-secondary)]">优先消耗</b>,用完后
        <b className="text-[var(--text-secondary)]">自动接力</b>到下一个。用 ↑ ↓ 调整顺序。
      </p>

      <ol className="flex flex-col gap-2.5">
        {subs.map((s, i) => {
          const st = statusLabel(s.status);
          const pct = remainPct(s);
          return (
            <li key={s.id} className={card} data-busy={busy || undefined}>
              <div className="grid place-items-center w-8 h-8 shrink-0 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-light)] text-[13px] font-bold font-mono-data text-[var(--text-secondary)]">
                {i + 1}
              </div>

              <div className="min-w-0 flex-1 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)] truncate">
                    {s.planName ?? "迁移卡密订阅"}
                    {i === 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--primary)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
                        优先使用
                      </span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[11px] font-medium"
                    style={{ color: st.tone === "ok" ? "var(--success)" : "var(--text-muted)" }}
                  >
                    {st.label}
                  </span>
                </div>

                {s.products.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {s.products.map((p) => (
                      <span
                        key={p}
                        className="rounded-md bg-[var(--bg-secondary)] border border-[var(--border-light)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[var(--text-muted)]">
                  <span>额度余量 <b className="text-[var(--text-primary)] font-mono-data">{pct === null ? "—" : `${pct}%`}</b></span>
                  <span>本期用量 <b className="text-[var(--text-primary)] font-mono-data">{s.quota ? formatTokens(s.quota.recentWindowTokens) : "—"}</b></span>
                  <span>到期 <b className="text-[var(--text-secondary)]">{s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : "∞"}</b></span>
                </div>
              </div>

              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  disabled={i === 0 || busy}
                  onClick={() => move(i, -1)}
                  aria-label="上移(提高优先级)"
                  className="grid place-items-center w-7 h-7 rounded-md border border-[var(--border-light)] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--bg-secondary)]"
                >
                  <ArrowUpIcon size={15} />
                </button>
                <button
                  type="button"
                  disabled={i === subs.length - 1 || busy}
                  onClick={() => move(i, 1)}
                  aria-label="下移(降低优先级)"
                  className="grid place-items-center w-7 h-7 rounded-md border border-[var(--border-light)] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--bg-secondary)]"
                >
                  <ArrowDownIcon size={15} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
