"use client";

import React from "react";
import type { AccountSummary } from "../lib/types";

type CreateTabProps = {
  accounts: AccountSummary[];
  isSubmitting: boolean;
  form: { accountId: string; groupName: string; maxMembers: string };
  setForm: React.Dispatch<React.SetStateAction<{ accountId: string; groupName: string; maxMembers: string }>>;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  canManage: boolean;
};

export function CreateTab({
  accounts,
  isSubmitting,
  form,
  setForm,
  onSubmit,
  canManage
}: CreateTabProps) {
  if (!canManage) {
    return (
      <div className="form-card panel-stack workspace-empty">
        <div>
          <p className="label">只读模式</p>
          <h3 className="panel-title">当前角色没有新增家庭组权限</h3>
        </div>
        <p className="muted">
          家庭组创建只对 ADMIN 开放。同步入口仍然保留，方便支持和运营查看库存后手动刷新状态。
        </p>
      </div>
    );
  }

  return (
    <form className="form-card field-grid workspace-form" onSubmit={onSubmit}>
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
  );
}
