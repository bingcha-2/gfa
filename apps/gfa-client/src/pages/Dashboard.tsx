import { useAppStore } from "../stores/useAppStore";
import { Users, Mail, Zap, Gift } from "lucide-react";

export function Dashboard() {
  const { accounts } = useAppStore();

  const totalAccounts = accounts.length;
  const activeAccounts = accounts.filter((a) => a.status === "active").length;
  const withAntigravity = accounts.filter((a) => a.antigravity_token).length;
  const failedAccounts = accounts.filter((a) => a.status === "login_failed" || a.status === "locked").length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">仪表盘</h1>
        <p className="page-subtitle">Google Family Automation 概览</p>
      </div>
      <div className="page-body animate-in">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">总账号数</div>
            <div className="stat-value accent">{totalAccounts}</div>
            <div className="flex items-center gap-2">
              <Users size={14} style={{ color: "var(--color-text-muted)" }} />
              <span className="text-sm text-muted">已导入账号</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">活跃账号</div>
            <div className="stat-value success">{activeAccounts}</div>
            <div className="flex items-center gap-2">
              <Mail size={14} style={{ color: "var(--color-text-muted)" }} />
              <span className="text-sm text-muted">已完成登录</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Antigravity</div>
            <div className="stat-value" style={{ color: "var(--color-info)" }}>{withAntigravity}</div>
            <div className="flex items-center gap-2">
              <Zap size={14} style={{ color: "var(--color-text-muted)" }} />
              <span className="text-sm text-muted">已授权 OAuth</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">异常账号</div>
            <div className="stat-value warning">{failedAccounts}</div>
            <div className="flex items-center gap-2">
              <Gift size={14} style={{ color: "var(--color-text-muted)" }} />
              <span className="text-sm text-muted">登录失败/锁定</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">最近账号</div>
          {accounts.length === 0 ? (
            <div className="empty-state">
              <Users />
              <p>还没有导入任何账号。前往「账号管理」导入凭据。</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>状态</th>
                    <th>Antigravity</th>
                    <th>导入时间</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.slice(0, 10).map((account) => (
                    <tr key={account.id}>
                      <td className="truncate" style={{ maxWidth: 250 }}>{account.email}</td>
                      <td>
                        <StatusBadge status={account.status} />
                      </td>
                      <td>
                        {account.antigravity_token ? (
                          <span className="badge badge-success">已授权</span>
                        ) : (
                          <span className="badge" style={{ background: "var(--color-bg-elevated)", color: "var(--color-text-muted)" }}>未授权</span>
                        )}
                      </td>
                      <td className="text-muted text-sm">
                        {new Date(account.created_at).toLocaleDateString("zh-CN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <span className="badge badge-success">活跃</span>;
    case "login_failed":
      return <span className="badge badge-danger">登录失败</span>;
    case "locked":
      return <span className="badge badge-danger">锁定</span>;
    case "disabled":
      return <span className="badge badge-warning">停用</span>;
    default:
      return <span className="badge badge-info">新导入</span>;
  }
}
