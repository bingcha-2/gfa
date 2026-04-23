"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";

type ManagedUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  permissions: string[] | null;
  createdAt: string;
  updatedAt?: string;
};

const ALL_PERMISSIONS = [
  { key: "overview", label: "总览" },
  { key: "daily_stats", label: "数据汇总" },
  { key: "accounts", label: "母号池" },
  { key: "groups", label: "家庭组" },
  { key: "orders", label: "订单" },
  { key: "tasks", label: "任务" },
  { key: "codes", label: "卡密" },
  { key: "expire", label: "到期扫描" },
  { key: "scheduler", label: "自动维护" },
  { key: "lookup", label: "成员管理" },
  { key: "faq", label: "FAQ管理" },
];

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "超级管理员",
  ADMIN: "管理员",
  OPERATIONS: "运营",
  SUPPORT: "客服",
};

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN: "#e74c3c",
  ADMIN: "#f39c12",
  OPERATIONS: "#2ecc71",
  SUPPORT: "#3498db",
};

type Props = {
  showToast: (type: "success" | "error" | "info", msg: string) => void;
};

export function UserManagementPanel({ showToast }: Props) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resetPwId, setResetPwId] = useState<string | null>(null);

  // Create form state
  const [createForm, setCreateForm] = useState({
    email: "", displayName: "", password: "", role: "ADMIN", permissions: [] as string[]
  });

  // Edit form state
  const [editForm, setEditForm] = useState({
    displayName: "", role: "", permissions: [] as string[] | null
  });

  // Reset password form
  const [resetPw, setResetPw] = useState("");

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest<ManagedUser[]>("users");
      setUsers(data);
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiRequest("users", {
        method: "POST",
        body: {
          email: createForm.email,
          displayName: createForm.displayName,
          password: createForm.password,
          role: createForm.role,
          permissions: createForm.permissions.length > 0 ? createForm.permissions : null,
        },
      });
      showToast("success", `用户 ${createForm.email} 创建成功`);
      setShowCreateForm(false);
      setCreateForm({ email: "", displayName: "", password: "", role: "ADMIN", permissions: [] });
      await loadUsers();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  async function handleUpdate(id: string) {
    try {
      await apiRequest(`users/${id}`, {
        method: "PATCH",
        body: {
          displayName: editForm.displayName,
          role: editForm.role,
          permissions: editForm.permissions,
        },
      });
      showToast("success", "用户信息已更新");
      setEditingId(null);
      await loadUsers();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  async function handleResetPassword(id: string) {
    try {
      await apiRequest(`users/${id}/reset-password`, {
        method: "PATCH",
        body: { password: resetPw },
      });
      showToast("success", "密码已重置");
      setResetPwId(null);
      setResetPw("");
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  async function handleDelete(id: string, email: string) {
    if (!confirm(`确认删除用户 ${email}？此操作不可恢复。`)) return;
    try {
      await apiRequest(`users/${id}`, { method: "DELETE" });
      showToast("success", `用户 ${email} 已删除`);
      await loadUsers();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  function startEdit(user: ManagedUser) {
    setEditingId(user.id);
    setEditForm({
      displayName: user.displayName,
      role: user.role,
      permissions: user.permissions ?? [],
    });
  }

  function togglePermission(perms: string[], key: string): string[] {
    return perms.includes(key) ? perms.filter((p) => p !== key) : [...perms, key];
  }

  function renderPermCheckboxes(perms: string[], onChange: (newPerms: string[]) => void) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 6 }}>
        {ALL_PERMISSIONS.map((p) => (
          <label key={p.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={perms.includes(p.key)}
              onChange={() => onChange(togglePermission(perms, p.key))}
            />
            {p.label}
          </label>
        ))}
      </div>
    );
  }

  if (loading) return <div className="empty-state">加载中...</div>;

  return (
    <div className="panel-stack">
      <div className="section-copy">
        <p className="label">系统管理</p>
        <h2 className="panel-title">用户管理</h2>
        <p className="muted">管理控制台管理员账号和权限分配。</p>
      </div>

      {/* Create button */}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" onClick={() => setShowCreateForm(!showCreateForm)}>
          {showCreateForm ? "取消" : "＋ 创建用户"}
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <form className="glass-panel" style={{ padding: 16 }} onSubmit={handleCreate}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label className="field-label">
              邮箱
              <input className="field-input" type="email" required value={createForm.email}
                onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))} placeholder="user@example.com" />
            </label>
            <label className="field-label">
              显示名
              <input className="field-input" required value={createForm.displayName}
                onChange={(e) => setCreateForm((p) => ({ ...p, displayName: e.target.value }))} placeholder="管理员名称" />
            </label>
            <label className="field-label">
              密码
              <input className="field-input" type="password" required minLength={6} value={createForm.password}
                onChange={(e) => setCreateForm((p) => ({ ...p, password: e.target.value }))} placeholder="至少6位" />
            </label>
            <label className="field-label">
              角色
              <select className="field-input" value={createForm.role}
                onChange={(e) => setCreateForm((p) => ({ ...p, role: e.target.value }))}>
                <option value="ADMIN">管理员</option>
                <option value="OPERATIONS">运营</option>
                <option value="SUPPORT">客服</option>
              </select>
            </label>
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="field-label" style={{ marginBottom: 4 }}>权限模块（留空 = 所有权限）</label>
            {renderPermCheckboxes(createForm.permissions, (newPerms) => setCreateForm((p) => ({ ...p, permissions: newPerms })))}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button className="btn btn-primary" type="submit">创建</button>
            <button className="btn" type="button" onClick={() => setShowCreateForm(false)}>取消</button>
          </div>
        </form>
      )}

      {/* User list */}
      <div className="list-stack">
        {users.map((user) => (
          <div className="glass-panel" key={user.id} style={{ padding: 16 }}>
            {editingId === user.id ? (
              /* Edit mode */
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label className="field-label">
                    显示名
                    <input className="field-input" value={editForm.displayName}
                      onChange={(e) => setEditForm((p) => ({ ...p, displayName: e.target.value }))} />
                  </label>
                  {user.role !== "SUPER_ADMIN" && (
                    <label className="field-label">
                      角色
                      <select className="field-input" value={editForm.role}
                        onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value }))}>
                        <option value="ADMIN">管理员</option>
                        <option value="OPERATIONS">运营</option>
                        <option value="SUPPORT">客服</option>
                      </select>
                    </label>
                  )}
                </div>
                {user.role !== "SUPER_ADMIN" && (
                  <div style={{ marginTop: 12 }}>
                    <label className="field-label" style={{ marginBottom: 4 }}>权限模块（留空 = 所有权限）</label>
                    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <button type="button" className="btn" style={{ fontSize: 12, padding: "2px 8px" }}
                        onClick={() => setEditForm((p) => ({ ...p, permissions: ALL_PERMISSIONS.map(pp => pp.key) }))}>全选</button>
                      <button type="button" className="btn" style={{ fontSize: 12, padding: "2px 8px" }}
                        onClick={() => setEditForm((p) => ({ ...p, permissions: [] }))}>清空(全部权限)</button>
                    </div>
                    {renderPermCheckboxes(editForm.permissions ?? [], (newPerms) => setEditForm((p) => ({ ...p, permissions: newPerms })))}
                  </div>
                )}
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button className="btn btn-primary" onClick={() => handleUpdate(user.id)}>保存</button>
                  <button className="btn" onClick={() => setEditingId(null)}>取消</button>
                </div>
              </div>
            ) : resetPwId === user.id ? (
              /* Reset password mode */
              <div>
                <div style={{ marginBottom: 8 }}>
                  <strong>{user.displayName}</strong> ({user.email}) — 重置密码
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input className="field-input" type="password" placeholder="新密码（至少6位）" minLength={6}
                    value={resetPw} onChange={(e) => setResetPw(e.target.value)}
                    style={{ maxWidth: 300 }} />
                  <button className="btn btn-primary" onClick={() => handleResetPassword(user.id)}
                    disabled={resetPw.length < 6}>确认重置</button>
                  <button className="btn" onClick={() => { setResetPwId(null); setResetPw(""); }}>取消</button>
                </div>
              </div>
            ) : (
              /* Display mode */
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong style={{ fontSize: 15 }}>{user.displayName}</strong>
                    <span style={{
                      display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                      color: "#fff", background: ROLE_COLORS[user.role] ?? "#888",
                    }}>
                      {ROLE_LABELS[user.role] ?? user.role}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{user.email}</div>
                  {user.permissions && user.permissions.length > 0 && (
                    <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {user.permissions.map((p) => {
                        const label = ALL_PERMISSIONS.find((ap) => ap.key === p)?.label ?? p;
                        return (
                          <span key={p} style={{
                            display: "inline-block", padding: "1px 6px", borderRadius: 3,
                            fontSize: 11, background: "var(--surface-2, #333)", color: "var(--text-muted, #aaa)",
                          }}>{label}</span>
                        );
                      })}
                    </div>
                  )}
                  {(!user.permissions || user.permissions.length === 0) && user.role !== "SUPER_ADMIN" && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>全部权限</div>
                  )}
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    创建于 {new Date(user.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                  </div>
                </div>
                {user.role !== "SUPER_ADMIN" && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button className="btn" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => startEdit(user)}>编辑</button>
                    <button className="btn" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setResetPwId(user.id)}>重置密码</button>
                    <button className="btn" style={{ fontSize: 12, padding: "4px 10px", color: "#e74c3c" }}
                      onClick={() => handleDelete(user.id, user.email)}>删除</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
