import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAppStore, type QuotaInfo } from "../stores/useAppStore";
import {
  Upload, Trash2, Copy, Zap, Key, RefreshCw, Terminal,
  ChevronDown, ChevronUp, CheckCircle, XCircle, Loader,
  Download, Search, LayoutGrid, List, Lock,
} from "lucide-react";

type ViewMode = "grid" | "list";
type StatusFilter = "all" | "active" | "failed" | "no-token" | "has-token";

export function Accounts() {
  const {
    accounts, importAccounts, deleteAccount, loadAccounts,
    isRunning,
    startAntigravityOAuth, switchAntigravityAccount, batchAntigravityOAuth,
    oauthProgress, fetchQuota, quotaCache,
    logs, clearLogs,
  } = useAppStore();

  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [switchingEmail, setSwitchingEmail] = useState<string | null>(null);
  const [switchResult, setSwitchResult] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [refreshResult, setRefreshResult] = useState<Record<string, "success" | "error">>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showLogs, setShowLogs] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem("gfa-accounts-view") as ViewMode) || "grid";
  });

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("gfa-accounts-view", mode);
  };

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLogs]);

  const quotaFetched = useRef(false);
  useEffect(() => {
    if (quotaFetched.current) return;
    const tokenAccounts = accounts.filter((a) => a.antigravity_token && !quotaCache[a.email]);
    if (tokenAccounts.length > 0) {
      quotaFetched.current = true;
      tokenAccounts.forEach((a) => fetchQuota(a.email));
    }
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    let result = [...accounts];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((a) => a.email.toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      result = result.filter((a) => {
        switch (statusFilter) {
          case "active": return a.status === "active";
          case "failed": return a.status === "login_failed" || a.status === "locked";
          case "has-token": return !!a.antigravity_token;
          case "no-token": return !a.antigravity_token;
          default: return true;
        }
      });
    }
    return result;
  }, [accounts, searchQuery, statusFilter]);

  const handleImport = async () => {
    if (!importText.trim()) return;
    setImporting(true); setImportError(null); setImportSuccess(null);
    try {
      const result = await importAccounts(importText);
      setImportText(""); setImportSuccess(`成功导入 ${result.length} 个账号`); setShowImport(false);
    } catch (e) { setImportError(String(e)); }
    finally { setImporting(false); }
  };

  const handleSwitch = async (email: string) => {
    setSwitchingEmail(email); setSwitchResult(null);
    try {
      const result = await switchAntigravityAccount(email);
      setSwitchResult(result);
      setTimeout(() => setSwitchResult(null), 5000);
    } catch (e) {
      setSwitchResult(`切换失败: ${String(e)}`);
      setTimeout(() => setSwitchResult(null), 8000);
    } finally { setSwitchingEmail(null); }
  };

  const handleRefreshQuota = useCallback(async (email: string) => {
    setRefreshing((prev) => new Set(prev).add(email));
    try {
      await fetchQuota(email);
      setRefreshResult((prev) => ({ ...prev, [email]: "success" }));
      setTimeout(() => setRefreshResult((prev) => { const n = { ...prev }; delete n[email]; return n; }), 2000);
    } catch {
      setRefreshResult((prev) => ({ ...prev, [email]: "error" }));
      setTimeout(() => setRefreshResult((prev) => { const n = { ...prev }; delete n[email]; return n; }), 2000);
    } finally {
      setRefreshing((prev) => { const n = new Set(prev); n.delete(email); return n; });
    }
  }, [fetchQuota]);

  const handleRefreshAll = async () => {
    const toRefresh = filteredAccounts.filter((a) => a.antigravity_token);
    await Promise.allSettled(toRefresh.map((a) => handleRefreshQuota(a.email)));
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const toggleSelectAll = () => {
    setSelected(selected.size === filteredAccounts.length ? new Set() : new Set(filteredAccounts.map((a) => a.id)));
  };

  const handleBatchDelete = async () => {
    if (selected.size === 0) return;
    for (const email of accounts.filter((a) => selected.has(a.id)).map((a) => a.email)) {
      await deleteAccount(email);
    }
    setSelected(new Set());
  };

  const countNoToken = accounts.filter((a) => !a.antigravity_token).length;

  const filterOptions: { value: StatusFilter; label: string; count: number }[] = [
    { value: "all", label: "全部", count: accounts.length },
    { value: "active", label: "活跃", count: accounts.filter((a) => a.status === "active").length },
    { value: "has-token", label: "已授权", count: accounts.filter((a) => !!a.antigravity_token).length },
    { value: "no-token", label: "未授权", count: countNoToken },
    { value: "failed", label: "异常", count: accounts.filter((a) => a.status === "login_failed" || a.status === "locked").length },
  ];

  function getQuotaClass(pct: number) { return pct > 60 ? "high" : pct > 25 ? "medium" : "low"; }

  function formatResetTime(rt: string): string {
    if (!rt) return "";
    try {
      const d = new Date(rt);
      const diff = d.getTime() - Date.now();
      if (diff <= 0) return "已重置";
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      return h > 0 ? `${h}h${m}m 后重置` : `${m}m 后重置`;
    } catch { return ""; }
  }

  function getQuotaDisplayItems(quota: QuotaInfo) {
    if (!quota || quota.error || quota.is_forbidden) return [];
    return quota.models
      .filter((m) => {
        const l = (m.display_name || m.name).toLowerCase();
        return (l.includes("claude") && l.includes("opus"))
          || (l.includes("gemini") && l.includes("pro") && l.includes("high"));
      })
      .map((m) => ({
        key: m.name,
        label: (m.display_name || m.name).replace(/^models\//, "").split("/").pop() || m.name,
        percentage: m.percentage,
        resetTime: m.reset_time,
      }));
  }

  function getTierBadge(quota?: QuotaInfo) {
    if (!quota || quota.error) return null;
    if (quota.is_forbidden) return { label: "FORBIDDEN", cls: "free" };
    const tier = quota.subscription_tier || "";
    if (!tier) return null;
    const t = tier.toLowerCase();
    if (t.includes("ultra")) return { label: tier, cls: "ultra" };
    if (t.includes("pro")) return { label: tier, cls: "pro" };
    return { label: tier, cls: "free" };
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">账号管理</h1>
        <p className="page-subtitle">导入、管理 Google 账号与 Antigravity 授权</p>
      </div>
      <div className="page-body">
        {/* OAuth Progress */}
        {oauthProgress && (
          <div className="card" style={{ borderColor: "rgba(59,130,246,0.4)" }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Loader size={14} className="spinning" style={{ color: "var(--primary)" }} />
                <span className="text-sm font-semibold">自动授权中</span>
              </div>
              <span className="badge badge-accent">{oauthProgress.current} / {oauthProgress.total}</span>
            </div>
            <div className="text-xs text-muted mb-2">正在授权: {oauthProgress.email}</div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${(oauthProgress.current / oauthProgress.total) * 100}%` }} />
            </div>
          </div>
        )}

        {switchResult && (
          <div className="card" style={{ padding: "12px 16px", fontSize: 13, color: switchResult.includes("失败") ? "var(--danger)" : "var(--success)", borderColor: switchResult.includes("失败") ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)" }}>
            {switchResult}
          </div>
        )}

        {importSuccess && (
          <div className="card" style={{ padding: "12px 16px", borderColor: "rgba(34,197,94,0.3)" }}>
            <span className="flex items-center gap-2" style={{ color: "var(--success)", fontSize: 13 }}>
              <CheckCircle size={14} /> {importSuccess}
            </span>
          </div>
        )}

        {/* Toolbar */}
        <div className="toolbar">
          <div className="toolbar-left">
            <div className="search-box">
              <Search size={14} className="search-icon" />
              <input placeholder="搜索邮箱..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>
            <div className="filter-tabs">
              {filterOptions.map((f) => (
                <button key={f.value} className={`filter-tab ${statusFilter === f.value ? "active" : ""}`} onClick={() => setStatusFilter(f.value)}>
                  {f.label}
                  <span className="count">{f.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-right">
            <div className="view-switcher">
              <button className={`view-btn ${viewMode === "grid" ? "active" : ""}`} onClick={() => handleViewModeChange("grid")}><LayoutGrid size={13} /></button>
              <button className={`view-btn ${viewMode === "list" ? "active" : ""}`} onClick={() => handleViewModeChange("list")}><List size={13} /></button>
            </div>
            {selected.size > 0 && (
              <button className="btn btn-danger btn-sm" onClick={handleBatchDelete}><Trash2 size={12} /> 删除 ({selected.size})</button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(!showImport)}><Upload size={13} /> 导入</button>
            <button className="btn btn-secondary btn-sm" onClick={() => { loadAccounts(); useAppStore.setState({ quotaCache: {} }); quotaFetched.current = false; }} title="刷新"><RefreshCw size={13} /></button>
            {countNoToken > 0 && (
              <button className="btn btn-primary btn-sm" onClick={() => batchAntigravityOAuth(accounts.filter((a) => !a.antigravity_token).map((a) => a.email))} disabled={isRunning}>
                <Key size={12} /> 批量授权 ({countNoToken})
              </button>
            )}
          </div>
        </div>

        {/* Import Panel */}
        {showImport && (
          <div className="import-panel animate-in">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold">导入账号</span>
              <span className="text-xs text-muted">格式: email----password----recoveryEmail----totpSecret</span>
            </div>
            <textarea className="input" rows={3} placeholder={`每行一个账号\nuser@gmail.com----password----recovery@mail.com----totpSecret`} value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div className="flex items-center gap-2 mt-2">
              <button className="btn btn-primary btn-sm" onClick={handleImport} disabled={importing || !importText.trim()}>
                <Upload size={13} /> {importing ? "导入中..." : "确认导入"}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(false)}>取消</button>
              {importError && <span style={{ color: "var(--danger)", fontSize: 12 }}>{importError}</span>}
            </div>
          </div>
        )}

        {/* Selection bar */}
        {filteredAccounts.length > 0 && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={selected.size === filteredAccounts.length && filteredAccounts.length > 0} onChange={toggleSelectAll} style={{ accentColor: "var(--primary)" }} />
              <span className="text-muted">{selected.size > 0 ? `已选 ${selected.size} / ${filteredAccounts.length}` : `${filteredAccounts.length} 个账号`}</span>
            </label>
            {filteredAccounts.some((a) => a.antigravity_token) && (
              <button className="btn btn-ghost btn-sm ml-auto" onClick={handleRefreshAll} disabled={refreshing.size > 0}>
                <RefreshCw size={11} className={refreshing.size > 0 ? "spinning" : ""} /> 刷新全部额度
              </button>
            )}
          </div>
        )}

        {/* Content */}
        {filteredAccounts.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <div className="icon">{accounts.length === 0 ? <Upload size={28} /> : <Search size={28} />}</div>
              <h3>{accounts.length === 0 ? "还没有账号" : "没有匹配结果"}</h3>
              <p>{accounts.length === 0 ? "点击上方的「导入」按钮添加 Google 账号" : "试试调整搜索或过滤条件"}</p>
            </div>
          </div>
        ) : viewMode === "grid" ? (
          /* ─── Grid View ────────────────────────────────────────── */
          <div className="accounts-grid">
            {filteredAccounts.map((account) => {
              const quota = quotaCache[account.email];
              const hasToken = !!account.antigravity_token;
              const isRefreshing = refreshing.has(account.email);
              const rResult = refreshResult[account.email];
              const isSelected = selected.has(account.id);
              const quotaItems = hasToken && quota ? getQuotaDisplayItems(quota) : [];
              const tierBadge = getTierBadge(quota);

              return (
                <div className={`account-card ${isSelected ? "selected" : ""}`} key={account.id}>
                  {/* Top row */}
                  <div className="card-top">
                    <div className="card-select">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(account.id)} />
                    </div>
                    <span className="account-email" title={account.email}>{account.email}</span>
                    <StatusPill status={account.status} />
                    {hasToken && <span className="status-pill active">Token</span>}
                    {tierBadge && <span className={`tier-badge ${tierBadge.cls}`}>{tierBadge.label}</span>}
                  </div>

                  {/* Quota Grid */}
                  <div className="card-quota-grid">
                    {quota?.is_forbidden ? (
                      <div className="quota-empty" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--danger)" }}>
                        <Lock size={14} /> 账号被禁止访问
                      </div>
                    ) : quotaItems.length > 0 ? (
                      <>
                        {quotaItems.map((item) => (
                          <div key={item.key} className="quota-compact-item">
                            <div className="quota-compact-header">
                              <span className="model-label">{item.label}</span>
                              <span className={`model-pct ${getQuotaClass(item.percentage)}`}>{item.percentage}%</span>
                            </div>
                            <div className="quota-compact-bar-track">
                              <div className={`quota-compact-bar ${getQuotaClass(item.percentage)}`} style={{ width: `${item.percentage}%` }} />
                            </div>
                            {item.resetTime && <span className="quota-compact-reset">{formatResetTime(item.resetTime)}</span>}
                          </div>
                        ))}
                      </>
                    ) : hasToken ? (
                      <div className="quota-empty">暂无配额数据</div>
                    ) : (
                      <div className="quota-empty">未授权 — 无法获取配额</div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="card-footer">
                    <span className="card-date">{new Date(account.created_at).toLocaleDateString("zh-CN")}</span>
                    <div className="card-actions">
                      <button className="card-action-btn" onClick={() => navigator.clipboard.writeText(account.email)} title="复制邮箱"><Copy size={11} /></button>
                      {hasToken && (
                        <button className="card-action-btn" onClick={() => {
                          navigator.clipboard.writeText(JSON.stringify({ refresh_token: account.antigravity_token!.refresh_token }));
                          setSwitchResult(`refresh_token 已复制 (${account.email})`);
                          setTimeout(() => setSwitchResult(null), 3000);
                        }} title="导出 token"><Download size={11} /></button>
                      )}
                      {hasToken && (
                        <button className="card-action-btn" onClick={() => handleRefreshQuota(account.email)} disabled={isRefreshing} title="刷新额度">
                          {isRefreshing ? <Loader size={11} className="spinning" /> :
                            rResult === "success" ? <CheckCircle size={11} style={{ color: "var(--success)" }} /> :
                            rResult === "error" ? <XCircle size={11} style={{ color: "var(--danger)" }} /> :
                            <RefreshCw size={11} />}
                        </button>
                      )}
                      <button className="card-action-btn is-danger" onClick={() => deleteAccount(account.email)} title="删除"><Trash2 size={11} /></button>
                    </div>
                  </div>
                  {/* Primary Action */}
                  {hasToken ? (
                    <button className="btn btn-primary btn-sm w-full" onClick={() => handleSwitch(account.email)} disabled={switchingEmail !== null} style={{ marginTop: -4 }}>
                      <Zap size={13} /> 切号
                    </button>
                  ) : (
                    <button className="btn btn-secondary btn-sm w-full" onClick={() => startAntigravityOAuth(account.email)} disabled={isRunning} style={{ marginTop: -4, borderColor: "rgba(59,130,246,0.4)", color: "var(--primary)" }}>
                      <Key size={13} /> 授权认证
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* ─── List View ────────────────────────────────────────── */
          <div className="account-table-container">
            <table className="account-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <th>邮箱</th>
                  <th>状态</th>
                  <th>订阅</th>
                  <th>配额</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((account) => {
                  const quota = quotaCache[account.email];
                  const hasToken = !!account.antigravity_token;
                  const isSelected = selected.has(account.id);
                  const isRefreshing = refreshing.has(account.email);
                  const rResult = refreshResult[account.email];
                  const tierBadge = getTierBadge(quota);
                  const quotaItems = hasToken && quota ? getQuotaDisplayItems(quota) : [];

                  return (
                    <tr key={account.id} className={isSelected ? "selected" : ""}>
                      <td><input type="checkbox" checked={isSelected} onChange={() => toggleSelect(account.id)} style={{ accentColor: "var(--primary)" }} /></td>
                      <td>
                        <span className="account-email-text">{account.email}</span>
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <StatusPill status={account.status} />
                          {hasToken && <span className="status-pill active">Token</span>}
                        </div>
                      </td>
                      <td>{tierBadge ? <span className={`tier-badge ${tierBadge.cls}`}>{tierBadge.label}</span> : <span className="text-muted">—</span>}</td>
                      <td>
                        {quotaItems.length > 0 ? (
                          <div className="flex items-center gap-2">
                            {quotaItems.slice(0, 1).map((item) => (
                              <span key={item.key} className={`model-pct ${getQuotaClass(item.percentage)}`} style={{ fontSize: 12 }}>{item.label}: {item.percentage}%</span>
                            ))}
                          </div>
                        ) : <span className="text-muted text-xs">—</span>}
                      </td>
                      <td>
                        <div className="action-buttons" style={{ justifyContent: "flex-end" }}>
                          {hasToken && (
                            <button className="action-btn" onClick={() => handleRefreshQuota(account.email)} disabled={isRefreshing} title="刷新额度">
                              {isRefreshing ? <Loader size={13} className="spinning" /> :
                                rResult === "success" ? <CheckCircle size={13} style={{ color: "var(--success)" }} /> :
                                rResult === "error" ? <XCircle size={13} style={{ color: "var(--danger)" }} /> :
                                <RefreshCw size={13} />}
                            </button>
                          )}
                          {hasToken ? (
                            <button className="action-btn is-success" onClick={() => handleSwitch(account.email)} disabled={switchingEmail !== null} title="切号">
                              <Zap size={14} />
                            </button>
                          ) : (
                            <button className="action-btn" onClick={() => startAntigravityOAuth(account.email)} disabled={isRunning} title="授权">
                              <Key size={14} />
                            </button>
                          )}
                          <button className="action-btn is-danger" onClick={() => deleteAccount(account.email)} title="删除"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Log Panel */}
        <div className="card">
          <div className="card-header collapsible-header" onClick={() => setShowLogs(!showLogs)}>
            <div className="flex items-center gap-2">
              <Terminal size={14} />
              <span>运行日志</span>
              {logs.length > 0 && <span className="badge badge-neutral" style={{ fontSize: 10 }}>{logs.length}</span>}
            </div>
            <div className="flex items-center gap-2">
              {logs.length > 0 && <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); clearLogs(); }}>清除</button>}
              {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </div>
          {showLogs && (
            <div className="log-stream" style={{ maxHeight: 300 }}>
              <div className="log-stream-header">
                <div className="log-stream-dot red" />
                <div className="log-stream-dot yellow" />
                <div className="log-stream-dot green" />
              </div>
              {logs.length === 0 ? (
                <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>暂无日志</div>
              ) : logs.map((log) => (
                <div key={log.id} className="log-line">
                  <span className={`log-icon ${log.status || ""}`}>
                    {log.status === "running" ? <Loader size={12} /> : log.status === "done" ? <CheckCircle size={12} /> : log.status === "failed" ? <XCircle size={12} /> : "›"}
                  </span>
                  <span className={`log-text ${log.level === "ERROR" ? "error" : ""}`}>{log.message || `${log.step}: ${log.detail || log.status}`}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  switch (status) {
    case "active": return <span className="status-pill active">活跃</span>;
    case "login_failed": return <span className="status-pill danger">失败</span>;
    case "locked": return <span className="status-pill danger">锁定</span>;
    case "disabled": return <span className="status-pill warning">停用</span>;
    default: return <span className="status-pill info">新</span>;
  }
}
