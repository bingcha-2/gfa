import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeftRight } from "lucide-react";
import { useAppStore } from "../stores/useAppStore";

type Phase = "idle" | "swapping" | "polling" | "accepting";

export function Swap() {
  const { accounts, runAcceptInvite, isRunning, logs, addToast } = useAppStore();
  const [swapCode, setSwapCode] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoAccept, setAutoAccept] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const phaseLabel: Record<Phase, string> = {
    idle: "提交置换",
    swapping: "提交中...",
    polling: "等待换号完成...",
    accepting: "接受邀请中...",
  };

  const handleSwap = async () => {
    if (!swapCode.trim() || !originalEmail || !newEmail) return;
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      // Phase 1: Submit swap request
      setPhase("swapping");
      const respJson = await invoke<string>("swap_account", {
        code: swapCode,
        originalEmail: originalEmail,
        newEmail: newEmail,
      });

      let orderNo: string | null = null;
      try {
        const resp = JSON.parse(respJson);
        orderNo = resp.orderNo;
        setResult(`换号已入队 (${orderNo}) — 等待 Worker 处理...`);
        addToast({ type: "info", message: `换号已提交，订单号: ${orderNo}` });
      } catch {
        setResult("换号已提交");
        addToast({ type: "info", message: "换号已提交" });
      }

      // Phase 2: Poll for completion
      if (orderNo) {
        setPhase("polling");
        const completed = await pollUntilDone(orderNo, (msg) => setResult(msg));

        if (!completed) {
          setResult(`换号超时 — 请到管理后台检查订单 ${orderNo}`);
          addToast({ type: "error", message: `换号超时，请检查订单 ${orderNo}` });
          return;
        }
        setResult(`换号完成 ✅ 邀请已发送到 ${newEmail}`);
        addToast({ type: "success", message: `✅ 换号完成！邀请已发送到 ${newEmail}` });
      }

      // Phase 3: Auto accept invite
      if (autoAccept) {
        const account = accounts.find(
          (a) => a.email.toLowerCase() === newEmail.toLowerCase()
        );
        if (account) {
          setPhase("accepting");
          setResult((prev) => prev + " → 正在自动接受邀请...");
          await runAcceptInvite(account.email);
          setResult(`全部完成 ✅ ${newEmail} 已加入家庭组`);
          addToast({ type: "success", message: `✅ ${newEmail} 已成功加入家庭组` });
        } else {
          setResult(
            (prev) => prev + " ⚠️ 新邮箱未导入账号，请手动接受邀请"
          );
          addToast({ type: "info", message: "新邮箱未导入账号，请手动接受邀请" });
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setPhase("idle");
    }
  };

  // Filter out the selected email from the other dropdown
  const originalOptions = accounts.filter(
    (a) => a.email.toLowerCase() !== newEmail.toLowerCase()
  );
  const newOptions = accounts.filter(
    (a) => a.email.toLowerCase() !== originalEmail.toLowerCase()
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">账号置换</h1>
        <p className="page-subtitle">
          通过置换码将家庭组中的旧邮箱替换为新邮箱
        </p>
      </div>
      <div className="page-body animate-in">
        <div className="card">
          <div className="card-header">
            <span>置换操作</span>
            <ArrowLeftRight
              size={16}
              style={{ color: "var(--color-accent)" }}
            />
          </div>
          <div className="flex gap-3" style={{ flexDirection: "column" }}>
            <div>
              <label
                className="text-sm text-muted"
                style={{ display: "block", marginBottom: 4 }}
              >
                置换码
              </label>
              <input
                className="input"
                placeholder="输入置换码（ACCOUNT_SWAP 或 SUBSCRIPTION 类型）"
                value={swapCode}
                onChange={(e) => setSwapCode(e.target.value)}
              />
            </div>
            <div>
              <label
                className="text-sm text-muted"
                style={{ display: "block", marginBottom: 4 }}
              >
                当前邮箱（被替换的）
              </label>
              <select
                className="input"
                value={originalEmail}
                onChange={(e) => setOriginalEmail(e.target.value)}
              >
                <option value="">— 选择当前在组里的邮箱 —</option>
                {originalOptions.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.email}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="text-sm text-muted"
                style={{ display: "block", marginBottom: 4 }}
              >
                新邮箱（替换成）
              </label>
              <select
                className="input"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              >
                <option value="">— 选择新邮箱 —</option>
                {newOptions.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.email}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="auto-accept"
                checked={autoAccept}
                onChange={(e) => setAutoAccept(e.target.checked)}
                style={{ accentColor: "var(--color-accent)" }}
              />
              <label htmlFor="auto-accept" className="text-sm">
                置换后自动接受邀请（需要新邮箱已导入账号）
              </label>
            </div>
            <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                onClick={handleSwap}
                disabled={
                  loading ||
                  !swapCode ||
                  !originalEmail ||
                  !newEmail ||
                  isRunning
                }
              >
                <ArrowLeftRight size={14} />
                {phaseLabel[phase]}
              </button>
              {result && (
                <span
                  style={{ color: "var(--color-success)", fontSize: 13 }}
                >
                  {result}
                </span>
              )}
              {error && (
                <span
                  style={{ color: "var(--color-danger)", fontSize: 13 }}
                >
                  {error}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 实时日志（轮询阶段 + 接受邀请阶段） */}
        {loading && (phase === "polling" || phase === "accepting" || logs.length > 0) && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header">
              <span>
                {phase === "polling" ? "等待换号完成" : "自动接受邀请"} — 实时日志
              </span>
            </div>
            <div
              style={{
                maxHeight: 240,
                overflowY: "auto",
                fontSize: 12,
                fontFamily: "monospace",
                padding: "8px 12px",
                background: "var(--color-bg-secondary, rgba(0,0,0,0.2))",
                borderRadius: 6,
              }}
            >
              {logs.map((log) => (
                <div
                  key={log.id}
                  style={{
                    padding: "2px 0",
                    color:
                      log.level === "ERROR" || log.status === "failed"
                        ? "var(--color-danger)"
                        : log.status === "done"
                        ? "var(--color-success)"
                        : "var(--color-text-secondary, #aaa)",
                  }}
                >
                  {log.message}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Poll swap status every 3s, up to 2 minutes.
 * Returns true if task completed, false if timed out.
 */
async function pollUntilDone(
  orderNo: string,
  onStatus: (msg: string) => void
): Promise<boolean> {
  const MAX_POLLS = 40; // 40 × 3s = 120s
  const POLL_INTERVAL = 3000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    try {
      const respJson = await invoke<string>("poll_swap_status", { orderNo });
      const resp = JSON.parse(respJson);
      const status = resp.status;
      const taskStatus = resp.task?.status;

      onStatus(
        `[${i + 1}/${MAX_POLLS}] 订单 ${orderNo}: ${status}` +
        (taskStatus ? ` (task: ${taskStatus})` : "")
      );

      // Terminal states — swap worker finished
      if (
        status === "COMPLETED" ||
        status === "INVITE_SENT" ||
        status === "WAIT_USER_ACCEPT"
      ) {
        return true;
      }

      // Failed — stop polling
      if (status === "FAILED" || status === "MANUAL_REVIEW") {
        onStatus(`换号失败: ${status} — ${resp.resultMessage || "请检查管理后台"}`);
        return false;
      }

      // Task finished successfully
      if (taskStatus === "COMPLETED" || taskStatus === "SUCCESS") {
        return true;
      }
    } catch (e) {
      onStatus(`轮询出错: ${e}`);
      // Don't stop — might be transient
    }
  }

  return false; // timeout
}
