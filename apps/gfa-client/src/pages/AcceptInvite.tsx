import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  Users, Send,
  Loader, CheckCircle, XCircle, Terminal, ChevronDown, ChevronUp,
} from "lucide-react";

export function AcceptInvite() {
  const {
    accounts, isRunning,
    runAcceptInvite, logs, clearLogs,
  } = useAppStore();

  const [selectedEmail, setSelectedEmail] = useState<string>("");
  const [showLogs, setShowLogs] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLogs]);

  const handleStart = async () => {
    if (!selectedEmail) return;
    await runAcceptInvite(selectedEmail);
  };

  const currentStep = isRunning ? 1 : logs.some((l) => l.status === "done") ? 2 : 0;

  const steps = [
    { label: "选择账号", desc: "选择要操作的账号" },
    { label: "执行中", desc: "自动接受邀请" },
    { label: "完成", desc: "查看结果" },
  ];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">接受邀请</h1>
        <p className="page-subtitle">选择账号接受 Google Family 邀请</p>
      </div>
      <div className="page-body">
        {/* Steps */}
        <div className="step-timeline">
          {steps.map((s, i) => (
            <div key={i} className={`step-item ${i === currentStep ? "active" : i < currentStep ? "done" : ""}`}>
              <div className="step-number">{i < currentStep ? <CheckCircle size={14} /> : i + 1}</div>
              <span className="step-label">{s.label}</span>
              <span className="step-desc">{s.desc}</span>
            </div>
          ))}
        </div>

        {/* Account Selection - Single Select */}
        <div className="card">
          <div className="card-header">
            <div className="flex items-center gap-2"><Users size={14} className="card-header-icon" /> 选择账号</div>
            {selectedEmail && <span className="badge badge-accent">已选 1</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {accounts.map((a) => {
              const isSelected = selectedEmail === a.email;
              return (
                <label key={a.id} className="flex items-center gap-2 cursor-pointer" style={{ padding: "8px 12px", borderRadius: 8, background: isSelected ? "var(--primary-light)" : "transparent", border: `1px solid ${isSelected ? "rgba(59,130,246,0.3)" : "var(--border-light)"}`, fontSize: 13, transition: "all 0.2s" }}>
                  <input type="radio" name="accept-invite-account" checked={isSelected} onChange={() => setSelectedEmail(a.email)} style={{ accentColor: "var(--primary)" }} />
                  <span className="font-mono truncate">{a.email}</span>
                </label>
              );
            })}
            {accounts.length === 0 && <div className="text-muted text-sm" style={{ textAlign: "center", padding: 24 }}>暂无账号</div>}
          </div>
          {accounts.length > 0 && (
            <div className="flex items-center gap-2 mt-3">
              <button className="btn btn-ghost btn-xs" onClick={() => setSelectedEmail("")}>清除</button>
              <button className="btn btn-primary btn-sm ml-auto" onClick={handleStart} disabled={isRunning || !selectedEmail}>
                {isRunning ? <Loader size={12} className="spinning" /> : <Send size={12} />}
                {isRunning ? "执行中..." : "开始执行"}
              </button>
            </div>
          )}
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
