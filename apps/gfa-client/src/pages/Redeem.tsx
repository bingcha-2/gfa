import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { invoke } from "@tauri-apps/api/core";
import {
  Gift, Users, Package,
  Loader, CheckCircle, Terminal, ChevronDown, ChevronUp, AlertCircle,
  UserCheck,
} from "lucide-react";

type RedeemPhase = "config" | "running" | "done";

interface RedeemResult {
  email: string;
  success: boolean;
  orderNo?: string;
  message?: string;
  error?: string;
  acceptInviteStatus?: "pending" | "polling" | "accepting" | "done" | "failed";
}

// Statuses that mean the invite is ready for the user to accept
const INVITE_READY_STATUSES = ["INVITE_SENT", "WAIT_USER_ACCEPT", "COMPLETED"];
// Terminal failure statuses
const FAILED_STATUSES = ["FAILED", "MANUAL_REVIEW", "EXPIRED"];

export function Redeem() {
  const { accounts } = useAppStore();

  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [redeemCode, setRedeemCode] = useState("");
  const [phase, setPhase] = useState<RedeemPhase>("config");
  const [results, setResults] = useState<RedeemResult[]>([]);
  const [redeemLogs, setRedeemLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [autoAccept, setAutoAccept] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [redeemLogs, showLogs]);

  const addLog = (msg: string) =>
    setRedeemLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const isRunning = phase === "running";

  /**
   * Poll order status until invite is sent, then auto-accept.
   * Returns only after the entire flow (redeem + optional accept) completes.
   */
  const pollAndAccept = async (
    email: string,
    _orderNo: string,
    code: string,
    resultIdx: number,
    allResults: RedeemResult[]
  ) => {
    // Update result to show polling state
    const updateResult = (patch: Partial<RedeemResult>) => {
      allResults[resultIdx] = { ...allResults[resultIdx], ...patch };
      setResults([...allResults]);
    };

    updateResult({ acceptInviteStatus: "polling" });
    addLog(`⏳ [${email}] 等待后端发送邀请...`);

    const maxAttempts = 60; // 3 minutes max
    const pollInterval = 3000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, pollInterval));

      try {
        const statusRaw = await invoke<{ status?: string; userEmail?: string; resultMessage?: string }>(
          "get_order_status",
          { code }
        );

        const st = statusRaw.status || "";

        if (INVITE_READY_STATUSES.includes(st)) {
          addLog(`✅ [${email}] 邀请已发送 (${st})，开始自动接受...`);
          updateResult({ acceptInviteStatus: "accepting" });

          try {
            // Trigger accept-invite automation via API
            const { taskId } = await invoke<{ taskId: string }>(
              "run_accept_invite",
              { email }
            );

            // Poll automation status
            addLog(`🤖 [${email}] 接受邀请任务已创建 (${taskId})，等待完成...`);
            const automationMaxAttempts = 140; // ~7 minutes
            const automationPollInterval = 3000;

            for (let j = 1; j <= automationMaxAttempts; j++) {
              await new Promise((r) => setTimeout(r, automationPollInterval));

              try {
                const automationStatus = await invoke<{
                  taskId: string;
                  status: string;
                  lastErrorMessage?: string;
                  logs?: Array<{ level: string; message: string }>;
                }>("poll_automation_status", { taskId });

                const aStatus = automationStatus.status;

                if (aStatus === "SUCCESS") {
                  addLog(`🎉 [${email}] 邀请已自动接受！`);
                  updateResult({ acceptInviteStatus: "done" });
                  return;
                }

                if (["FAILED_FINAL", "FAILED_RETRYABLE", "CANCELLED", "MANUAL_REVIEW"].includes(aStatus)) {
                  addLog(`❌ [${email}] 自动接受失败: ${automationStatus.lastErrorMessage || aStatus}`);
                  updateResult({ acceptInviteStatus: "failed" });
                  return;
                }

                // Still running, log progress occasionally
                if (j % 5 === 0) {
                  addLog(`⏳ [${email}] 接受邀请中... (${j}/${automationMaxAttempts})`);
                }
              } catch (pollErr) {
                addLog(`⚠️ [${email}] 轮询接受状态失败: ${pollErr}`);
              }
            }

            addLog(`⏳ [${email}] 接受邀请超时，请手动检查`);
            updateResult({ acceptInviteStatus: "failed" });
            return;
          } catch (acceptErr) {
            addLog(`❌ [${email}] 触发自动接受失败: ${acceptErr}`);
            updateResult({ acceptInviteStatus: "failed" });
            return;
          }
        }

        if (FAILED_STATUSES.includes(st)) {
          addLog(`❌ [${email}] 订单失败 (${st})，无法自动接受`);
          updateResult({ acceptInviteStatus: "failed" });
          return;
        }

        // Still processing, show progress
        if (attempt % 5 === 0) {
          addLog(`⏳ [${email}] 等待邀请发送中... 状态: ${st} (${attempt}/${maxAttempts})`);
        }
      } catch (pollErr) {
        addLog(`⚠️ [${email}] 查询订单状态失败: ${pollErr}`);
      }
    }

    addLog(`⏳ [${email}] 等待邀请超时，请手动接受`);
    updateResult({ acceptInviteStatus: "failed" });
  };

  const handleRedeem = async () => {
    setPhase("running");
    setResults([]);
    setRedeemLogs([]);
    setCurrentIndex(0);

    const code = redeemCode.trim();
    addLog(`开始批量兑换，共 ${selectedAccounts.length} 个账号`);
    addLog(`兑换码: ${code}`);
    if (autoAccept) addLog(`✅ 自动接受邀请已开启`);

    const allResults: RedeemResult[] = [];

    for (let i = 0; i < selectedAccounts.length; i++) {
      const email = selectedAccounts[i];
      setCurrentIndex(i + 1);
      addLog(`[${i + 1}/${selectedAccounts.length}] 正在为 ${email} 兑换...`);

      try {
        const response = await invoke<{ orderNo?: string; message?: string; status?: string }>(
          "redeem_code",
          { code, email }
        );

        const result: RedeemResult = {
          email,
          success: true,
          orderNo: response.orderNo,
          message: response.message,
          acceptInviteStatus: autoAccept ? "pending" : undefined,
        };
        allResults.push(result);
        setResults([...allResults]);
        addLog(`✅ ${email} 兑换提交成功${response.orderNo ? ` (订单: ${response.orderNo})` : ""}${response.message ? ` - ${response.message}` : ""}`);

        // Auto-accept: poll order status and accept invite after each successful redeem
        if (autoAccept && accounts.find((a) => a.email === email)) {
          await pollAndAccept(email, response.orderNo || "", code, allResults.length - 1, allResults);
        } else if (autoAccept && !accounts.find((a) => a.email === email)) {
          addLog(`⚠️ [${email}] 该邮箱不在本地账号列表中，跳过自动接受`);
        }
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
    const acceptedCount = allResults.filter((r) => r.acceptInviteStatus === "done").length;
    addLog(`🏁 兑换完成: ${successCount} 成功, ${failCount} 失败${autoAccept ? `, ${acceptedCount} 已自动接受` : ""}`);
    setPhase("done");
  };

  const handleReset = () => {
    setPhase("config");
    setResults([]);
    setCurrentIndex(0);
  };

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  const acceptedCount = results.filter((r) => r.acceptInviteStatus === "done").length;

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

            {/* Auto-accept toggle */}
            <label className="flex items-center gap-2 cursor-pointer mt-2" style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={autoAccept}
                onChange={() => setAutoAccept(!autoAccept)}
                disabled={isRunning}
                style={{ accentColor: "var(--primary)" }}
              />
              <UserCheck size={13} style={{ color: autoAccept ? "var(--primary)" : "var(--text-muted)" }} />
              <span>兑换后自动接受邀请</span>
            </label>
            {autoAccept && (
              <p className="text-muted text-xs mt-1" style={{ paddingLeft: 4 }}>
                将在后端发送邀请后自动登录账号接受 Family 邀请
              </p>
            )}

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
            <div className="flex items-center gap-2" style={{ fontSize: 13, flexWrap: "wrap" }}>
              {failCount === 0 ? (
                <><CheckCircle size={14} style={{ color: "var(--success)" }} /> <span style={{ color: "var(--success)" }}>全部兑换成功</span></>
              ) : successCount === 0 ? (
                <><AlertCircle size={14} style={{ color: "var(--danger)" }} /> <span style={{ color: "var(--danger)" }}>全部兑换失败</span></>
              ) : (
                <><AlertCircle size={14} style={{ color: "var(--warning)" }} /> <span>部分成功</span></>
              )}
              <span className="badge badge-accent" style={{ marginLeft: 8 }}>{successCount} 成功</span>
              {failCount > 0 && <span className="badge" style={{ marginLeft: 4, background: "rgba(239,68,68,0.15)", color: "var(--danger)" }}>{failCount} 失败</span>}
              {autoAccept && acceptedCount > 0 && <span className="badge" style={{ marginLeft: 4, background: "rgba(34,197,94,0.15)", color: "var(--success)" }}>{acceptedCount} 已接受</span>}
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
