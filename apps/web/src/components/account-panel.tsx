"use client";

import { useState } from "react";

import { formatDateTime } from "../lib/format";
import { canCreateAccount } from "../lib/permissions";
import { AccountSummary } from "../lib/types";
import { ConfirmButton } from "./confirm-button";
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
  const [searchTerm, setSearchTerm] = useState("");
  const [filterAccountStatus, setFilterAccountStatus] = useState("ALL");
  const [filterSubStatus, setFilterSubStatus] = useState("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copyToast, setCopyToast] = useState("");
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
    let matchStatus = filterAccountStatus === 'ALL' || a.status === filterAccountStatus;
    // Special filters that check syncError field on associated family groups
    if (filterAccountStatus === 'PASSWORD_ERROR') {
      matchStatus = (a as any).syncError === 'PASSWORD_ERROR' || a.status === 'MANUAL_ONLY';
    } else if (filterAccountStatus === 'CAPTCHA') {
      matchStatus = (a as any).syncError === 'CAPTCHA_REQUIRED' || a.status === 'VERIFICATION_REQUIRED';
    } else if (filterAccountStatus === 'INVITE_COOLDOWN') {
      matchStatus = (a as any).syncError === 'INVITE_COOLDOWN';
    }
    const matchSub = filterSubStatus === 'ALL' || (a.subscriptionStatus ?? '未知') === filterSubStatus;
    return matchSearch && matchStatus && matchSub;
  });
  const totalPages = Math.ceil(filteredAccounts.length / PAGE_SIZE);
  const paginatedAccounts = filteredAccounts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const riskyToday = accounts.filter(a => a.status === "RISKY" && new Date(a.updatedAt) >= todayStart);
  const riskyCount = riskyToday.length;

  return (
    <section id="accounts" className="glass-panel account-panel">
      <div className="panel-stack">
        {riskyCount > 0 && (
          <div className="notice warning" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <span>⚠️ 检测到 {riskyCount} 个账号处于“风控 (RISKY)”状态</span>
            </div>
            <div style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>
              账号发生过多连续错误被挂起以防封号。系统已升级为：<strong>允许自动冷却 30 分钟。</strong><br />
              在此期间暂不派发新任务，冷却期结束后系统会自动对其尝试健康检查并同步，若恢复正常则该状态将被自动解除。<br />
              如果您通过手动“确认已登录”或“强制同步”功能处理了异常，状态也会立刻重置。
            </div>
          </div>
        )}
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
                <div><strong>格式 1：</strong>邮箱---密码---辅助邮箱---2FA密钥 (支持3个或4个减号)</div>
                <div><strong>格式 2：</strong>邮箱——密码——2FA密钥</div>
                <div><strong>格式 3：</strong>邮箱---密码---辅助邮箱---2FA链接</div>
                <div><strong>格式 4：</strong>邮箱---密码---2FA密钥---辅助邮箱</div>
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
                onChange={(e) => { setFilterAccountStatus(e.target.value); setCurrentPage(1); setSelectedIds(new Set()); }}
                style={{ flex: '0 0 auto', minWidth: 120, height: '36px', borderRadius: '8px', border: '1px solid var(--border, #e5e5e5)', fontSize: '0.875rem' }}
              >
                <option value="ALL">全部状态</option>
                <option value="HEALTHY">🟢 活跃</option>
                <option value="LOGIN_REQUIRED">🔑 需登录</option>
                <option value="VERIFICATION_REQUIRED">⚠️ 需验证</option>
                <option value="MANUAL_ONLY">⏸ 仅手动</option>
                <option value="MANUAL_REVIEW">🔍 人工审核</option>
                <option value="RISKY">🔶 风险</option>
                <option value="DISABLED">🚫 禁用</option>
                <option value="PASSWORD_ERROR">🔴 密码错误</option>
                <option value="CAPTCHA">🤖 人机验证</option>
                <option value="INVITE_COOLDOWN">🚫 邀请受限</option>
              </select>
              <select
                value={filterSubStatus}
                onChange={(e) => { setFilterSubStatus(e.target.value); setCurrentPage(1); setSelectedIds(new Set()); }}
                style={{ flex: '0 0 auto', minWidth: 120, height: '36px', borderRadius: '8px', border: '1px solid var(--border, #e5e5e5)', fontSize: '0.875rem' }}
              >
                <option value="ALL">全部订阅</option>
                <option value="ACTIVE">🟢 订阅活跃</option>
                <option value="SUSPENDED">⏸ 已暂停</option>
                <option value="EXPIRED">🔴 已过期</option>
              </select>
              {(searchTerm || filterAccountStatus !== 'ALL' || filterSubStatus !== 'ALL') && (
                <button className="button secondary small" type="button" onClick={() => { setSearchTerm(''); setFilterAccountStatus('ALL'); setFilterSubStatus('ALL'); setCurrentPage(1); setSelectedIds(new Set()); }} style={{ whiteSpace: 'nowrap' }}>清除</button>
              )}
            </div>
            {/* Multi-select action bar */}
            {selectedIds.size > 0 && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', padding: '8px 12px', background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>已选 {selectedIds.size} 个</span>
                <button
                  className="button small"
                  type="button"
                  onClick={() => {
                    const emails = filteredAccounts.filter(a => selectedIds.has(a.id)).map(a => a.loginEmail).join('\n');
                    navigator.clipboard.writeText(emails);
                    setCopyToast(`已复制 ${selectedIds.size} 个邮箱`);
                    setTimeout(() => setCopyToast(''), 2000);
                  }}
                  style={{ background: 'var(--accent, #6366f1)', color: 'white' }}
                >
                  📋 复制邮箱
                </button>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => {
                    setSelectedIds(new Set(filteredAccounts.map(a => a.id)));
                  }}
                >
                  全选当前 ({filteredAccounts.length})
                </button>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                >
                  取消全选
                </button>
                {copyToast && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--emerald, #059669)', fontWeight: 600, animation: 'fadeIn 0.3s ease' }}>✅ {copyToast}</span>
                )}
              </div>
            )}
            <table className="data-table data-table-accounts">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      checked={paginatedAccounts.length > 0 && paginatedAccounts.every(a => selectedIds.has(a.id))}
                      onChange={(e) => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) {
                            paginatedAccounts.forEach(a => next.add(a.id));
                          } else {
                            paginatedAccounts.forEach(a => next.delete(a.id));
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
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
                    <tr key={account.id} style={selectedIds.has(account.id) ? { background: 'rgba(99, 102, 241, 0.06)' } : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(account.id)}
                          onChange={(e) => {
                            setSelectedIds(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(account.id);
                              else next.delete(account.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td>
                        <div className="account-primary">
                          <div className="strong account-name">{account.name}</div>
                          <div className="muted mono account-meta">{account.adspowerProfileId}</div>
                          {(account as any).notes && (
                            <div className="muted" style={{ fontSize: "0.80rem", marginTop: "4px", backgroundColor: "var(--surface-2, #f5f5f4)", padding: "2px 6px", borderRadius: "4px", display: "inline-block" }}>
                              备注: {(account as any).notes}
                            </div>
                          )}
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
                            <ConfirmButton
                              className="button danger small"
                              confirmLabel="确定删除？"
                              loadingLabel="删除中..."
                              onConfirm={() => onDelete(account.id)}
                            >
                              删除
                            </ConfirmButton>
                            {onSyncAccount && (
                              <ConfirmButton
                                className="button small"
                                style={{ background: 'var(--emerald, #059669)', color: 'white', borderColor: 'var(--emerald, #059669)' }}
                                armedStyle={{ background: 'var(--warm, #d97706)', borderColor: 'var(--warm, #d97706)' }}
                                confirmLabel="确定同步？"
                                loadingLabel="调度中..."
                                title="强制为该母号底下的所有组发起同步以解异常，无视冷却期"
                                onConfirm={() => onSyncAccount(account.id)}
                              >
                                同步
                              </ConfirmButton>
                            )}
                            {onConfirmLogin && (
                              account.status === "MANUAL_REVIEW" ||
                              account.status === "VERIFICATION_REQUIRED" ||
                              account.status === "LOGIN_REQUIRED"
                            ) && (
                              <ConfirmButton
                                className="button small"
                                style={{ background: 'var(--warm, #d97706)' }}
                                confirmLabel="确定？"
                                loadingLabel="确认中..."
                                title="运维人工在 AdsPower 中登录后点此确认，系统会重置账号状态并重试待处理任务"
                                onConfirm={() => onConfirmLogin!(account.id)}
                              >
                                确认已登录
                              </ConfirmButton>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                   ))}
                {/* Pagination */}
                {totalPages > 1 && (
                  <tr>
                    <td colSpan={canManage ? 6 : 5}>
                      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '8px 0', flexWrap: 'wrap' }}>
                        <button className="button secondary small" disabled={currentPage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} type="button" style={{ minWidth: 60 }}>← 上页</button>
                        {(() => {
                          const pages: (number | string)[] = [];
                          const delta = 2;
                          for (let i = 1; i <= totalPages; i++) {
                            if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
                              pages.push(i);
                            } else if (pages.length > 0 && pages[pages.length - 1] !== '...') {
                              pages.push('...');
                            }
                          }
                          return pages.map((p, idx) =>
                            p === '...' ? (
                              <span key={`ellipsis-${idx}`} style={{ padding: '0 4px', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.85rem' }}>…</span>
                            ) : (
                              <button
                                key={p}
                                className={`button small ${p === currentPage ? '' : 'secondary'}`}
                                onClick={() => setCurrentPage(p as number)}
                                type="button"
                                style={{ minWidth: 32, padding: '4px 8px', fontWeight: p === currentPage ? 700 : 400 }}
                              >
                                {p}
                              </button>
                            )
                          );
                        })()}
                        <button className="button secondary small" disabled={currentPage >= totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} type="button" style={{ minWidth: 60 }}>下页 →</button>
                      </div>
                    </td>
                  </tr>
                )}
                </>) : (
                  <tr>
                    <td colSpan={canManage ? 6 : 5}>
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
