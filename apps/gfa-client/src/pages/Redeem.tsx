import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { invoke } from "@tauri-apps/api/core";
import {
  Gift, Users, Package,
  Loader, CheckCircle, Terminal, ChevronDown, ChevronUp, AlertCircle,
} from "lucide-react";

type RedeemPhase = "config" | "running" | "done";

interface RedeemResult {
  email: string;
  success: boolean;
  orderNo?: string;
  message?: string;
  error?: string;
}

export function Redeem() {
  const { accounts } = useAppStore();

  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [redeemCode, setRedeemCode] = useState("");
  const [phase, setPhase] = useState<RedeemPhase>("config");
  const [results, setResults] = useState<RedeemResult[]>([]);
  const [redeemLogs, setRedeemLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [redeemLogs, showLogs]);

  const addLog = (msg: string) =>
    setRedeemLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const isRunning = phase === "running";

  const handleRedeem = async () => {
    setPhase("running");
    setResults([]);
    setRedeemLogs([]);
    setCurrentIndex(0);

    const code = redeemCode.trim();
    addLog(`开始批量兑换，共 ${selectedAccounts.length} 个账号`);
    addLog(`兑换码: ${code}`);

    const allResults: RedeemResult[] = [];

    for (let i = 0; i < selectedAccounts.length; i++) {
      const email = selectedAccounts[i];
      setCurrentIndex(i + 1);
      addLog(`[${i + 1}/${selectedAccounts.length}] 正在为 ${email} 兑换...`);

      try {
        const response = await invoke<{ orderNo?: string; message?: string }>(
          "redeem_code",
          { code, email }
        );

        const result: RedeemResult = {
          email,
          success: true,
          orderNo: response.orderNo,
          message: response.message,
        };
        allResults.push(result);
        setResults([...allResults]);
        addLog(`✅ ${email} 兑换成功${response.orderNo ? ` (订单号: ${response.orderNo})` : ""}${response.message ? ` - ${response.message}` : ""}`);
      } catch (err) {
        const errMsg = String(err);
        const result: RedeemResult = {
          email,
          success: false,
          error: errMsg,
        };
        allResults.push(result);
        setResults([...allResults]);
        addLog(`❌ ${email} 兑换失败: ${errMsg}`);
      }
    }

    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    addLog(`🏁 兑换完成: ${successCount} 成功, ${failCount} 失败`);
    setPhase("done");
  };

  const handleReset = () => {
    setPhase("config");
    setResults([]);
    setCurrentIndex(0);
  };

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

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
                    <input type="checkbox" checked={checked} onChange={() => setSelectedAccounts((prev) => checked ? prev.filter((e) => e !== a.email) : [...prev, a.email])} disabled={isRunning} style={{ accentColor: "var(--primary)" }} />
                    <span className="font-mono truncate">{a.email}</span>
                  </label>
                );
              })}
            </div>
            {accounts.length > 0 && (
              <div className="flex items-center gap-2 mt-2">
                <button className="btn btn-ghost btn-xs" onClick={() => setSelectedAccounts(accounts.map((a) => a.email))} disabled={isRunning}>全选</button>
                <button className="btn btn-ghost btn-xs" onClick={() => setSelectedAccounts([])} disabled={isRunning}>清除</button>
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
              {phase === "config" ? (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={isRunning || selectedAccounts.length === 0 || !redeemCode.trim()}
                  onClick={handleRedeem}
                >
                  <Gift size={12} />
                  开始兑换
                </button>
              ) : phase === "running" ? (
                <button className="btn btn-secondary btn-sm" disabled>
                  <Loader size={12} className="spinning" />
                  兑换中 ({currentIndex}/{selectedAccounts.length})
                </button>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={handleReset}>
                  <Gift size={12} />
                  新的兑换
                </button>
              )}
            </div>

            {/* Progress */}
            {isRunning && selectedAccounts.length > 0 && (
              <div className="mt-2" style={{ background: "var(--bg-tertiary)", borderRadius: 6, height: 4, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${(currentIndex / selectedAccounts.length) * 100}%`,
                  background: "var(--primary)",
                  borderRadius: 6,
                  transition: "width 0.3s ease",
                }} />
              </div>
            )}
          </div>
        </div>

        {/* Results Summary */}
        {results.length > 0 && (
          <div className="card" style={{ padding: "12px 16px", borderColor: failCount > 0 ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)" }}>
            <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
              {failCount === 0 ? (
                <><CheckCircle size={14} style={{ color: "var(--success)" }} /> <span style={{ color: "var(--success)" }}>全部兑换成功</span></>
              ) : successCount === 0 ? (
                <><AlertCircle size={14} style={{ color: "var(--danger)" }} /> <span style={{ color: "var(--danger)" }}>全部兑换失败</span></>
              ) : (
                <><AlertCircle size={14} style={{ color: "var(--warning)" }} /> <span>部分成功</span></>
              )}
              <span className="badge badge-accent" style={{ marginLeft: 8 }}>{successCount} 成功</span>
              {failCount > 0 && <span className="badge" style={{ marginLeft: 4, background: "rgba(239,68,68,0.15)", color: "var(--danger)" }}>{failCount} 失败</span>}
            </div>
          </div>
        )}

        {/* Log Panel */}
        <div className="card">
          <div className="card-header collapsible-header" onClick={() => setShowLogs(!showLogs)}>
            <div className="flex items-center gap-2"><Terminal size={14} /> 执行日志 {redeemLogs.length > 0 && <span className="badge badge-neutral" style={{ fontSize: 10 }}>{redeemLogs.length}</span>}</div>
            <div className="flex items-center gap-2">
              {redeemLogs.length > 0 && <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); setRedeemLogs([]); }}>清除</button>}
              {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </div>
          {showLogs && (
            <div className="log-stream">
              <div className="log-stream-header"><div className="log-stream-dot red" /><div className="log-stream-dot yellow" /><div className="log-stream-dot green" /></div>
              {redeemLogs.length === 0 ? <div className="text-muted text-sm" style={{ padding: 16, textAlign: "center" }}>等待执行...</div> :
                redeemLogs.map((log, i) => (
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
