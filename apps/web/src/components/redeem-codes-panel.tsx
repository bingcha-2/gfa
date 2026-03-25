"use client";

import { useState } from "react";

import { formatDateTime } from "../lib/format";
import { canManageCodes } from "../lib/permissions";
import { RedeemCodeSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type RedeemCodesPanelProps = {
  codes: RedeemCodeSummary[];
  role?: string;
  onCreate: (payload: {
    count: number;
    product: string;
  }) => Promise<boolean>;
  onDisable: (codeId: string) => Promise<boolean>;
};

export function RedeemCodesPanel({
  codes,
  role,
  onCreate,
  onDisable
}: RedeemCodesPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canManage = canManageCodes(role);
  const [activeTab, setActiveTab] = useState<"inventory" | "create">("inventory");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [form, setForm] = useState({
    count: "10",
    product: "GOOGLE_ONE"
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canManage) {
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);

    try {
      const created = await onCreate({
        count: Number(form.count),
        product: form.product
      });

      if (created) {
        setForm({
          count: "10",
          product: form.product || "GOOGLE_ONE"
        });
        setActiveTab("inventory");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section id="codes" className="glass-panel">
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">Redeem Codes</p>
            <h2 className="panel-title">卡密库存</h2>
            <p className="muted">批量生成、状态查看和手动禁用都放在一个区块里。</p>
          </div>
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "inventory" ? " active" : ""}`}
            onClick={() => setActiveTab("inventory")}
            type="button"
          >
            卡密库存
          </button>
          <button
            className={`panel-tab${activeTab === "create" ? " active" : ""}`}
            onClick={() => setActiveTab("create")}
            type="button"
          >
            批量生成
          </button>
        </div>

        {activeTab === "create" ? (
          canManage ? (
            <form className="form-card field-grid workspace-form" onSubmit={submit}>
              <div className="field">
                <label htmlFor="code-count">生成数量</label>
                <input
                  id="code-count"
                  max="100"
                  min="1"
                  required
                  type="number"
                  value={form.count}
                  onChange={(event) =>
                    {
                      setValidationError(null);
                      setForm((current) => ({
                        ...current,
                        count: event.target.value
                      }));
                    }
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="code-product">产品标识</label>
                <input
                  id="code-product"
                  required
                  value={form.product}
                  onChange={(event) =>
                    {
                      setValidationError(null);
                      setForm((current) => ({
                        ...current,
                        product: event.target.value.trim()
                      }));
                    }
                  }
                />
              </div>
              <div className="field field-span-2">
                <p className="muted">
                  新生成的卡密默认不带过期时间。只有用户提交卡密、订单真正完成后，才会记录实际生效时间。
                </p>
              </div>
              <button className="button" disabled={isSubmitting} type="submit">
                {isSubmitting ? "生成中..." : "批量生成卡密"}
              </button>
              {validationError ? <div className="notice error">{validationError}</div> : null}
            </form>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">Read Only</p>
                <h3 className="panel-title">当前角色只能查看卡密库存</h3>
              </div>
              <p className="muted">
                卡密生成和禁用只对 `ADMIN` 与 `OPERATIONS` 开放，支持角色默认只读。
              </p>
            </div>
          )
        ) : (
          <div className="table-wrap workspace-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>卡密</th>
                  <th>状态</th>
                  <th>产品</th>
                  <th>订单</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {codes.length ? (
                  codes.map((code) => (
                    <tr key={code.id}>
                      <td>
                        <div className="strong mono">{code.code}</div>
                        <div className="muted">created {formatDateTime(code.createdAt)}</div>
                      </td>
                      <td>
                        <StatusBadge value={code.status} />
                      </td>
                      <td>
                        <div>{code.product}</div>
                        <div className="muted">
                          {code.usedAt
                            ? `used ${formatDateTime(code.usedAt)}`
                            : code.status === "RESERVED"
                              ? "已占用，等待订单完成"
                              : "未使用，未开始计时"}
                        </div>
                      </td>
                      <td>
                        <div>{code.order?.orderNo ?? "-"}</div>
                        <div className="muted">{code.order?.userEmail ?? "Not redeemed"}</div>
                      </td>
                      <td>
                        {canManage ? (
                          <button
                            className="button secondary small"
                            onClick={() => void onDisable(code.id)}
                            type="button"
                          >
                            禁用
                          </button>
                        ) : (
                          <span className="muted">只读</span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">还没有卡密库存。</div>
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
