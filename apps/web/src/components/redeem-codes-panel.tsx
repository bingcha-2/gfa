"use client";

import { useState } from "react";

import { formatDateTime } from "../lib/format";
import { canManageCodes } from "../lib/permissions";
import { RedeemCodeSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type CodeTypeFilter = "ALL" | "JOIN_GROUP" | "ACCOUNT_SWAP";

type RedeemCodesPanelProps = {
  codes: RedeemCodeSummary[];
  role?: string;
  onCreate: (payload: {
    count: number;
    product: string;
    codeType: "JOIN_GROUP" | "ACCOUNT_SWAP";
  }) => Promise<string[] | null>;
  onDisable: (codeId: string) => Promise<boolean>;
};

/** Download a string as a file */
function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function RedeemCodesPanel({
  codes,
  role,
  onCreate,
  onDisable
}: RedeemCodesPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canManage = canManageCodes(role);
  const [activeTab, setActiveTab] = useState<"inventory" | "create">("inventory");
  const [typeFilter, setTypeFilter] = useState<CodeTypeFilter>("ALL");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [form, setForm] = useState({
    count: "10",
    product: "GOOGLE_ONE",
    codeType: "JOIN_GROUP" as "JOIN_GROUP" | "ACCOUNT_SWAP"
  });

  // Filtered codes based on type tab
  const filteredCodes =
    typeFilter === "ALL" ? codes : codes.filter((c) => c.codeType === typeFilter);

  const unusedFiltered = filteredCodes.filter((c) => c.status === "UNUSED");

  function showCopyFeedback(msg: string) {
    setCopyFeedback(msg);
    setTimeout(() => setCopyFeedback(null), 2000);
  }

  async function copyText(text: string, msg = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      showCopyFeedback(msg);
    } catch {
      showCopyFeedback("复制失败，请手动选中");
    }
  }

  function handleCopyAll() {
    if (!unusedFiltered.length) return;
    void copyText(unusedFiltered.map((c) => c.code).join("\n"), `已复制 ${unusedFiltered.length} 条卡密`);
  }

  function handleExportCsv() {
    const header = "code,type,status,product,order_no,user_email,created_at";
    const rows = filteredCodes.map((c) =>
      [
        c.code,
        c.codeType,
        c.status,
        c.product,
        c.order?.orderNo ?? "",
        c.order?.userEmail ?? "",
        c.createdAt
      ].join(",")
    );
    const label = typeFilter === "ALL" ? "all" : typeFilter.toLowerCase();
    downloadText(`codes-${label}-${Date.now()}.csv`, [header, ...rows].join("\n"));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    setIsSubmitting(true);
    setValidationError(null);
    setNewCodes(null);
    try {
      const result = await onCreate({
        count: Number(form.count),
        product: form.product,
        codeType: form.codeType
      });
      if (result) {
        setNewCodes(result);
        setForm({
          count: "10",
          product: form.product || "GOOGLE_ONE",
          codeType: form.codeType
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const typeTabLabels: { key: CodeTypeFilter; label: string }[] = [
    { key: "ALL", label: "全部" },
    { key: "JOIN_GROUP", label: "进组" },
    { key: "ACCOUNT_SWAP", label: "换号" }
  ];

  return (
    <section id="codes" className="glass-panel">
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">卡密列表</p>
            <h2 className="panel-title">卡密库存</h2>
            <p className="muted">批量生成、状态查看和手动禁用都放在一个区块里。</p>
          </div>
        </div>

        {/* Copy feedback toast */}
        {copyFeedback && (
          <div className="notice success" style={{ marginBottom: 0 }}>
            ✅ {copyFeedback}
          </div>
        )}

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "inventory" ? " active" : ""}`}
            onClick={() => { setActiveTab("inventory"); setNewCodes(null); }}
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
            <div className="panel-stack">
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
                    onChange={(event) => {
                      setValidationError(null);
                      setNewCodes(null);
                      setForm((current) => ({
                        ...current,
                        count: event.target.value
                      }));
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="code-product">产品标识</label>
                  <input
                    id="code-product"
                    required
                    value={form.product}
                    onChange={(event) => {
                      setValidationError(null);
                      setNewCodes(null);
                      setForm((current) => ({
                        ...current,
                        product: event.target.value.trim()
                      }));
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="code-codeType">卡密类型</label>
                  <select
                    id="code-codeType"
                    value={form.codeType}
                    onChange={(event) => {
                      setNewCodes(null);
                      setForm((current) => ({
                        ...current,
                        codeType: event.target.value as "JOIN_GROUP" | "ACCOUNT_SWAP"
                      }));
                    }}
                  >
                    <option value="JOIN_GROUP">进组卡密（JOIN_GROUP）</option>
                    <option value="ACCOUNT_SWAP">换号卡密（ACCOUNT_SWAP）</option>
                  </select>
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

              {/* Result block after generation */}
              {newCodes && newCodes.length > 0 && (
                <div className="form-card panel-stack">
                  <div className="split-head">
                    <div>
                      <p className="label">生成结果</p>
                      <h3 className="panel-title" style={{ fontSize: "1rem" }}>
                        已生成 {newCodes.length} 条
                        {form.codeType === "ACCOUNT_SWAP" ? "换号" : "进组"}卡密
                      </h3>
                    </div>
                    <button
                      className="button"
                      type="button"
                      onClick={() => void copyText(newCodes.join("\n"), `已复制 ${newCodes.length} 条卡密`)}
                    >
                      一键全部复制
                    </button>
                  </div>
                  <div
                    style={{
                      background: "var(--surface-1, rgba(0,0,0,0.2))",
                      borderRadius: "0.5rem",
                      padding: "0.75rem 1rem",
                      fontFamily: "monospace",
                      fontSize: "0.875rem",
                      lineHeight: 1.8,
                      userSelect: "all",
                      maxHeight: "260px",
                      overflowY: "auto"
                    }}
                  >
                    {newCodes.map((c) => (
                      <div key={c}>{c}</div>
                    ))}
                  </div>
                  <p className="muted" style={{ fontSize: "0.8rem" }}>
                    可直接框选全部文字复制，或点击「一键全部复制」。卡密已写入数据库，可在库存 Tab 查看。
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">只读模式</p>
                <h3 className="panel-title">当前角色只能查看卡密库存</h3>
              </div>
              <p className="muted">
                卡密生成和禁用只对 `ADMIN` 与 `OPERATIONS` 开放，支持角色默认只读。
              </p>
            </div>
          )
        ) : (
          <div className="panel-stack">
            {/* Type filter tabs + action buttons */}
            <div className="split-head" style={{ alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
              <div className="panel-tabs" style={{ marginTop: 0 }}>
                {typeTabLabels.map(({ key, label }) => (
                  <button
                    key={key}
                    className={`panel-tab${typeFilter === key ? " active" : ""}${key === "JOIN_GROUP" ? " tab-sky" : key === "ACCOUNT_SWAP" ? " tab-orange" : ""}`}
                    onClick={() => setTypeFilter(key)}
                    type="button"
                  >
                    {label}
                    <span className="muted" style={{ marginLeft: "0.35em", fontSize: "0.8em" }}>
                      ({key === "ALL" ? codes.length : codes.filter((c) => c.codeType === key).length})
                    </span>
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", gap: "0.5rem", marginLeft: "auto" }}>
                <button
                  className="button secondary small"
                  disabled={!unusedFiltered.length}
                  onClick={handleCopyAll}
                  title={`复制 ${unusedFiltered.length} 条可用卡密`}
                  type="button"
                >
                  复制全部可用 ({unusedFiltered.length})
                </button>
                <button
                  className="button secondary small"
                  disabled={!filteredCodes.length}
                  onClick={handleExportCsv}
                  title="导出当前视图为 CSV"
                  type="button"
                >
                  导出 CSV
                </button>
              </div>
            </div>

            <div className="table-wrap workspace-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>卡密</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>产品</th>
                    <th>订单</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCodes.length ? (
                    filteredCodes.map((code) => (
                      <tr key={code.id}>
                        <td>
                          <div
                            className="strong mono"
                            title="点击复制"
                            style={{ cursor: "pointer" }}
                            onClick={() => void copyText(code.code, "卡密已复制")}
                          >
                            {code.code}
                          </div>
                          <div className="muted">created {formatDateTime(code.createdAt)}</div>
                        </td>
                        <td>
                          <span className={`badge ${code.codeType === "ACCOUNT_SWAP" ? "badge-orange" : "badge-sky"}`}>
                            {code.codeType === "ACCOUNT_SWAP" ? "换号" : "进组"}
                          </span>
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
                      <td colSpan={6}>
                        <div className="empty-state">
                          {typeFilter === "ALL" ? "还没有卡密库存。" : `没有${typeFilter === "JOIN_GROUP" ? "进组" : "换号"}类型的卡密。`}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
