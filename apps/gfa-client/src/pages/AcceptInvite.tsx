import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { Play, CheckCircle, XCircle, Loader } from "lucide-react";

export function AcceptInvite() {
  const { accounts, runAcceptInvite, isRunning, runningEmail, logs, clearLogs, addToast } = useAppStore();
  const [selectedEmail, setSelectedEmail] = useState<string>("");
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (accounts.length > 0 && !selectedEmail) {
      setSelectedEmail(accounts[0].email);
    }
  }, [accounts]);

  const handleRun = async () => {
    if (!selectedEmail || isRunning) return;
    clearLogs();
    await runAcceptInvite(selectedEmail);
    // Check final log for success/failure
    const finalLogs = useAppStore.getState().logs;
    const hasError = finalLogs.some((l) => l.level === "ERROR" || l.status === "failed");
    if (hasError) {
      addToast({ type: "error", message: `接受邀请失败: ${selectedEmail}` });
    } else {
      addToast({ type: "success", message: `✅ 邀请已成功接受: ${selectedEmail}` });
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">接受家庭邀请</h1>
        <p className="page-subtitle">全自动完成 Google 登录并接受家庭组邀请</p>
      </div>
      <div className="page-body animate-in">
        {/* Controls */}
        <div className="card mb-4">
          <div className="card-header">选择账号</div>
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
                <option key={a.id} value={a.email}>{a.email}</option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={handleRun}
              disabled={isRunning || !selectedEmail}
            >
              <Play size={14} />
              {isRunning && runningEmail === selectedEmail ? "执行中..." : "开始接受邀请"}
            </button>
          </div>
        </div>

        {/* Process description */}
        <div className="card mb-4">
          <div className="card-header">自动化流程</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            {[
              { num: 1, label: "启动 Chrome", desc: "独立 Profile" },
              { num: 2, label: "Google 登录", desc: "邮箱 + 密码 + TOTP" },
              { num: 3, label: "导航到 Family", desc: "families.google.com" },
              { num: 4, label: "查找邀请", desc: "Family/Gmail" },
              { num: 5, label: "确认加入", desc: "点击接受" },
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
                  background: "var(--color-accent)", color: "white",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  margin: "0 auto 8px", fontSize: 13, fontWeight: 700,
                }}>{s.num}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Log stream */}
        <div className="card">
          <div className="card-header">
            <span>实时日志</span>
            <button className="btn btn-ghost btn-sm" onClick={clearLogs}>清除</button>
          </div>
          <div className="log-stream">
            {logs.length === 0 ? (
              <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>
                选择账号后点击「开始接受邀请」查看实时日志
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
