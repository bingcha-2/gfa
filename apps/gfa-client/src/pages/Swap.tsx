import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  Play, ArrowLeftRight, Repeat2,
  Loader, CheckCircle, XCircle, Terminal, ChevronDown, ChevronUp,
} from "lucide-react";

export function Swap() {
  const { accounts, isRunning, logs, clearLogs } = useAppStore();

  const [sourceEmail, setSourceEmail] = useState("");
  const [targetEmail, setTargetEmail] = useState("");
  const [showLogs, setShowLogs] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLogs]);

  const currentPhase = isRunning ? 1 : logs.some((l) => l.status === "done") ? 2 : 0;
  const phases = [
    { label: "配置", desc: "选择源账号和目标账号" },
    { label: "执行中", desc: "正在置换成员" },
    { label: "完成", desc: "查看结果" },
  ];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">账号置换</h1>
        <p className="page-subtitle">在 Family Group 之间置换成员账号</p>
      </div>
      <div className="page-body">
        {/* Phase Indicator */}
        <div className="step-timeline">
          {phases.map((p, i) => (
            <div key={i} className={`step-item ${i === currentPhase ? "active" : i < currentPhase ? "done" : ""}`}>
              <div className="step-number">{i < currentPhase ? <CheckCircle size={14} /> : i + 1}</div>
              <span className="step-label">{p.label}</span>
              <span className="step-desc">{p.desc}</span>
            </div>
          ))}
        </div>

        {/* Configuration */}
        <div className="card">
          <div className="card-header">
            <div className="flex items-center gap-2"><ArrowLeftRight size={14} className="card-header-icon" /> 置换设置</div>
          </div>
          <div className="bento-grid bento-grid-2" style={{ gap: 12, alignItems: "end" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>源账号</label>
              <select className="input" value={sourceEmail} onChange={(e) => setSourceEmail(e.target.value)} disabled={isRunning}>
                <option value="">选择源账号...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.email} disabled={a.email === targetEmail}>{a.email}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>目标账号</label>
              <select className="input" value={targetEmail} onChange={(e) => setTargetEmail(e.target.value)} disabled={isRunning}>
                <option value="">选择目标账号...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.email} disabled={a.email === sourceEmail}>{a.email}</option>
                ))}
              </select>
            </div>
          </div>
          {sourceEmail && targetEmail && (
            <div className="flex items-center gap-2 mt-3" style={{ padding: "12px 16px", borderRadius: 12, background: "var(--primary-light)", border: "1px solid rgba(59,130,246,0.2)" }}>
              <span className="font-mono text-sm truncate" style={{ flex: 1 }}>{sourceEmail}</span>
              <Repeat2 size={14} style={{ color: "var(--primary)", flexShrink: 0 }} />
              <span className="font-mono text-sm truncate" style={{ flex: 1, textAlign: "right" }}>{targetEmail}</span>
            </div>
          )}
          <div className="flex items-center gap-2 mt-3">
            <button className="btn btn-primary btn-sm" disabled={isRunning || !sourceEmail || !targetEmail || sourceEmail === targetEmail}>
              {isRunning ? <Loader size={12} className="spinning" /> : <Play size={12} />}
              {isRunning ? "执行中..." : "开始置换"}
            </button>
            <p className="text-muted text-xs">注: 置换功能需要后端 API 支持</p>
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
