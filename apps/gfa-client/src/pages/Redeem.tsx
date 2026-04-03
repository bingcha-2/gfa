import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  Gift, Users, Package,
  Loader, CheckCircle, XCircle, Terminal, ChevronDown, ChevronUp,
} from "lucide-react";

export function Redeem() {
  const { accounts, isRunning, logs, clearLogs } = useAppStore();

  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [redeemCode, setRedeemCode] = useState("");
  const [showLogs, setShowLogs] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLogs]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">兑换码</h1>
        <p className="page-subtitle">批量兑换 Google 礼品卡码</p>
      </div>
      <div className="page-body">
        <div className="bento-grid bento-grid-2">
          {/* Account Selection */}
          <div className="card">
            <div className="card-header">
              <div className="flex items-center gap-2"><Users size={14} className="card-header-icon" /> 选择账号</div>
              <span className="badge badge-accent">{selectedAccounts.length} 已选</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
              {accounts.map((a) => {
                const checked = selectedAccounts.includes(a.email);
                return (
                  <label key={a.id} className="flex items-center gap-2 cursor-pointer" style={{ padding: "8px 12px", borderRadius: 8, background: checked ? "var(--primary-light)" : "transparent", border: `1px solid ${checked ? "rgba(59,130,246,0.3)" : "var(--border-light)"}`, fontSize: 13, transition: "all 0.2s" }}>
                    <input type="checkbox" checked={checked} onChange={() => setSelectedAccounts((prev) => checked ? prev.filter((e) => e !== a.email) : [...prev, a.email])} style={{ accentColor: "var(--primary)" }} />
                    <span className="font-mono truncate">{a.email}</span>
                  </label>
                );
              })}
            </div>
            {accounts.length > 0 && (
              <div className="flex items-center gap-2 mt-2">
                <button className="btn btn-ghost btn-xs" onClick={() => setSelectedAccounts(accounts.map((a) => a.email))}>全选</button>
                <button className="btn btn-ghost btn-xs" onClick={() => setSelectedAccounts([])}>清除</button>
              </div>
            )}
          </div>

          {/* Redeem Config */}
          <div className="card">
            <div className="card-header">
              <div className="flex items-center gap-2"><Package size={14} className="card-header-icon" /> 兑换设置</div>
            </div>
            <div className="form-group">
              <label>兑换码</label>
              <input className="input" placeholder="输入兑换码" value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} disabled={isRunning} />
            </div>
            <div className="flex items-center gap-2 mt-3">
              <button className="btn btn-primary btn-sm" disabled={isRunning || selectedAccounts.length === 0 || !redeemCode.trim()}>
                {isRunning ? <Loader size={12} className="spinning" /> : <Gift size={12} />}
                {isRunning ? "兑换中..." : "开始兑换"}
              </button>
            </div>
            <p className="text-muted text-xs mt-2">注: 兑换功能需要后端 API 支持，当前为界面预览。</p>
          </div>
        </div>

        {/* Log Panel */}
        <div className="card">
          <div className="card-header collapsible-header" onClick={() => setShowLogs(!showLogs)}>
            <div className="flex items-center gap-2"><Terminal size={14} /> 执行日志 {logs.length > 0 && <span className="badge badge-neutral" style={{ fontSize: 10 }}>{logs.length}</span>}</div>
            <div className="flex items-center gap-2">
              {logs.length > 0 && <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); clearLogs(); }}>清除</button>}
              {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </div>
          {showLogs && (
            <div className="log-stream">
              <div className="log-stream-header"><div className="log-stream-dot red" /><div className="log-stream-dot yellow" /><div className="log-stream-dot green" /></div>
              {logs.length === 0 ? <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>等待执行...</div> :
                logs.map((log) => (
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
