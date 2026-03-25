"use client";

import { useEffect, useState } from "react";

import { canCreateGroup } from "../lib/permissions";
import { AccountSummary, FamilyGroupSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type GroupPanelProps = {
  accounts: AccountSummary[];
  groups: FamilyGroupSummary[];
  role?: string;
  onCreate: (payload: {
    accountId: string;
    groupName: string;
    maxMembers: number;
  }) => Promise<boolean>;
  onSync: (groupId: string) => Promise<boolean>;
};

export function GroupPanel({
  accounts,
  groups,
  role,
  onCreate,
  onSync
}: GroupPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canManage = canCreateGroup(role);
  const [activeTab, setActiveTab] = useState<"inventory" | "create">("inventory");
  const [form, setForm] = useState({
    accountId: accounts[0]?.id ?? "",
    groupName: "",
    maxMembers: "6"
  });

  useEffect(() => {
    if (!form.accountId && accounts[0]?.id) {
      setForm((current) => ({
        ...current,
        accountId: accounts[0]?.id ?? ""
      }));
    }
  }, [accounts, form.accountId]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canManage || !form.accountId) {
      return;
    }

    setIsSubmitting(true);

    try {
      const success = await onCreate({
        accountId: form.accountId,
        groupName: form.groupName,
        maxMembers: Number(form.maxMembers)
      });

      if (success) {
        setForm((current) => ({
          ...current,
          groupName: "",
          maxMembers: "6"
        }));
        setActiveTab("inventory");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section id="groups" className="glass-panel">
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">Family Groups</p>
            <h2 className="panel-title">家庭组库存</h2>
            <p className="muted">保留可用空位、待邀请数、组状态和同步入口。</p>
          </div>
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "inventory" ? " active" : ""}`}
            onClick={() => setActiveTab("inventory")}
            type="button"
          >
            库存列表
          </button>
          <button
            className={`panel-tab${activeTab === "create" ? " active" : ""}`}
            onClick={() => setActiveTab("create")}
            type="button"
          >
            新增家庭组
          </button>
        </div>

        {activeTab === "create" ? (
          canManage ? (
            <form className="form-card field-grid workspace-form" onSubmit={submit}>
              <div className="field">
                <label htmlFor="group-account">归属母号</label>
                <select
                  disabled={!accounts.length}
                  id="group-account"
                  required
                  value={form.accountId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      accountId: event.target.value
                    }))
                  }
                >
                  {accounts.length ? null : <option value="">请先创建母号</option>}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="group-name">家庭组名称</label>
                <input
                  id="group-name"
                  required
                  value={form.groupName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      groupName: event.target.value
                    }))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="group-max">最大成员数</label>
                <input
                  id="group-max"
                  min="1"
                  required
                  type="number"
                  value={form.maxMembers}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      maxMembers: event.target.value
                    }))
                  }
                />
              </div>
              {!accounts.length ? (
                <div className="notice warn">创建家庭组前，必须先在左侧建立至少一个母号。</div>
              ) : null}
              <button
                className="button"
                disabled={isSubmitting || !accounts.length}
                type="submit"
              >
                {isSubmitting ? "创建中..." : "新增家庭组"}
              </button>
            </form>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">Read Only</p>
                <h3 className="panel-title">当前角色没有新增家庭组权限</h3>
              </div>
              <p className="muted">
                家庭组创建只对 `ADMIN` 开放。同步入口仍然保留，方便支持和运营查看库存后手动刷新状态。
              </p>
            </div>
          )
        ) : (
          <div className="table-wrap workspace-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>家庭组</th>
                  <th>库存</th>
                  <th>状态</th>
                  <th>母号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {groups.length ? (
                  groups.map((group) => (
                    <tr key={group.id}>
                      <td>
                        <div className="strong">{group.groupName}</div>
                        <div className="muted">
                          {group._count?.members ?? group.memberCount} members ·{" "}
                          {group._count?.invites ?? group.pendingInviteCount} invites
                        </div>
                      </td>
                      <td>
                        <div>{group.availableSlots} slots left</div>
                        <div className="muted">risk {group.riskScore}</div>
                      </td>
                      <td>
                        <StatusBadge value={group.status} />
                      </td>
                      <td>{group.account?.name ?? "-"}</td>
                      <td>
                        <button
                          className="button secondary small"
                          onClick={() => void onSync(group.id)}
                          type="button"
                        >
                          触发同步
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">还没有家庭组库存。</div>
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
