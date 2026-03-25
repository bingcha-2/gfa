"use client";

import { useState } from "react";

import { formatDateTime } from "../lib/format";
import { canCreateAccount } from "../lib/permissions";
import { AccountSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type AccountPanelProps = {
  accounts: AccountSummary[];
  role?: string;
  onCreate: (payload: {
    name: string;
    loginEmail: string;
    adspowerProfileId: string;
    loginPassword?: string;
    totpSecret?: string;
    notes?: string;
  }) => Promise<boolean>;
};

export function AccountPanel({ accounts, onCreate, role }: AccountPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canManage = canCreateAccount(role);
  const [activeTab, setActiveTab] = useState<"list" | "create">("list");
  const [form, setForm] = useState({
    name: "",
    loginEmail: "",
    adspowerProfileId: "",
    loginPassword: "",
    totpSecret: "",
    notes: ""
  });

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

  return (
    <section id="accounts" className="glass-panel account-panel">
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">Accounts</p>
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
        </div>

        {activeTab === "create" ? (
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
                    type="password"
                    placeholder="Google 账号密码（用于移除成员验证）"
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
                <p className="label">Read Only</p>
                <h3 className="panel-title">当前角色没有新增母号权限</h3>
              </div>
              <p className="muted">
                母号创建只对 `ADMIN` 开放。当前账号可以查看母号状态，但不能新增或修改。
              </p>
            </div>
          )
        ) : (
          <div className="table-wrap table-wrap-accounts workspace-table-wrap">
            <table className="data-table data-table-accounts">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>登录邮箱</th>
                  <th>状态</th>
                  <th>凭据</th>
                  <th>风险</th>
                  <th>统计</th>
                </tr>
              </thead>
              <tbody>
                {accounts.length ? (
                  accounts.map((account) => (
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
                        <div className="badge-cell">
                          <StatusBadge value={account.status} />
                        </div>
                      </td>
                      <td>
                        <div className="badge-cell">
                          <StatusBadge
                            value={account.hasTotpSecret ? "TOTP" : "No TOTP"}
                            tone={account.hasTotpSecret ? "emerald" : "amber"}
                          />
                        </div>
                      </td>
                      <td>
                        <div className="account-risk">{account.riskScore}</div>
                      </td>
                      <td>
                        <div className="account-stats">
                          <div>{account._count?.familyGroups ?? 0} groups</div>
                          <div className="muted account-meta">
                            {account._count?.tasks ?? 0} tasks
                          </div>
                          <div className="muted account-meta">
                            last login {formatDateTime(account.lastLoginAt)}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">还没有录入任何母号。</div>
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
