import React, { useState, useEffect, useCallback } from "react";
import type { RosettaAccount } from "../lib/rosetta-types";
import { sendRosettaAction } from "../lib/rosetta-api";
import { RosettaQuota } from "./rosetta-quota";

export function RosettaAccounts({
  accounts,
  proxyRunning,
  employeeMode = false,
  clientMode = false,
}: {
  accounts: RosettaAccount[];
  proxyRunning: boolean;
  employeeMode?: boolean;
  clientMode?: boolean;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<"all" | "active" | "error">("all");
  // Track accounts that have been auto-expanded from being active
  const [autoExpandedIds, setAutoExpandedIds] = useState<Set<number>>(new Set());
  // Warmup state tracking
  const [warmingIds, setWarmingIds] = useState<Set<number>>(new Set());
  const [warmupResults, setWarmupResults] = useState<Map<number, { ok: boolean; error?: string; projectId?: string; verificationUrl?: string }>>(new Map());

  // Listen for warmup results from the extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "rosetta:warmupResult") {
        const payload = data.payload;
        const accId = accounts.find(a => a.email === payload.email)?.id;
        if (accId !== undefined) {
          setWarmingIds(prev => {
            const next = new Set(prev);
            next.delete(accId);
            return next;
          });
          setWarmupResults(prev => {
            const next = new Map(prev);
            next.set(accId, {
              ok: payload.ok,
              error: payload.error,
              projectId: payload.projectId,
              verificationUrl: payload.verificationUrl,
            });
            return next;
          });
          // Auto-clear success results after 8 seconds
          if (payload.ok) {
            setTimeout(() => {
              setWarmupResults(prev => {
                const next = new Map(prev);
                next.delete(accId!);
                return next;
              });
            }, 8000);
          }
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [accounts]);

  const handleWarmup = useCallback((accountId: number) => {
    setWarmingIds(prev => new Set([...prev, accountId]));
    setWarmupResults(prev => {
      const next = new Map(prev);
      next.delete(accountId);
      return next;
    });
    sendRosettaAction("rosetta:warmupAccount", { accountId });
  }, []);
  // Auto-expand newly active accounts (but user can still collapse them)
  React.useEffect(() => {
    accounts.forEach((acc) => {
      if (acc.isActive && !autoExpandedIds.has(acc.id) && !expandedIds.has(acc.id)) {
        setExpandedIds((prev) => new Set([...prev, acc.id]));
        setAutoExpandedIds((prev) => new Set([...prev, acc.id]));
      }
    });
  }, [accounts]);

  if (!accounts.length) {
    return <div className="rosetta-empty">账号池为空，请新增即可。</div>;
  }

  const filtered = accounts.filter((a) => {
    if (filter === "active" && !a.enabled) return false;
    if (filter === "error" && a.quotaStatus === "ok" && !a.quotaLiveBlockedCount && a.canRotate) return false;
    return true;
  });

  // Sort: active first, enabled before disabled, errored before normal
  filtered.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return 0;
  });

  const toggle = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="rosetta-accounts">
      <div className="rosetta-accounts-header">
        <span className="rosetta-label">账号池 ({accounts.length})</span>
        <div className="rosetta-filter-chips">
          {(["all", "active", "error"] as const).map((f) => (
            <button
              key={f}
              className={`rosetta-chip ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "全部" : f === "active" ? "可用" : "受限"}
            </button>
          ))}
        </div>
      </div>

      {filtered.map((acc) => {
        const isExpanded = expandedIds.has(acc.id);
        const toneCls = !acc.enabled
          ? "muted"
          : acc.accountStatusTone === "danger"
            ? "danger"
            : acc.accountStatusTone === "warning"
              ? "warning"
              : "success";

        return (
          <div
            key={acc.id}
            className={`rosetta-acc-card ${acc.isActive ? "active" : ""} ${!acc.enabled ? "disabled" : ""} ${isExpanded ? "expanded" : ""}`}
          >
            {/* Header */}
            <div className="rosetta-acc-header" onClick={() => toggle(acc.id)}>
              <span className={`rosetta-acc-dot ${toneCls}`} />
              <div className="rosetta-acc-identity">
                {acc.alias && <span className="rosetta-acc-alias">{acc.alias}</span>}
                <span className="rosetta-acc-email">{acc.email}</span>
              </div>
              <div className="rosetta-acc-badges">
                {acc.isActive && <span className="rosetta-badge warn">使用中</span>}
                {acc.planType && (
                  <span className={`rosetta-badge plan-${acc.planType.toLowerCase().includes('ultra') ? 'ultra' : acc.planType.toLowerCase().includes('premium') ? 'premium' : acc.planType.toLowerCase().includes('standard') ? 'standard' : 'free'}`}>
                    {acc.planType.toUpperCase()}
                  </span>
                )}
                <span className={`rosetta-badge ${acc.hasCredentials ? "cred-ok" : "cred-missing"}`} title={acc.hasCredentials ? "密码和TOTP已录入" : "未录入凭据"}>
                  {acc.hasCredentials ? "🔑" : "🔒"}
                </span>
                {acc.qualityTier && acc.qualityTier !== "new" && (
                  <span
                    className={`rosetta-badge ${
                      acc.qualityTier === "excellent" ? "tier-excellent"
                      : acc.qualityTier === "good" ? "tier-good"
                      : acc.qualityTier === "poor" ? "tier-poor"
                      : "tier-bad"
                    }`}
                    title={`成功率: ${acc.successRate ?? "—"}% (${acc.requestStats.successes}/${acc.requestStats.total})`}
                  >
                    {acc.qualityTier === "excellent" ? "⭐" : acc.qualityTier === "good" ? "👍" : acc.qualityTier === "poor" ? "👎" : "💀"}
                    {" "}{acc.successRate ?? "—"}%
                  </span>
                )}
                {employeeMode && acc.employeeSubmittedAt && (
                  <span className="rosetta-badge success">已入池</span>
                )}
                {employeeMode && acc.projectId && !acc.employeeSubmittedAt && (
                  <span className="rosetta-badge warning">待上报</span>
                )}
                {acc.accountStatusLabel && (
                  <span className={`rosetta-badge ${toneCls}`}>{acc.accountStatusLabel}</span>
                )}
              </div>
              <span className={`rosetta-chevron ${isExpanded ? "open" : ""}`}>▸</span>
            </div>

            {/* Body (expanded) */}
            {isExpanded && (() => {
              const isWarming = warmingIds.has(acc.id);
              const warmupResult = warmupResults.get(acc.id);
              const needsWarmup = !acc.projectId;
              return (
              <div className="rosetta-acc-body">
                <div className="rosetta-acc-actions">
                  <button
                    className={`rosetta-btn-sm ${acc.isActive ? "" : "accent"}`}
                    disabled={acc.isActive || !acc.enabled || !proxyRunning}
                    onClick={() => sendRosettaAction("rosetta:switchAccount", { accountId: acc.id })}
                  >
                    {acc.isActive ? "正在服务" : "切到此号"}
                  </button>
                  <button
                    className="rosetta-btn-sm"
                    onClick={() => sendRosettaAction("rosetta:toggleAccount", { accountId: acc.id })}
                  >
                    {acc.enabled ? "停用" : "恢复"}
                  </button>
                  <button
                    className="rosetta-btn-sm"
                    onClick={() => sendRosettaAction("rosetta:editAlias", { accountId: acc.id })}
                  >
                    别名
                  </button>
                  {!clientMode && (
                    <>
                      <button
                        className={`rosetta-btn-sm ${acc.hasCredentials ? "" : "accent"}`}
                        onClick={() => sendRosettaAction("rosetta:editCredentials", { accountId: acc.id })}
                        title={acc.hasCredentials ? "编辑登录凭据（已配置）" : "录入密码和TOTP（未配置）"}
                      >
                        {acc.hasCredentials ? "凭据" : "凭据"}
                      </button>
                      <button
                        className={`rosetta-btn-sm ${acc.lastVerifiedPhone?.phoneNumber ? "" : "accent"}`}
                        onClick={() => sendRosettaAction("rosetta:editAccountPhone", { accountId: acc.id })}
                        title={acc.lastVerifiedPhone?.phoneNumber
                          ? `手机号：${acc.lastVerifiedPhone.countryCode || "+1"} ${acc.lastVerifiedPhone.phoneNumber}`
                          : "查看或补录最近一次验证手机号"}
                      >
                        手机
                      </button>
                    </>
                  )}
                  {!employeeMode && !clientMode && (
                    <button
                      className="rosetta-btn-sm"
                      onClick={() => sendRosettaAction("rosetta:repairAccount", { accountId: acc.id })}
                      title={acc.hasCredentials ? "使用本地 AdsPower 浏览器修复此账号" : "使用后台保存的凭据修复此账号"}
                    >
                      修复
                    </button>
                  )}
                  {needsWarmup && (
                    <button
                      className={`rosetta-btn-sm warmup ${isWarming ? "warming" : ""}`}
                      disabled={isWarming}
                      onClick={() => handleWarmup(acc.id)}
                      title="重新尝试获取项目号 (预热)"
                    >
                      {isWarming ? "⏳ 预热中…" : "🔥 预热"}
                    </button>
                  )}
                  <button
                    className="rosetta-btn-sm danger"
                    disabled={acc.isActive}
                    onClick={() => sendRosettaAction("rosetta:deleteAccount", { accountId: acc.id })}
                  >
                    删除
                  </button>
                </div>

                {/* Warmup result feedback */}
                {warmupResult && (
                  <div className={`rosetta-warmup-result ${warmupResult.ok ? "success" : "error"}`}>
                    {warmupResult.ok
                      ? `✅ 预热成功，项目号: ${warmupResult.projectId}`
                      : `❌ ${warmupResult.error}`}
                    {!warmupResult.ok && warmupResult.verificationUrl && (
                      <button
                        className="rosetta-btn-sm accent warmup-verify-btn"
                        onClick={() => {
                          sendRosettaAction("rosetta:openExternal", { url: warmupResult.verificationUrl });
                        }}
                        title={warmupResult.verificationUrl}
                        style={{ marginLeft: 8 }}
                      >
                        🔗 去验证
                      </button>
                    )}
                  </div>
                )}

                <RosettaQuota groups={acc.quotaGroups} refreshedAt={acc.quotaRefreshedAt} />
                {employeeMode && (
                  <div className="rosetta-hint" style={{ marginTop: 8 }}>
                    {acc.employeeSubmittedAt
                      ? "此账号已自动进入中央号池。"
                      : acc.projectId
                        ? "已有项目号，等待自动上报入池。"
                        : "请先预热拿到项目号。"}
                  </div>
                )}
              </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}
