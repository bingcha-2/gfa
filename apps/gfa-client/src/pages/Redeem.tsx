import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Gift, Search, CheckCircle } from "lucide-react";
import { useAppStore } from "../stores/useAppStore";

interface OrderStatus {
  orderNo: string;
  status: string;
  userEmail: string;
  resultMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function Redeem() {
  const { accounts } = useAppStore();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Order lookup
  const [lookupCode, setLookupCode] = useState("");
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const handleRedeem = async () => {
    if (!code.trim() || !email) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      console.log("[Redeem] Redeeming code:", code, "for email:", email);
      const res = await invoke<{ order_no: string; status: string; message?: string }>("redeem_code", { code, email });
      console.log("[Redeem] Response:", res);
      setResult(`✅ 兑换成功！订单号: ${res.order_no}，状态: ${res.status}${res.message ? ` — ${res.message}` : ""}`);
      // 保留兑换码用于查询
      setLookupCode(code);
      setCode("");
    } catch (e) {
      console.error("[Redeem] Error:", e);
      const errStr = String(e);
      const msgMatch = errStr.match(/"message"\s*:\s*"([^"]+)"/);
      setError(msgMatch ? msgMatch[1] : errStr);
    } finally {
      setLoading(false);
    }
  };

  const handleLookup = async () => {
    if (!lookupCode.trim()) return;
    setOrder(null);
    setLookupError(null);
    try {
      const res = await invoke<OrderStatus>("get_order_status", { code: lookupCode });
      setOrder(res);
    } catch (e) {
      setLookupError(String(e));
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">兑换码激活</h1>
        <p className="page-subtitle">输入兑换码和 Gmail 邮箱激活家庭组订单</p>
      </div>
      <div className="page-body animate-in">
        {/* Redeem */}
        <div className="card mb-4">
          <div className="card-header">
            <span>兑换码激活</span>
            <Gift size={16} style={{ color: "var(--color-accent)" }} />
          </div>
          <div className="flex gap-3" style={{ flexDirection: "column" }}>
            <input
              className="input"
              placeholder="输入兑换码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <select
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            >
              <option value="">— 选择邮箱 —</option>
              {accounts.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.email}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-3">
              <button className="btn btn-primary" onClick={handleRedeem} disabled={loading || !code || !email}>
                <Gift size={14} />
                {loading ? "兑换中..." : "兑换"}
              </button>
              {result && (
                <span className="flex items-center gap-2" style={{ color: "var(--color-success)", fontSize: 13 }}>
                  <CheckCircle size={14} /> {result}
                </span>
              )}
              {error && <span style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</span>}
            </div>
          </div>
        </div>

        {/* Order lookup */}
        <div className="card">
          <div className="card-header">
            <span>订单查询</span>
            <Search size={16} style={{ color: "var(--color-accent)" }} />
          </div>
          <div className="flex items-center gap-3 mb-4">
            <input
              className="input"
              style={{ maxWidth: 400 }}
              placeholder="输入兑换码查询订单状态"
              value={lookupCode}
              onChange={(e) => setLookupCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            />
            <button className="btn btn-ghost" onClick={handleLookup} disabled={!lookupCode}>
              <Search size={14} /> 查询
            </button>
          </div>

          {lookupError && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>{lookupError}</p>}

          {order && (
            <div className="table-container">
              <table>
                <tbody>
                  <tr><td style={{ color: "var(--color-text-muted)", width: 120 }}>订单号</td><td>{order.orderNo}</td></tr>
                  <tr><td style={{ color: "var(--color-text-muted)" }}>状态</td><td><OrderStatusBadge status={order.status} /></td></tr>
                  <tr><td style={{ color: "var(--color-text-muted)" }}>邮箱</td><td>{order.userEmail}</td></tr>
                  <tr><td style={{ color: "var(--color-text-muted)" }}>详情</td><td>{order.resultMessage || "—"}</td></tr>
                  <tr><td style={{ color: "var(--color-text-muted)" }}>创建时间</td><td>{new Date(order.createdAt).toLocaleString("zh-CN")}</td></tr>
                  <tr><td style={{ color: "var(--color-text-muted)" }}>更新时间</td><td>{new Date(order.updatedAt).toLocaleString("zh-CN")}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function OrderStatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    CREATED: { cls: "badge-info", label: "已创建" },
    INVITE_SENT: { cls: "badge-warning", label: "邀请已发送" },
    COMPLETED: { cls: "badge-success", label: "已完成" },
    EXPIRED: { cls: "badge-danger", label: "已过期" },
    CANCELLED: { cls: "badge-danger", label: "已取消" },
  };
  const m = map[status] || { cls: "badge-info", label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
