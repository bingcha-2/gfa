import { useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  Users, Key, CheckCircle, AlertCircle, ShieldAlert,
  ArrowRight, Mail, Gift, ArrowLeftRight,
} from "lucide-react";

export function Dashboard() {
  const { accounts, setCurrentPage, quotaCache } = useAppStore();
  const { tokenCount, activeCount, failedCount, forbiddenCount, stats } = useMemo(() => {
    const tCount = accounts.filter((a) => a.antigravity_token).length;
    const aCount = accounts.filter((a) => a.status === "active").length;
    const fCount = accounts.filter((a) => a.status === "login_failed" || a.status === "locked").length;
    const dCount = accounts.filter((a) => !!quotaCache[a.email]?.is_forbidden).length;

    const s = [
      { icon: Users, label: "总账号", value: accounts.length, cls: "accent" },
      { icon: Key, label: "已授权", value: tCount, cls: "success" },
      { icon: CheckCircle, label: "活跃", value: aCount, cls: "info" },
      { icon: AlertCircle, label: "异常", value: fCount, cls: "warning" },
      ...(dCount > 0 ? [{ icon: ShieldAlert, label: "封禁", value: dCount, cls: "warning" }] : []),
    ];

    return {
      tokenCount: tCount,
      activeCount: aCount,
      failedCount: fCount,
      forbiddenCount: dCount,
      stats: s
    };
  }, [accounts, quotaCache]);

  const quickActions = useMemo(() => [
    { icon: Mail, label: "接受邀请", page: "accept-invite" },
    { icon: Gift, label: "兑换码", page: "redeem" },
    { icon: ArrowLeftRight, label: "账号置换", page: "swap" },
    { icon: Users, label: "账号管理", page: "accounts" },
  ], []);

  const recentAccounts = useMemo(() => accounts.slice(0, 6), [accounts]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">仪表盘</h1>
        <p className="page-subtitle">账号总览与快速操作</p>
      </div>
      <div className="page-body">
        {/* Stats */}
        <div className="bento-grid" style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
          {stats.map((s) => (
            <div key={s.label} className="stat-card">
              <div className={`stat-icon ${s.cls}`}><s.icon size={18} /></div>
              <span className="stat-label">{s.label}</span>
              <span className="stat-value">{s.value}</span>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="card">
          <div className="card-header">
            <span>快速操作</span>
          </div>
          <div className="quick-actions">
            {quickActions.map((a) => (
              <button key={a.page} className="quick-action-btn" onClick={() => setCurrentPage(a.page)}>
                <a.icon size={20} />
                <span className="quick-action-label">{a.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Recent Accounts */}
        {recentAccounts.length > 0 && (
          <div className="card">
            <div className="card-header">
              <span>最近账号</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage("accounts")}>
                查看全部 <ArrowRight size={12} />
              </button>
            </div>
            <div className="account-table-container" style={{ border: "none", boxShadow: "none", background: "transparent" }}>
              <table className="account-table">
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>状态</th>
                    <th>配额</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAccounts.map((a) => {
                    const quota = quotaCache[a.email];
                    const tier = quota?.subscription_tier;
                    return (
                      <tr key={a.id}>
                        <td><span className="account-email-text">{a.email}</span></td>
                        <td>
                          <div className="flex items-center gap-1">
                            <span className={`status-pill ${a.status === "active" ? "active" : a.status === "login_failed" ? "danger" : "info"}`}>
                              {a.status === "active" ? "活跃" : a.status === "login_failed" ? "失败" : "新"}
                            </span>
                            {quota?.is_forbidden && <span className="status-pill forbidden"><ShieldAlert size={10} /> 封禁</span>}
                          </div>
                        </td>
                        <td>{tier ? <span className={`tier-badge ${tier.toLowerCase().includes("ultra") ? "ultra" : tier.toLowerCase().includes("pro") ? "pro" : "free"}`}>{tier}</span> : <span className="text-muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
