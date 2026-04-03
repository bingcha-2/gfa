import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { invoke } from "@tauri-apps/api/core";
import {
  Play, ArrowLeftRight, Repeat2, KeyRound,
  Loader, CheckCircle, Terminal, ChevronDown, ChevronUp, AlertCircle,
} from "lucide-react";

type SwapPhase = "config" | "running" | "done" | "error";

interface SwapResult {
  orderNo?: string;
  taskId?: string;
  status?: string;
  message?: string;
}

export function Swap() {
  const { } = useAppStore();

  const [swapCode, setSwapCode] = useState("");
  const [sourceEmail, setSourceEmail] = useState("");
  const [targetEmail, setTargetEmail] = useState("");
  const [phase, setPhase] = useState<SwapPhase>("config");
  const [result, setResult] = useState<SwapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapLogs, setSwapLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [showLogs, setShowLogs] = useState(true);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [swapLogs, showLogs]);

  const addLog = (msg: string) => setSwapLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const currentPhaseIndex = phase === "config" ? 0 : phase === "running" ? 1 : 2;
  const phases = [
    { label: "配置", desc: "填写置换码和账号" },
    { label: "执行中", desc: "正在置换成员" },
    { label: "完成", desc: "查看结果" },
  ];

  const canSubmit = swapCode.trim() && sourceEmail.trim() && targetEmail.trim()
    && sourceEmail !== targetEmail && phase !== "running";

  const handleSwap = async () => {
    setError(null);
    setResult(null);
    setSwapLogs([]);
    setPhase("running");

    const code = swapCode.trim().toUpperCase();
    const origEmail = sourceEmail.trim().toLowerCase();
    const newEmail = targetEmail.trim().toLowerCase();

    addLog(`开始置换: ${origEmail} → ${newEmail}`);
    addLog(`置换码: ${code}`);

    try {
      // Step 1: Call swap_account
      addLog("正在提交置换请求...");
      const rawResponse: string = await invoke("swap_account", {
        code, originalEmail: origEmail, newEmail: newEmail,
      });

      let parsed: SwapResult;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        parsed = { message: rawResponse };
      }

      setResult(parsed);
      addLog(`✅ 置换任务已创建: ${parsed.orderNo || "—"}`);
      if (parsed.message) addLog(`消息: ${parsed.message}`);

      // Step 2: Poll status if we have orderNo
      if (parsed.orderNo) {
        addLog("正在查询执行状态...");
        let attempts = 0;
        const maxAttempts = 30;
        const pollInterval = 3000;

        while (attempts < maxAttempts) {
          attempts++;
          await new Promise((r) => setTimeout(r, pollInterval));

          try {
            const statusRaw: string = await invoke("poll_swap_status", { orderNo: parsed.orderNo });
            let statusParsed: { status?: string; message?: string };
            try { statusParsed = JSON.parse(statusRaw); } catch { statusParsed = { status: statusRaw }; }

            const st = statusParsed.status || "";
            addLog(`[${attempts}/${maxAttempts}] 状态: ${st}${statusParsed.message ? ` - ${statusParsed.message}` : ""}`);

            if (st === "completed" || st === "done" || st === "success") {
              addLog("🎉 置换完成！");
              setPhase("done");
              return;
            }
            if (st === "failed" || st === "error" || st === "cancelled") {
              addLog(`❌ 置换失败: ${statusParsed.message || st}`);
              setError(statusParsed.message || `置换失败 (${st})`);
              setPhase("error");
              return;
            }
          } catch (pollErr) {
            addLog(`轮询失败: ${pollErr}`);
          }
        }

        addLog("⏳ 轮询超时，请稍后手动查询订单状态");
        setPhase("done");
      } else {
        setPhase("done");
      }
    } catch (err) {
      const msg = String(err);
      addLog(`❌ 置换失败: ${msg}`);
      setError(msg);
      setPhase("error");
    }
  };

  const handleReset = () => {
    setPhase("config");
    setError(null);
    setResult(null);
  };

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
            <div key={i} className={`step-item ${i === currentPhaseIndex ? "active" : i < currentPhaseIndex ? "done" : ""}`}>
              <div className="step-number">{i < currentPhaseIndex ? <CheckCircle size={14} /> : i + 1}</div>
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

          {/* Swap Code */}
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="flex items-center gap-2"><KeyRound size={12} /> 置换码（换号卡密）</label>
            <input
              className="input font-mono"
              placeholder="例如 SWAP1234ABCD5678"
              value={swapCode}
              onChange={(e) => setSwapCode(e.target.value.toUpperCase())}
              disabled={phase === "running"}
              style={{ letterSpacing: "1px" }}
            />
            <span className="text-muted text-xs" style={{ marginTop: 4 }}>换号卡密是专属类型，普通邀请卡密无法使用此功能。</span>
          </div>

          {/* Emails */}
          <div className="bento-grid bento-grid-2" style={{ gap: 12, alignItems: "end" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>原账号邮箱</label>
              <input
                className="input"
                type="email"
                placeholder="your-original@gmail.com"
                value={sourceEmail}
                onChange={(e) => setSourceEmail(e.target.value.trimStart())}
                disabled={phase === "running"}
              />
              <span className="text-muted text-xs" style={{ marginTop: 4 }}>之前兑换进组时使用的 Google 账号邮箱</span>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>新 Google 邮箱</label>
              <input
                className="input"
                type="email"
                placeholder="new-address@gmail.com"
                value={targetEmail}
                onChange={(e) => setTargetEmail(e.target.value.trimStart())}
                disabled={phase === "running"}
              />
              <span className="text-muted text-xs" style={{ marginTop: 4 }}>邀请将发送到此邮箱，确认拼写正确</span>
            </div>
          </div>

          {/* Preview */}
          {sourceEmail && targetEmail && (
            <div className="flex items-center gap-2 mt-3" style={{ padding: "12px 16px", borderRadius: 12, background: "var(--primary-light)", border: "1px solid rgba(59,130,246,0.2)" }}>
              <span className="font-mono text-sm truncate" style={{ flex: 1 }}>{sourceEmail}</span>
              <Repeat2 size={14} style={{ color: "var(--primary)", flexShrink: 0 }} />
              <span className="font-mono text-sm truncate" style={{ flex: 1, textAlign: "right" }}>{targetEmail}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mt-3">
            {phase === "config" || phase === "error" ? (
              <button className="btn btn-primary btn-sm" disabled={!canSubmit} onClick={handleSwap}>
                <Play size={12} /> 开始置换
              </button>
            ) : phase === "running" ? (
              <button className="btn btn-secondary btn-sm" disabled>
                <Loader size={12} className="spinning" /> 执行中...
              </button>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={handleReset}>
                <ArrowLeftRight size={12} /> 新的置换
              </button>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="card" style={{ padding: "12px 16px", borderColor: "rgba(239,68,68,0.3)" }}>
            <span className="flex items-center gap-2" style={{ color: "var(--danger)", fontSize: 13 }}>
              <AlertCircle size={14} /> {error}
            </span>
          </div>
        )}

        {/* Result */}
        {result && !error && phase === "done" && (
          <div className="card" style={{ padding: "12px 16px", borderColor: "rgba(34,197,94,0.3)" }}>
            <div className="flex items-center gap-2" style={{ color: "var(--success)", fontSize: 13 }}>
              <CheckCircle size={14} />
              <span>置换任务已完成</span>
              {result.orderNo && <span className="badge badge-accent" style={{ marginLeft: 8 }}>#{result.orderNo}</span>}
            </div>
          </div>
        )}

        {/* Log Panel */}
        <div className="card">
          <div className="card-header collapsible-header" onClick={() => setShowLogs(!showLogs)}>
            <div className="flex items-center gap-2"><Terminal size={14} /> 执行日志 {swapLogs.length > 0 && <span className="badge badge-neutral" style={{ fontSize: 10 }}>{swapLogs.length}</span>}</div>
            <div className="flex items-center gap-2">
              {swapLogs.length > 0 && <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); setSwapLogs([]); }}>清除</button>}
              {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </div>
          {showLogs && (
            <div className="log-stream">
              <div className="log-stream-header"><div className="log-stream-dot red" /><div className="log-stream-dot yellow" /><div className="log-stream-dot green" /></div>
              {swapLogs.length === 0 ? <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>等待执行...</div> :
                swapLogs.map((log, i) => (
                  <div key={i} className="log-line">
                    <span className="log-icon">›</span>
                    <span className={`log-text ${log.includes("❌") ? "error" : ""}`}>{log}</span>
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
