import { useState, useEffect, useRef } from "react";
import { useAppStore, type QuotaInfo } from "../stores/useAppStore";
import { Upload, Trash2, TestTube, Mail, Copy, Zap, Key, RefreshCw, Terminal, ChevronDown, ChevronUp, CheckCircle, XCircle, Loader, Download } from "lucide-react";

export function Accounts() {
  const {
    accounts, importAccounts, deleteAccount, runTestLogin, loadAccounts,
    isRunning, setCurrentPage,
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
  const [refreshingQuota, setRefreshingQuota] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLogs]);

  // 仅在首次加载时查询有 token 的账号额度（不在 accounts 变化时反复触发）
  const quotaFetched = useRef(false);
  useEffect(() => {
    if (quotaFetched.current) return;
    const tokenAccounts = accounts.filter((a) => a.antigravity_token && !quotaCache[a.email]);
    if (tokenAccounts.length > 0) {
      quotaFetched.current = true;
      tokenAccounts.forEach((a) => fetchQuota(a.email));
    }
  }, [accounts]);

  const handleImport = async () => {
    if (!importText.trim()) return;
    console.log("[Import] 开始导入...");
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      console.log("[Import] 调用 importAccounts...");
      const result = await importAccounts(importText);
      console.log("[Import] 导入完成, 结果:", result.length, "个账号");
      setImportText("");
      setImportSuccess(`成功导入 ${result.length} 个账号`);
    } catch (e) {
      console.error("[Import] 导入失败:", e);
      setImportError(String(e));
    } finally {
      console.log("[Import] 流程结束");
      setImporting(false);
    }
  };

  const handleSwitch = async (email: string) => {
    console.log("[Switch] 开始切号:", email);
    setSwitchingEmail(email);
    setSwitchResult(null);
    try {
      const result = await switchAntigravityAccount(email);
      console.log("[Switch] 切号结果:", result);
      setSwitchResult(result);
      setTimeout(() => setSwitchResult(null), 5000);
    } catch (e) {
      console.error("[Switch] 切号失败:", e);
      setSwitchResult(`❌ ${String(e)}`);
      setTimeout(() => setSwitchResult(null), 8000);
    } finally {
      setSwitchingEmail(null);
    }
  };

  const handleRefreshQuota = async (email: string) => {
    setRefreshingQuota(email);
    await fetchQuota(email);
    setRefreshingQuota(null);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">账号管理</h1>
        <p className="page-subtitle">导入 Google 账号凭据，管理所有账号</p>
      </div>
      <div className="page-body animate-in">
        {/* Import card */}
        <div className="card mb-4">
          <div className="card-header">
            <span>导入账号</span>
            <span className="text-sm text-muted">格式: email----password----recoveryEmail----totpSecret</span>
          </div>
          <textarea
            className="input"
            rows={4}
            placeholder={`每行一个账号，例如：\nuser@gmail.com----password----recovery@mail.com----totpSecret...`}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="flex items-center gap-2 mt-3">
            <button className="btn btn-primary" onClick={handleImport} disabled={importing || !importText.trim()}>
              <Upload size={14} />
              {importing ? "导入中..." : "导入账号"}
            </button>
            {importSuccess && <span style={{ color: "var(--color-success)", fontSize: 13 }}>{importSuccess}</span>}
            {importError && <span style={{ color: "var(--color-danger)", fontSize: 13 }}>{importError}</span>}
          </div>
        </div>

        {/* OAuth Progress */}
        {oauthProgress && (
          <div className="card mb-4" style={{ borderColor: "var(--color-primary)" }}>
            <div className="card-header">
              <span>🔐 自动授权中</span>
              <span className="text-sm" style={{ color: "var(--color-primary)" }}>
                {oauthProgress.current} / {oauthProgress.total}
              </span>
            </div>
            <div style={{ padding: "12px 16px" }}>
              <div style={{ fontSize: 13, color: "var(--color-text-muted)", marginBottom: 8 }}>
                正在授权: {oauthProgress.email}
              </div>
              <div style={{ height: 4, borderRadius: 2, background: "var(--color-bg-elevated)" }}>
                <div style={{
                  height: "100%", borderRadius: 2,
                  background: "var(--color-primary)",
                  width: `${(oauthProgress.current / oauthProgress.total) * 100}%`,
                  transition: "width 0.3s",
                }} />
              </div>
            </div>
          </div>
        )}

        {/* Switch result toast */}
        {switchResult && (
          <div className="card mb-4" style={{
            borderColor: switchResult.startsWith("❌") ? "var(--color-danger)" : "var(--color-success)",
            padding: "12px 16px", fontSize: 13,
          }}>
            {switchResult}
          </div>
        )}

        {/* Account cards */}
        <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>账号列表 ({accounts.length})</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { 
              loadAccounts(); 
              useAppStore.setState({ quotaCache: {} });
              quotaFetched.current = false; 
            }}
            title="刷新列表"
            style={{ padding: 2 }}
          >
            <RefreshCw size={13} />
          </button>
          {accounts.filter((a) => !a.antigravity_token).length > 0 && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                const emails = accounts.filter((a) => !a.antigravity_token).map((a) => a.email);
                batchAntigravityOAuth(emails);
              }}
              disabled={isRunning}
              style={{ marginLeft: "auto" }}
            >
              <Key size={12} />
              批量授权 ({accounts.filter((a) => !a.antigravity_token).length})
            </button>
          )}
        </div>
        {accounts.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <Upload />
              <p>粘贴凭据到上方文本框导入账号</p>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {accounts.map((account) => {
              const quota = quotaCache[account.email];
              const hasToken = !!account.antigravity_token;
              return (
                <div className="card" key={account.id} style={{ padding: 0, overflow: "hidden" }}>
                  {/* 头部：邮箱 + 状态标签 + 操作按钮 */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "14px 16px",
                    borderBottom: "1px solid var(--color-border)",
                  }}>
                    {/* 邮箱 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-center gap-2">
                        <span style={{ fontWeight: 600, fontSize: 14 }} className="truncate">{account.email}</span>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => navigator.clipboard.writeText(account.email)}
                          title="复制"
                          style={{ padding: 2 }}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
                        <StatusBadge status={account.status} />
                        <TokenBadge token={account.antigravity_token} />
                        {quota && <TierBadge quota={quota} />}
                        {account.totp_secret && <span className="badge badge-success" style={{ fontSize: 10 }}>TOTP</span>}
                      </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex gap-1" style={{ flexShrink: 0 }}>
                      {hasToken ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleSwitch(account.email)}
                          disabled={switchingEmail !== null}
                          title="一键切号：注入 Token + 切换指纹 + 重启 Antigravity"
                        >
                          <Zap size={12} />
                          {switchingEmail === account.email ? "切换中..." : "切号"}
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => startAntigravityOAuth(account.email)}
                          disabled={isRunning}
                          title="Antigravity OAuth 授权"
                        >
                          <Key size={12} />
                          授权
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => runTestLogin(account.email)} disabled={isRunning} title="测试登录">
                        <TestTube size={12} />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage("accept-invite")} title="接受邀请">
                        <Mail size={12} />
                      </button>
                      {hasToken && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            const json = JSON.stringify({ refresh_token: account.antigravity_token!.refresh_token });
                            navigator.clipboard.writeText(json);
                            setSwitchResult(`✅ refresh_token 已复制 (${account.email})`);
                            setTimeout(() => setSwitchResult(null), 3000);
                          }}
                          title="导出 refresh_token (JSON)"
                        >
                          <Download size={12} />
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => deleteAccount(account.email)} title="删除">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* 额度区域：直接展示 */}
                  {hasToken && (
                    <div style={{ padding: "10px 16px", background: "var(--color-bg-elevated)" }}>
                      {!quota ? (
                        <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>额度加载中...</div>
                      ) : quota.error ? (
                        <div style={{ fontSize: 12, color: "var(--color-danger)" }}>❌ {quota.error}</div>
                      ) : quota.models.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          订阅: {quota.subscription_tier || "—"} · 无模型额度数据
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                            <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                              订阅: <strong style={{ color: "var(--color-text)" }}>{quota.subscription_tier || "—"}</strong>
                            </span>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleRefreshQuota(account.email)}
                              disabled={refreshingQuota !== null}
                              title="刷新额度"
                              style={{ padding: 2, marginLeft: "auto" }}
                            >
                              <RefreshCw size={11} className={refreshingQuota === account.email ? "spinning" : ""} />
                            </button>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6 }}>
                            {quota.models
                              .filter((m) => {
                                const label = (m.display_name || m.name).toLowerCase();
                                return label.includes("claude") && label.includes("opus")
                                  || label.includes("gemini") && label.includes("pro") && label.includes("high");
                              })
                              .map((m) => (
                              <QuotaBar key={m.name} name={m.display_name || m.name} percentage={m.percentage} resetTime={m.reset_time} />
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 日志面板 */}
        <div className="card" style={{ marginTop: 16 }}>
          <div
            className="card-header"
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() => setShowLogs(!showLogs)}
          >
            <div className="flex items-center gap-2">
              <Terminal size={14} />
              <span>运行日志</span>
              {logs.length > 0 && (
                <span className="badge" style={{ fontSize: 10, background: "var(--color-bg-elevated)", color: "var(--color-text-muted)" }}>
                  {logs.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {logs.length > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); clearLogs(); }}
                  style={{ fontSize: 11 }}
                >
                  清除
                </button>
              )}
              {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </div>
          {showLogs && (
            <div className="log-stream" style={{ maxHeight: 300, overflowY: "auto" }}>
              {logs.length === 0 ? (
                <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>
                  暂无日志，执行授权或测试登录后显示
                </div>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="log-line">
                    <span className={`log-icon ${log.status || ""}`}>
                      {log.status === "running" ? <Loader size={13} /> :
                       log.status === "done" ? <CheckCircle size={13} /> :
                       log.status === "failed" ? <XCircle size={13} /> :
                       "•"}
                    </span>
                    <span className={`log-text ${log.level === "ERROR" ? "error" : ""}`}>
                      {log.message || `${log.step}: ${log.detail || log.status}`}
                    </span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function QuotaBar({ name, percentage }: { name: string; percentage: number; resetTime: string }) {
  const barColor = percentage > 50 ? "#4ade80" : percentage > 20 ? "#fbbf24" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: "var(--color-text-muted)", minWidth: 60, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={name}>
        {name.replace(/^models\//, "").split("/").pop()}
      </span>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--color-border)", overflow: "hidden", minWidth: 40 }}>
        <div style={{ height: "100%", borderRadius: 3, width: `${percentage}%`, background: barColor, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 600, minWidth: 28, textAlign: "right", color: barColor }}>
        {percentage}%
      </span>
    </div>
  );
}

function TokenBadge({ token }: { token: { access_token: string; expires_at: number } | null }) {
  if (!token) return <span className="badge" style={{ background: "var(--color-bg-elevated)", color: "var(--color-text-muted)", fontSize: 10 }}>无Token</span>;
  const now = Math.floor(Date.now() / 1000);
  if (token.expires_at < now) return <span className="badge badge-warning" style={{ fontSize: 10 }} title="切号时自动刷新">⚠️ Token过期</span>;
  return <span className="badge badge-success" style={{ fontSize: 10 }} title={`有效至 ${new Date(token.expires_at * 1000).toLocaleString()}`}>✅ Token</span>;
}

function TierBadge({ quota }: { quota: QuotaInfo }) {
  if (quota.is_forbidden) return <span className="badge badge-danger" style={{ fontSize: 10 }}>禁止</span>;
  if (quota.error) return null;
  const tier = quota.subscription_tier || "";
  if (!tier) return null;
  const color = tier.toLowerCase().includes("pro") ? "badge-success" : tier.includes("ULTRA") ? "badge-info" : "badge-warning";
  return <span className={`badge ${color}`} style={{ fontSize: 10 }}>{tier}</span>;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active": return <span className="badge badge-success" style={{ fontSize: 10 }}>活跃</span>;
    case "login_failed": return <span className="badge badge-danger" style={{ fontSize: 10 }}>失败</span>;
    case "locked": return <span className="badge badge-danger" style={{ fontSize: 10 }}>锁定</span>;
    case "disabled": return <span className="badge badge-warning" style={{ fontSize: 10 }}>停用</span>;
    default: return <span className="badge badge-info" style={{ fontSize: 10 }}>新</span>;
  }
}
