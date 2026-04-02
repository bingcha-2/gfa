"use client";

import { useState } from "react";

import { formatDateTime } from "../lib/format";
import { canCreateAccount } from "../lib/permissions";
import { AccountSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type BulkImportResult = {
  total: number;
  created: number;
  skipped: number;
  errorCount: number;
  createdEmails: string[];
  skippedEmails: string[];
  errors: string[];
};

type AccountPanelProps = {
  accounts: AccountSummary[];
  role?: string;
  onCreate: (payload: {
    name: string;
    loginEmail: string;
    adspowerProfileId: string;
    loginPassword: string;
    totpSecret?: string;
    notes?: string;
  }) => Promise<boolean>;
  onBulkImport: (payload: { lines: string[], subscriptionExpiresAt?: string }) => Promise<BulkImportResult | null>;
  onDelete: (id: string) => Promise<boolean>;
  onUpdate: (id: string, payload: Record<string, string | undefined>) => Promise<boolean>;
  onConfirmLogin?: (id: string) => Promise<boolean>;
  onSyncAccount?: (id: string) => Promise<boolean>;
};

export function AccountPanel({ accounts, onCreate, onBulkImport, onDelete, onUpdate, onConfirmLogin, onSyncAccount, role }: AccountPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const canManage = canCreateAccount(role);
  const [activeTab, setActiveTab] = useState<"list" | "create" | "bulk" | "edit">("list");
  const [form, setForm] = useState({
    name: "",
    loginEmail: "",
    adspowerProfileId: "",
    loginPassword: "",
    totpSecret: "",
    notes: ""
  });
  const [bulkText, setBulkText] = useState("");
  const [bulkSubscriptionExpiresAt, setBulkSubscriptionExpiresAt] = useState(() => {
    const today = new Date();
    today.setMonth(today.getMonth() + 1);
    return today.toISOString().split("T")[0];
  });
  const [bulkResult, setBulkResult] = useState<BulkImportResult | null>(null);
  const [isBulkSubmitting, setIsBulkSubmitting] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    adspowerProfileId: "",
    loginPassword: "",
    totpSecret: "",
    notes: "",
    subscriptionExpiresAt: "",
    subscriptionPlan: ""
  });
  const [isEditSubmitting, setIsEditSubmitting] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterAccountStatus, setFilterAccountStatus] = useState("ALL");
  const [filterSubStatus, setFilterSubStatus] = useState("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;

  function startEdit(account: AccountSummary) {
    setEditId(account.id);
    // Convert ISO datetime to YYYY-MM-DD for date input
    let expiresDate = "";
    if (account.subscriptionExpiresAt) {
      try { expiresDate = new Date(account.subscriptionExpiresAt).toISOString().split("T")[0]; } catch { /* noop */ }
    }
    setEditForm({
      name: account.name,
      adspowerProfileId: account.adspowerProfileId,
      loginPassword: account.loginPassword ?? "",
      totpSecret: account.totpSecret ?? "",
      notes: (account as any).notes ?? "",
      subscriptionExpiresAt: expiresDate,
      subscriptionPlan: (account as any).subscriptionPlan ?? ""
    });
    setActiveTab("edit");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canManage) {
      return;
    }

    setIsSubmitting(true);

    try {
      const success = await onCreate(form);

      if (success) {
        setForm({
          name: "",
          loginEmail: "",
          adspowerProfileId: "",
          loginPassword: "",
          totpSecret: "",
          notes: ""
        });
        setActiveTab("list");
      }
    } finally {
      setIsSubmitting(false);
    }
  }


  // Filtered and paginated accounts
  const filteredAccounts = accounts.filter(a => {
    const q = searchTerm ? searchTerm.toLowerCase() : '';
    const matchSearch = !q || a.name.toLowerCase().includes(q) || a.loginEmail.toLowerCase().includes(q) || a.adspowerProfileId.toLowerCase().includes(q);
    const matchStatus = filterAccountStatus === 'ALL' || a.status === filterAccountStatus;
    const matchSub = filterSubStatus === 'ALL' || (a.subscriptionStatus ?? '未知') === filterSubStatus;
    return matchSearch && matchStatus && matchSub;
  });
  const totalPages = Math.ceil(filteredAccounts.length / PAGE_SIZE);
  const paginatedAccounts = filteredAccounts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section id="accounts" className="glass-panel account-panel">
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">账号列表</p>
            <h2 className="panel-title">母号池</h2>
            <p className="muted">记录登录邮箱、AdsPower profile 和当前健康状态。</p>
          </div>
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "list" ? " active" : ""}`}
            onClick={() => setActiveTab("list")}
            type="button"
          >
            母号列表
          </button>
          <button
            className={`panel-tab${activeTab === "create" ? " active" : ""}`}
            onClick={() => setActiveTab("create")}
            type="button"
          >
            新增母号
          </button>
          <button
            className={`panel-tab${activeTab === "bulk" ? " active" : ""}`}
            onClick={() => { setActiveTab("bulk"); setBulkResult(null); }}
            type="button"
          >
            批量导入
          </button>
        </div>

        {activeTab === "bulk" ? (
          canManage ? (
            <div className="form-card panel-stack workspace-form">
              <div className="section-copy">
                <h3 className="panel-title" style={{ fontSize: '1rem' }}>批量导入母号</h3>
                <p className="muted">每行一个账号，支持以下两种格式：</p>
              </div>
              <div className="bulk-format-hint" style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '12px 16px', fontSize: '0.875rem', fontFamily: 'monospace', lineHeight: 1.8 }}>
                <div><strong>格式 1：</strong>邮箱----密码----辅助邮箱----2FA密钥</div>
                <div><strong>格式 2：</strong>邮箱——密码——2FA密钥</div>
                <div><strong>格式 3：</strong>邮箱----密码----辅助邮箱----2FA链接</div>
                <div><strong>格式 4：</strong>邮箱----密码----2FA密钥----辅助邮箱</div>
                <div style={{ marginTop: '8px', color: 'var(--text-muted, #888)' }}>字段 3、4 自动识别（含 @ 为辅助邮箱，否则为 2FA 密钥/链接）</div>
              </div>
              <div className="field">
                <label htmlFor="bulk-preset-expire">预设订阅到期时间</label>
                <input
                  id="bulk-preset-expire"
                  type="date"
                  value={bulkSubscriptionExpiresAt}
                  onChange={(e) => setBulkSubscriptionExpiresAt(e.target.value)}
                  style={{ width: "100%", maxWidth: "300px" }}
                />
                <p className="muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                  本次导入的所有新母号将会默认关联此到期时间 (默认当前之后一个月)
                </p>
              </div>
              <div className="field">
                <label htmlFor="bulk-lines">账号数据（每行一个）</label>
                <textarea
                  id="bulk-lines"
                  rows={8}
                  placeholder={'邮箱----密码----辅助邮箱----2FA密钥\n邮箱——密码——2FA密钥'}
                  value={bulkText}
                  onChange={(event) => setBulkText(event.target.value)}
                  style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
                />
              </div>
              <div className="inline-actions">
                <button className="button secondary" onClick={() => { setActiveTab("list"); setBulkResult(null); }} type="button">
                  返回列表
                </button>
                <button
                  className="button"
                  disabled={isBulkSubmitting || !bulkText.trim()}
                  type="button"
                  onClick={async () => {
                    setIsBulkSubmitting(true);
                    setBulkResult(null);
                    try {
                      const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
                      const result = await onBulkImport({ lines, subscriptionExpiresAt: bulkSubscriptionExpiresAt || undefined });
                      setBulkResult(result);
                      if (result && result.created > 0) {
                        setBulkText("");
                      }
                    } finally {
                      setIsBulkSubmitting(false);
                    }
                  }}
                >
                  {isBulkSubmitting ? "导入中..." : `导入 (${bulkText.split('\n').filter(l => l.trim()).length} 行)`}
                </button>
              </div>
              {bulkResult && (
                <div className="bulk-result" style={{ marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span>总计: <strong>{bulkResult.total}</strong></span>
                    <span style={{ color: 'var(--emerald, #059669)' }}>成功: <strong>{bulkResult.created}</strong></span>
                    <span style={{ color: 'var(--amber, #d97706)' }}>跳过: <strong>{bulkResult.skipped}</strong></span>
                    <span style={{ color: 'var(--red, #dc2626)' }}>错误: <strong>{bulkResult.errorCount}</strong></span>
                  </div>
                  {bulkResult.errors.length > 0 && (
                    <div style={{ background: 'var(--surface-error, #fef2f2)', borderRadius: '6px', padding: '10px 14px', fontSize: '0.875rem', maxHeight: '160px', overflowY: 'auto' }}>
                      <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--red, #dc2626)' }}>错误详情：</div>
                      {bulkResult.errors.map((err, idx) => (
                        <div key={idx} style={{ color: '#666', lineHeight: 1.6 }}>{err}</div>
                      ))}
                    </div>
                  )}
                  {bulkResult.createdEmails.length > 0 && (
                    <div style={{ background: 'var(--surface-success, #f0fdf4)', borderRadius: '6px', padding: '10px 14px', fontSize: '0.875rem', marginTop: '8px', maxHeight: '160px', overflowY: 'auto' }}>
                      <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--emerald, #059669)' }}>成功导入：</div>
                      {bulkResult.createdEmails.map((email, idx) => (
                        <div key={idx} style={{ color: '#666', lineHeight: 1.6 }}>{email}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">只读模式</p>
                <h3 className="panel-title">当前角色没有批量导入权限</h3>
              </div>
              <p className="muted">批量导入只对 ADMIN 开放。</p>
            </div>
          )
        ) : activeTab === "edit" && editId ? (
          <form className="form-card field-grid workspace-form" onSubmit={async (e) => {
            e.preventDefault();
            if (!editId) return;
            setIsEditSubmitting(true);
            try {
              const ok = await onUpdate(editId, {
                name: editForm.name,
                adspowerProfileId: editForm.adspowerProfileId,
                loginPassword: editForm.loginPassword || undefined,
                totpSecret: editForm.totpSecret || undefined,
                notes: editForm.notes || undefined,
                subscriptionExpiresAt: editForm.subscriptionExpiresAt || "",
                subscriptionPlan: editForm.subscriptionPlan || ""
              });
              if (ok) {
                setActiveTab("list");
                setEditId(null);
              }
            } finally {
              setIsEditSubmitting(false);
            }
          }}>
            <div className="section-copy">
              <h3 className="panel-title" style={{ fontSize: '1rem' }}>编辑母号</h3>
              <p className="muted">修改后点击保存，密码/TOTP 留空则不更新。</p>
            </div>
            <div className="field-grid two-up">
              <div className="field">
                <label htmlFor="edit-name">名称</label>
                <input
                  id="edit-name"
                  required
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-profile">AdsPower Profile ID</label>
                <input
                  id="edit-profile"
                  required
                  value={editForm.adspowerProfileId}
                  onChange={(e) => setEditForm({ ...editForm, adspowerProfileId: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-password">登录密码</label>
                <input
                  id="edit-password"
                  type="text"
                  autoComplete="off"
                  placeholder="登录密码"
                  value={editForm.loginPassword}
                  onChange={(e) => setEditForm({ ...editForm, loginPassword: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-totp">TOTP 密钥</label>
                <input
                  id="edit-totp"
                  type="text"
                  autoComplete="off"
                  placeholder="Base32 格式"
                  value={editForm.totpSecret}
                  onChange={(e) => setEditForm({ ...editForm, totpSecret: e.target.value.replace(/\s/g, "").toUpperCase() })}
                />
              </div>
            </div>
            <div className="field-grid two-up">
              <div className="field">
                <label htmlFor="edit-sub-expires">订阅到期时间 <span className="muted">(手动填写)</span></label>
                <input
                  id="edit-sub-expires"
                  type="date"
                  value={editForm.subscriptionExpiresAt}
                  onChange={(e) => setEditForm({ ...editForm, subscriptionExpiresAt: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-sub-plan">订阅计划 <span className="muted">(如 Google AI Ultra 30 TB)</span></label>
                <input
                  id="edit-sub-plan"
                  placeholder="订阅计划名称（可选）"
                  value={editForm.subscriptionPlan}
                  onChange={(e) => setEditForm({ ...editForm, subscriptionPlan: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="edit-notes">备注</label>
              <textarea
                id="edit-notes"
                rows={3}
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              />
            </div>
            <div className="inline-actions">
              <button className="button secondary" type="button" onClick={() => { setActiveTab("list"); setEditId(null); }}>
                取消
              </button>
              <button className="button" type="submit" disabled={isEditSubmitting}>
                {isEditSubmitting ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        ) : activeTab === "create" ? (
          canManage ? (
            <form className="form-card field-grid workspace-form" onSubmit={submit}>
              <div className="field-grid two-up">
                <div className="field">
                  <label htmlFor="account-name">母号名称</label>
                  <input
                    id="account-name"
                    required
                    value={form.name}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        name: event.target.value
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="account-email">登录邮箱</label>
                  <input
                    id="account-email"
                    required
                    type="email"
                    value={form.loginEmail}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        loginEmail: event.target.value.trim()
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="adspower-profile">AdsPower Profile ID</label>
                  <input
                    id="adspower-profile"
                    required
                    value={form.adspowerProfileId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        adspowerProfileId: event.target.value.trim()
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="account-password">登录密码</label>
                  <input
                    id="account-password"
                    required
                    type="password"
                    placeholder="Google 账号密码（必填）"
                    value={form.loginPassword}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        loginPassword: event.target.value
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="account-totp">TOTP 密钥</label>
                  <input
                    id="account-totp"
                    type="password"
                    placeholder="Base32 格式（如 JBSWY3DPEHPK3PXP）"
                    value={form.totpSecret}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        totpSecret: event.target.value.replace(/\s/g, "").toUpperCase()
                      }))
                    }
                  />
                </div>
                <div className="field field-span-2">
                  <label htmlFor="account-notes">备注</label>
                  <textarea
                    id="account-notes"
                    value={form.notes}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        notes: event.target.value
                      }))
                    }
                  />
                </div>
              </div>
              <div className="inline-actions">
                <button className="button secondary" onClick={() => setActiveTab("list")} type="button">
                  返回列表
                </button>
                <button className="button" disabled={isSubmitting} type="submit">
                  {isSubmitting ? "创建中..." : "新增母号"}
                </button>
              </div>
            </form>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">只读模式</p>
                <h3 className="panel-title">当前角色没有新增母号权限</h3>
              </div>
              <p className="muted">
                母号创建只对 `ADMIN` 开放。当前账号可以查看母号状态，但不能新增或修改。
              </p>
            </div>
          )
        ) : (
          <div className="table-wrap table-wrap-accounts workspace-table-wrap">
            {/* Search bar */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
              <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.9rem', pointerEvents: 'none' }}>🔍</span>
                <input
                  type="text"
                  placeholder="搜索名称 / 邮箱 / Profile ID…"
                  value={searchTerm}
                  onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                  style={{ paddingLeft: 32, width: '100%', boxSizing: 'border-box' }}
                />
              </div>
              <span className="muted" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                {filteredAccounts.length} / {accounts.length} 条
              </span>
              <select
                value={filterAccountStatus}
                onChange={(e) => { setFilterAccountStatus(e.target.value); setCurrentPage(1); }}
                style={{ flex: '0 0 auto', minWidth: 120, height: '36px', borderRadius: '8px', border: '1px solid var(--border, #e5e5e5)', fontSize: '0.875rem' }}
              >
                <option value="ALL">全部状态</option>
                <option value="HEALTHY">🟢 活跃</option>
                <option value="LOGIN_REQUIRED">🔑 需登录</option>
                <option value="VERIFICATION_REQUIRED">⚠️ 需验证</option>
                <option value="RISKY">🔶 风险</option>
                <option value="DISABLED">🚫 禁用</option>
              </select>
              <select
                value={filterSubStatus}
                onChange={(e) => { setFilterSubStatus(e.target.value); setCurrentPage(1); }}
                style={{ flex: '0 0 auto', minWidth: 120, height: '36px', borderRadius: '8px', border: '1px solid var(--border, #e5e5e5)', fontSize: '0.875rem' }}
              >
                <option value="ALL">全部订阅</option>
                <option value="ACTIVE">🟢 订阅活跃</option>
                <option value="SUSPENDED">⏸ 已暂停</option>
                <option value="EXPIRED">🔴 已过期</option>
              </select>
              {(searchTerm || filterAccountStatus !== 'ALL' || filterSubStatus !== 'ALL') && (
                <button className="button secondary small" type="button" onClick={() => { setSearchTerm(''); setFilterAccountStatus('ALL'); setFilterSubStatus('ALL'); setCurrentPage(1); }} style={{ whiteSpace: 'nowrap' }}>清除</button>
              )}
            </div>
            <table className="data-table data-table-accounts">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>登录邮箱</th>
                  <th>状态</th>
                  <th>统计</th>
                  {canManage && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {paginatedAccounts.length ? (<>
                  {paginatedAccounts.map((account) => (
                    <tr key={account.id}>
                      <td>
                        <div className="account-primary">
                          <div className="strong account-name">{account.name}</div>
                          <div className="muted mono account-meta">{account.adspowerProfileId}</div>
                        </div>
                      </td>
                      <td>
                        <div className="account-email">{account.loginEmail}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <StatusBadge value={account.status} />
                          <StatusBadge
                            value={account.hasTotpSecret ? "TOTP" : "No TOTP"}
                            tone={account.hasTotpSecret ? "emerald" : "amber"}
                          />
                        </div>
                      </td>
                      <td>
                        <div className="account-stats">
                          <div>{account._count?.familyGroups ?? 0} 组 · {account._count?.tasks ?? 0} 任务</div>
                          <div className="muted account-meta">
                            登录 {formatDateTime(account.lastLoginAt)} · 到期 {account.subscriptionExpiresAt ? formatDateTime(account.subscriptionExpiresAt) : "未知"}
                          </div>
                          <StatusBadge
                            value={account.subscriptionStatus ?? "未知"}
                            tone={
                              account.subscriptionStatus === "ACTIVE"
                                ? "emerald"
                                : account.subscriptionStatus === "EXPIRED" || account.subscriptionStatus === "SUSPENDED"
                                ? "crimson"
                                : "amber"
                            }
                          />
                        </div>
                      </td>
                      {canManage && (
                        <td>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            <button
                              className="button secondary small"
                              onClick={() => startEdit(account)}
                              type="button"
                            >
                              编辑
                            </button>
                            <button
                              className="button danger small"
                              disabled={deletingId === account.id || syncingId === account.id || confirmingId === account.id}
                              onClick={async () => {
                                if (!confirm(`确定删除母号 ${account.loginEmail}？\n该操作会同时删除关联的家庭组和成员记录。`)) return;
                                setDeletingId(account.id);
                                try {
                                  await onDelete(account.id);
                                } finally {
                                  setDeletingId(null);
                                }
                              }}
                            >
                              {deletingId === account.id ? "删除中..." : "删除"}
                            </button>
                            {/* Sync Account Groups (ignoreCooldown) */}
                            {onSyncAccount && (
                              <button
                                className="button small"
                                style={{ background: 'var(--emerald, #059669)', color: 'white', borderColor: 'var(--emerald, #059669)' }}
                                disabled={syncingId === account.id || confirmingId === account.id || deletingId === account.id}
                                title="强制为该母号底下的所有组发起同步以解异常，无视冷却期"
                                onClick={async () => {
                                  if (!confirm(`确定要强制同步母号 ${account.loginEmail} 吗？\n将无视冷却期立刻启动浏览器同步家庭组。如同步成功，账号状态会自动恢复健康！`)) return;
                                  setSyncingId(account.id);
                                  try {
                                    await onSyncAccount(account.id);
                                  } finally {
                                    setSyncingId(null);
                                  }
                                }}
                              >
                                {syncingId === account.id ? "调度中..." : "同步"}
                              </button>
                            )}
                            {/* Confirm Login: show only for accounts needing manual intervention */}
                            {onConfirmLogin && (
                              account.status === "MANUAL_REVIEW" ||
                              account.status === "VERIFICATION_REQUIRED" ||
                              account.status === "LOGIN_REQUIRED"
                            ) && (
                              <button
                                className="button small"
                                style={{ background: 'var(--warm, #d97706)' }}
                                disabled={confirmingId === account.id || syncingId === account.id || deletingId === account.id}
                                title="运维人工在 AdsPower 中登录后点此确认，系统会重置账号状态并重试待处理任务"
                                onClick={async () => {
                                  setConfirmingId(account.id);
                                  try {
                                    await onConfirmLogin!(account.id);
                                  } finally {
                                    setConfirmingId(null);
                                  }
                                }}
                              >
                                {confirmingId === account.id ? "确认中..." : "确认已登录"}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                   ))}
                {/* Pagination */}
                {totalPages > 1 && (
                  <tr>
                    <td colSpan={canManage ? 5 : 4}>
                      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
                        <button className="button secondary small" disabled={currentPage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} type="button" style={{ minWidth: 60 }}>← 上页</button>
                        <span style={{ fontSize: '0.85rem' }}>{currentPage} / {totalPages}</span>
                        <button className="button secondary small" disabled={currentPage >= totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} type="button" style={{ minWidth: 60 }}>下页 →</button>
                      </div>
                    </td>
                  </tr>
                )}
                </>) : (
                  <tr>
                    <td colSpan={canManage ? 5 : 4}>
                      <div className="empty-state">{searchTerm ? "没有匹配的母号。" : "还没有录入任何母号。"}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
