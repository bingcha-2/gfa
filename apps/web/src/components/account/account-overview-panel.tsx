"use client";

import Link from "next/link";
import {
  RefreshCwIcon,
  DownloadIcon,
  ReceiptTextIcon,
  BellIcon,
  MessageSquareIcon,
  LayersIcon,
} from "lucide-react";

import { AccountSkeleton } from "./account-ui";
import type {
  AccountOverview,
  OverviewSubscription,
  SubscriptionQuota,
} from "@/lib/account/user-types";
import { formatTokens } from "@/lib/format";

function pickBestSubscription(
  subscriptions: OverviewSubscription[]
): OverviewSubscription | null {
  if (subscriptions.length === 0) return null;
  const score = (sub: OverviewSubscription) => ({
    active: sub.status.toUpperCase() === "ACTIVE" ? 1 : 0,
    expiry: sub.expiresAt ? new Date(sub.expiresAt).getTime() : Number.MAX_SAFE_INTEGER,
  });
  return [...subscriptions].sort((a, z) => {
    const sa = score(a);
    const sz = score(z);
    if (sa.active !== sz.active) return sz.active - sa.active;
    return sz.expiry - sa.expiry;
  })[0];
}

function usedPercent(quota: SubscriptionQuota | null): number | null {
  if (!quota) return null;
  const first = quota.buckets[0];
  if (!first || first.limit <= 0) return null;
  return Math.min(100, Math.round((first.used / first.limit) * 100));
}

function productKey(p: string): "codex" | "claude" | "antigravity" | "" {
  const s = p.toLowerCase();
  if (s.includes("codex")) return "codex";
  if (s.includes("claude")) return "claude";
  if (s.includes("anti") || s.includes("gravity")) return "antigravity";
  return "";
}

function mmYY(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")} / ${String(d.getFullYear()).slice(2)}`;
}

function LoadingPanel() {
  return (
    <div className="account-overview" data-testid="account-overview-panel">
      <section className="account-overview-hero">
        <div className="account-overview-hero__copy">
          <AccountSkeleton className="account-skeleton--heading" />
          <AccountSkeleton className="account-skeleton--hero" />
        </div>
        <div className="account-overview-hero__side">
          <AccountSkeleton style={{ aspectRatio: "1.6 / 1", borderRadius: "22px" }} />
        </div>
      </section>
      <AccountSkeleton className="account-skeleton--row" />
    </div>
  );
}

export function AccountOverviewPanel({
  customerId,
  overview,
  loading,
  loadError,
}: {
  customerId: string;
  overview: AccountOverview | null;
  loading: boolean;
  loadError: boolean;
}) {
  const best = overview ? pickBestSubscription(overview.subscriptions) : null;
  const quota = best?.quota ?? null;
  const usedPct = usedPercent(quota);
  const remainPct = usedPct === null ? null : 100 - usedPct;
  const hasPlan = Boolean(best);

  const planName = best?.planName ?? (hasPlan ? "迁移卡密订阅" : "未开通套餐");
  const products = best?.products ?? [];
  const deviceCount = overview?.devices.count ?? 0;
  const deviceLimit = overview?.devices.limit ?? 0;
  const unread = overview?.unreadNotifications ?? 0;

  const expiresAt = best?.expiresAt ?? null;
  const validThru = expiresAt ? mmYY(expiresAt) : hasPlan ? "∞" : "—";

  const idRaw = (customerId || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const memberId = idRaw ? `${idRaw.slice(0, 4)} ${idRaw.slice(4, 8)}` : "————";

  const dotTotal = Math.min(deviceLimit || 0, 6);

  if (loading) return <LoadingPanel />;

  return (
    <div className="account-overview" data-testid="account-overview-panel">
      <section className="account-overview-hero">
        <div className="account-overview-hero__copy">
          <span className="account-overview-hero__eyebrow">
            <span
              className="account-status-lamp"
              data-tone={loadError ? "info" : hasPlan ? "success" : "brand"}
            />
            MEMBERSHIP · {loadError ? "状态读取异常" : hasPlan ? "运行中" : "待开通"}
          </span>
          <h1>
            你的<span className="am">冰茶</span>
            <br />
            会员通行证
          </h1>
          <p className="account-overview-hero__sub">
            一张通行证接管 <b>Codex</b>、<b>Claude Code</b> 与 <b>Antigravity</b>。授权、额度与续费,都在这里。
          </p>
          <div className="account-overview-hero__actions">
            <Link href="/account/billing" className="account-btn account-btn--primary">
              <RefreshCwIcon />
              {hasPlan ? "续费 / 购买套餐" : "购买套餐"}
            </Link>
            <Link href="/download" className="account-btn account-btn--secondary">
              <DownloadIcon />
              安装客户端
            </Link>
          </div>
        </div>

        <div className="account-overview-hero__side">
          <div className="account-pass-wrap">
            <div className="account-pass">
              <div className="account-pass__top">
                <div>
                  <div className="account-pass__lab">MEMBER PASS</div>
                  <div className="account-pass__brand">
                    <span className="mk">
                      <img src="/bcai-icon.png" alt="" />
                    </span>
                    冰茶AI
                  </div>
                </div>
                <span className="account-pass__tier">{hasPlan ? "ACTIVE" : "FREE"}</span>
              </div>
              <div className="account-pass__chip" aria-hidden />
              <div className="account-pass__mid">
                <div className="account-pass__plan">
                  {planName}
                  <small>{hasPlan ? "MEMBERSHIP · 冰茶AI" : "尚未开通套餐"}</small>
                </div>
                {dotTotal > 0 && (
                  <div className="account-pass__punch" title={`设备 ${deviceCount}/${deviceLimit}`}>
                    {Array.from({ length: dotTotal }).map((_, i) => (
                      <i key={i} data-off={i >= deviceCount || undefined} />
                    ))}
                  </div>
                )}
              </div>
              <div className="account-pass__bot">
                <div className="account-pass__id">
                  <small>MEMBER ID</small>
                  BCAI · {memberId}
                </div>
                <div className="account-pass__thru">
                  <small>VALID THRU</small>
                  <b>{validThru}</b>
                </div>
              </div>
            </div>
          </div>
          {products.length > 0 && (
            <div className="account-overview-hero__prod">
              <span className="pl">授权产品</span>
              <span className="account-prodchips">
                {products.map((p) => (
                  <span key={p} className="account-prodchip" data-p={productKey(p)}>
                    {p}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      </section>

      {loadError && (
        <p className="account-overview-error">
          数据加载失败,请稍后重试。已保留购买套餐和下载客户端入口。
        </p>
      )}

      <section className="account-overview-stats" aria-label="账户概览">
        <div>
          <span className="k">额度余量</span>
          <span className="v acc-mono" data-tone={remainPct !== null && remainPct > 20 ? "ok" : undefined}>
            {remainPct === null ? "—" : remainPct}
            {remainPct !== null && <small>%</small>}
          </span>
        </div>
        <div>
          <span className="k">设备席位</span>
          <span className="v acc-mono">
            {deviceCount}
            <small>/ {deviceLimit || "—"}</small>
          </span>
        </div>
        <div>
          <span className="k">本期用量</span>
          <span className="v acc-mono">
            {quota ? formatTokens(quota.recentWindowTokens) : "—"}
          </span>
        </div>
        <div>
          <span className="k">账号状态</span>
          <span className="v" data-tone={hasPlan ? "ok" : undefined}>
            {hasPlan ? "正常" : "未开通"}
          </span>
        </div>
      </section>

      <section className="account-overview-grid" aria-label="快捷入口">
        <Link href="/account/subscriptions" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <LayersIcon />
            </span>
          </div>
          <div className="account-quick-card__title">我的订阅</div>
          <div className="account-quick-card__desc">查看全部订阅 · 调整接力优先级</div>
        </Link>
        <Link href="/account/billing" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <ReceiptTextIcon />
            </span>
          </div>
          <div className="account-quick-card__title">订单与支付</div>
          <div className="account-quick-card__desc">待支付、扫码与历史记录</div>
        </Link>
        <Link href="/account/notifications" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <BellIcon />
            </span>
            {unread > 0 && <span className="account-quick-card__badge">{unread} 未读</span>}
          </div>
          <div className="account-quick-card__title">通知中心</div>
          <div className="account-quick-card__desc">续费、登录与系统提醒</div>
        </Link>
        <Link href="/download" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <DownloadIcon />
            </span>
          </div>
          <div className="account-quick-card__title">下载客户端</div>
          <div className="account-quick-card__desc">桌面端接管你的 AI 工具</div>
        </Link>
        <Link href="/account/tickets" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <MessageSquareIcon />
            </span>
          </div>
          <div className="account-quick-card__title">工单支持</div>
          <div className="account-quick-card__desc">遇到问题随时联系我们</div>
        </Link>
      </section>
    </div>
  );
}
