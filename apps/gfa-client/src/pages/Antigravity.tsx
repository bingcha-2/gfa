import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { Zap, CheckCircle, XCircle, Loader } from "lucide-react";

export function Antigravity() {
  const { accounts, startAntigravityOAuth, isRunning, runningEmail, logs, clearLogs } = useAppStore();
  const [selectedEmail, setSelectedEmail] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (accounts.length > 0 && !selectedEmail) {
      setSelectedEmail(accounts[0].email);
    }
  }, [accounts]);

  const handleOAuth = () => {
    if (!selectedEmail || isRunning) return;
    clearLogs();
    startAntigravityOAuth(selectedEmail);
  };

  const handleOAuthAll = async () => {
    if (isRunning) return;
    for (const account of accounts) {
      if (!account.antigravity_token) {
        clearLogs();
        await startAntigravityOAuth(account.email);
      }
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Antigravity 授权</h1>
        <p className="page-subtitle">利用已登录的 Google 会话自动完成 Antigravity OAuth 授权</p>
      </div>
      <div className="page-body animate-in">
        <div className="card mb-4">
          <div className="card-header">OAuth 授权</div>
          <div className="flex items-center gap-3">
            <select
              className="input"
              style={{ maxWidth: 400 }}
              value={selectedEmail}
              onChange={(e) => setSelectedEmail(e.target.value)}
              disabled={isRunning}
            >
              <option value="">选择账号...</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.email}>
                  {a.email} {a.antigravity_token ? "✅" : ""}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={handleOAuth} disabled={isRunning || !selectedEmail}>
              <Zap size={14} />
              {isRunning && runningEmail === selectedEmail ? "授权中..." : "开始授权"}
            </button>
            <button className="btn btn-success" onClick={handleOAuthAll} disabled={isRunning || accounts.length === 0}>
              <Zap size={14} />
              全部授权
            </button>
          </div>
        </div>

        {/* Flow explanation */}
        <div className="card mb-4">
          <div className="card-header">自动化流程</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            {[
              { num: 1, label: "Google 登录", desc: "复用已有 Cookie" },
              { num: 2, label: "打开 OAuth", desc: "Antigravity 授权页" },
              { num: 3, label: "自动同意", desc: "点击 Allow" },
              { num: 4, label: "获取 Token", desc: "回调捕获 + 换取" },
            ].map((s) => (
              <div key={s.num} style={{
                padding: "14px 12px",
                background: "var(--color-bg-elevated)",
                borderRadius: 8,
                textAlign: "center",
                border: "1px solid var(--color-border)",
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: "linear-gradient(135deg, #6c5ce7, #a29bfe)", color: "white",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  margin: "0 auto 8px", fontSize: 13, fontWeight: 700,
                }}>{s.num}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Token status */}
        <div className="card mb-4">
          <div className="card-header">Token 状态</div>
          {accounts.filter(a => a.antigravity_token).length === 0 ? (
            <div className="empty-state">
              <Zap />
              <p>尚未完成任何 Antigravity 授权</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>Token 状态</th>
                    <th>过期时间</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.filter(a => a.antigravity_token).map((a) => (
                    <tr key={a.id}>
                      <td>{a.email}</td>
                      <td><span className="badge badge-success">已授权</span></td>
                      <td className="text-muted text-sm">
                        {a.antigravity_token
                          ? new Date(a.antigravity_token.expires_at * 1000).toLocaleString("zh-CN")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Logs */}
        <div className="card">
          <div className="card-header">
            <span>实时日志</span>
            <button className="btn btn-ghost btn-sm" onClick={clearLogs}>清除</button>
          </div>
          <div className="log-stream">
            {logs.length === 0 ? (
              <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>
                选择账号后点击「开始授权」查看实时日志
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="log-line">
                  <span className={`log-icon ${log.status || ""}`}>
                    {log.status === "running" ? <Loader size={14} /> :
                     log.status === "done" ? <CheckCircle size={14} /> :
                     log.status === "failed" ? <XCircle size={14} /> :
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
        </div>
      </div>
    </>
  );
}
