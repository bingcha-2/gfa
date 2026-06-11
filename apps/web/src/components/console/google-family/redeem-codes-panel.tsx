"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";

import { formatDateTime } from "@/lib/format";
import { canManageCodes } from "@/lib/console/permissions";
import { RedeemCodeSummary } from "@/lib/console/types";
import { ConfirmButton } from "./confirm-button";
import { StatusBadge } from "./status-badge";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CodeTypeFilter = "ALL" | "JOIN_GROUP" | "ACCOUNT_SWAP" | "SUBSCRIPTION";

const PAGE_SIZE = 30;

type RedeemCodesPanelProps = {
  role?: string;
  // onCreate, onDisable, onDelete no longer needed as they are handled internally
};

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function RedeemCodesPanel({ role }: RedeemCodesPanelProps) {
  const [activeTab, setActiveTab] = useState<"inventory" | "create">("inventory");
  const [typeFilter, setTypeFilter] = useState<CodeTypeFilter>("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canManage = canManageCodes(role);

  // Server state
  const [codes, setCodes] = useState<RedeemCodeSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [stats, setStats] = useState({ unused: 0, types: { ALL: 0, JOIN_GROUP: 0, ACCOUNT_SWAP: 0, SUBSCRIPTION: 0 } });
  const [isLoading, setIsLoading] = useState(true);

  // Form state map
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [form, setForm] = useState({
    count: "10",
    product: "GOOGLE_ONE",
    codeType: "JOIN_GROUP" as "JOIN_GROUP" | "ACCOUNT_SWAP" | "SUBSCRIPTION",
    validDays: "30",
    swapLimit: "2",
    swapWindowHours: "5"
  });

  async function loadData() {
    setIsLoading(true);
    try {
      let url = `redeem-codes?page=${currentPage}&pageSize=${PAGE_SIZE}${typeFilter !== "ALL" ? `&codeType=${typeFilter}` : ""}`;
      if (searchTerm) {
        url += `&search=${encodeURIComponent(searchTerm)}`;
      }
      const res = await apiRequest<{ items: RedeemCodeSummary[], total: number, stats: any }>(url);
      setCodes(res.items);
      setTotalItems(res.total);
      if (res.stats) setStats(res.stats);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(value.trim());
      setCurrentPage(1);
    }, 400);
  }

  function clearSearch() {
    setSearchInput("");
    setSearchTerm("");
    setCurrentPage(1);
  }

  useEffect(() => {
    if (activeTab === "inventory") {
      loadData();
    }
  }, [currentPage, typeFilter, activeTab, searchTerm]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

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

  async function onCreate(payload: any) {
    setIsSubmitting(true);
    setValidationError(null);
    setNewCodes(null);
    try {
      const created = await apiRequest<RedeemCodeSummary[]>("redeem-codes/batch-create", {
        method: "POST",
        body: payload
      });
      const generatedCodes = created.map((c) => c.code);
      setNewCodes(generatedCodes);
      setForm((current) => ({
        ...current,
        count: "10",
        product: current.product || "GOOGLE_ONE"
      }));
    } catch (err) {
      setValidationError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onDisable(codeId: string) {
    try {
      await apiRequest(`redeem-codes/${codeId}/disable`, { method: "PATCH" });
      setCodes((prev) => prev.map((c) => c.id === codeId ? { ...c, status: "DISABLED" } : c));
    } catch (err) {
      console.error(err);
    }
  }

  async function onDelete(codeId: string) {
    try {
      await apiRequest(`redeem-codes/${codeId}`, { method: "DELETE" });
      setCodes((prev) => prev.filter((c) => c.id !== codeId));
      setTotalItems((prev) => prev - 1);
    } catch (err) {
      console.error(err);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    await onCreate({
      count: Number(form.count),
      product: form.product,
      codeType: form.codeType,
      ...(form.codeType === "SUBSCRIPTION" ? {
        validDays: Number(form.validDays),
        swapLimit: Number(form.swapLimit),
        swapWindowHours: Number(form.swapWindowHours)
      } : {})
    });
  }

  function handleExportCsv() {
    // Note: since it's paginated, exporting all requires an API endpoint. 
    // For now we export the current page.
    const header = "code,type,status,product,order_no,user_email,created_at";
    const rows = codes.map((c) =>
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
    downloadText(`codes-${label}-page${currentPage}-${Date.now()}.csv`, [header, ...rows].join("\n"));
  }

  const typeTabLabels: { key: CodeTypeFilter; label: string }[] = [
    { key: "ALL", label: "全部" },
    { key: "JOIN_GROUP", label: "进组" },
    { key: "ACCOUNT_SWAP", label: "换号" },
    { key: "SUBSCRIPTION", label: "长效" }
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
                  <Input
                    id="code-count"
                    max="100"
                    min="1"
                    required
                    type="number"
                    value={form.count}
                    onChange={(event) => {
                      setValidationError(null);
                      setNewCodes(null);
                      setForm((current) => ({ ...current, count: event.target.value }));
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="code-product">产品标识</label>
                  <Input
                    id="code-product"
                    required
                    value={form.product}
                    onChange={(event) => {
                      setValidationError(null);
                      setNewCodes(null);
                      setForm((current) => ({ ...current, product: event.target.value.trim() }));
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="code-codeType">卡密类型</label>
                  <Select
                    value={form.codeType}
                    onValueChange={(value) => {
                      setNewCodes(null);
                      setForm((current) => ({ ...current, codeType: value as "JOIN_GROUP" | "ACCOUNT_SWAP" | "SUBSCRIPTION" }));
                    }}
                  >
                    <SelectTrigger id="code-codeType" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="JOIN_GROUP">进组卡密（JZ-）</SelectItem>
                      <SelectItem value="ACCOUNT_SWAP">换号卡密（HH-）</SelectItem>
                      <SelectItem value="SUBSCRIPTION">长效换号卡密（CX-）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.codeType === "SUBSCRIPTION" && (
                  <>
                    <div className="field">
                      <label htmlFor="code-validDays">有效天数</label>
                      <Input
                        id="code-validDays"
                        min="1"
                        max="3650"
                        required
                        type="number"
                        value={form.validDays}
                        onChange={(event) => setForm((c) => ({ ...c, validDays: event.target.value }))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="code-swapLimit">窗口内最大替换次数</label>
                      <Input
                        id="code-swapLimit"
                        min="1"
                        max="100"
                        required
                        type="number"
                        value={form.swapLimit}
                        onChange={(event) => setForm((c) => ({ ...c, swapLimit: event.target.value }))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="code-swapWindow">限流窗口（小时）</label>
                      <Input
                        id="code-swapWindow"
                        min="1"
                        max="720"
                        required
                        type="number"
                        value={form.swapWindowHours}
                        onChange={(event) => setForm((c) => ({ ...c, swapWindowHours: event.target.value }))}
                      />
                    </div>
                  </>
                )}

                <div className="field field-span-2">
                  <p className="muted">
                    新生成的卡密默认不带过期时间。只有用户提交卡密、订单真正完成后，才会记录实际生效时间。
                  </p>
                </div>
                <Button disabled={isSubmitting} type="submit">
                  {isSubmitting ? "生成中..." : "批量生成卡密"}
                </Button>
                {validationError ? <div className="notice error">{validationError}</div> : null}
              </form>

              {newCodes && newCodes.length > 0 && (
                <div className="form-card panel-stack">
                  <div className="split-head">
                    <div>
                      <p className="label">生成结果</p>
                      <h3 className="panel-title" style={{ fontSize: "1rem" }}>
                        已生成 {newCodes.length} 条卡密
                      </h3>
                    </div>
                    <Button
                      type="button"
                      onClick={() => void copyText(newCodes.join("\n"), `已复制 ${newCodes.length} 条卡密`)}
                    >
                      一键全部复制
                    </Button>
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
                </div>
              )}
            </div>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">只读模式</p>
                <h3 className="panel-title">当前角色只能查看卡密库存</h3>
              </div>
            </div>
          )
        ) : (
          <div className="panel-stack">
            {/* Search bar */}
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <Input
                  id="code-search"
                  type="text"
                  placeholder="搜索卡密编号、订单号或用户邮箱…"
                  value={searchInput}
                  onChange={(e) => handleSearchInput(e.target.value)}
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    style={{
                      position: "absolute",
                      right: "0.5rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "var(--foreground-muted, #a3a3a3)",
                      cursor: "pointer",
                      fontSize: "1rem",
                      lineHeight: 1,
                      padding: "2px"
                    }}
                    title="清除搜索"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {searchTerm ? (
              <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '2px' }}>
                搜索 "{searchTerm}" · 找到 {totalItems} 条结果
                {totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={clearSearch}
                >
                  清除搜索
                </Button>
              </div>
            ) : (
              <>
                <div className="split-head" style={{ alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
                  <div className="panel-tabs" style={{ marginTop: 0 }}>
                    {typeTabLabels.map(({ key, label }) => (
                      <button
                        key={key}
                        className={`panel-tab${typeFilter === key ? " active" : ""}${key === "JOIN_GROUP" ? " tab-sky" : key === "ACCOUNT_SWAP" ? " tab-green" : key === "SUBSCRIPTION" ? " tab-green" : ""}`}
                        onClick={() => { setTypeFilter(key); setCurrentPage(1); }}
                        type="button"
                      >
                        {label}
                        <span className="muted" style={{ marginLeft: "0.35em", fontSize: "0.8em" }}>
                          ({stats.types[key] ?? 0})
                        </span>
                      </button>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: "0.5rem", marginLeft: "auto" }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadData}
                      disabled={isLoading}
                      type="button"
                    >
                      {isLoading ? '刷新中...' : '刷新这页'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!codes.length}
                      onClick={handleExportCsv}
                      title="导出当前页视图为 CSV"
                      type="button"
                    >
                      导出本页 CSV
                    </Button>
                  </div>
                </div>

                <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '2px' }}>
                  共 {totalItems} 条 · 未使用 {stats.unused} 条
                  {totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}
                </div>
              </>
            )}

            <div className="table-wrap workspace-table-wrap" style={{ minHeight: '300px', position: 'relative' }}>
              {isLoading && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 10 }}>
                  <Spinner />
                </div>
              )}
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
                  {codes.length ? (
                    codes.map((code) => (
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
                          <span className={`badge ${code.codeType === "ACCOUNT_SWAP" ? "badge-green" : code.codeType === "SUBSCRIPTION" ? "badge-green" : "badge-sky"}`}>
                            {code.codeType === "ACCOUNT_SWAP" ? "换号" : code.codeType === "SUBSCRIPTION" ? "长效" : "进组"}
                          </span>
                          {code.codeType === "SUBSCRIPTION" && code.expiresAt && (
                            <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                              {code.validDays}天 | {code.swapLimit ?? 2}次/{code.swapWindowHours ?? 5}h
                            </div>
                          )}
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
                                ? "已占用"
                                : "未使用"}
                          </div>
                        </td>
                        <td>
                          <div>{code.order?.orderNo ?? "-"}</div>
                          <div className="muted">{code.order?.userEmail ?? "-"}</div>
                        </td>
                        <td>
                          {canManage ? (
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              {code.status === "UNUSED" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void onDisable(code.id)}
                                  type="button"
                                >
                                  禁用
                                </Button>
                              )}
                              <ConfirmButton
                                className="button danger small"
                                confirmLabel="确定删除？"
                                loadingLabel="删除中..."
                                onConfirm={() => onDelete(code.id)}
                              >
                                删除
                              </ConfirmButton>
                            </div>
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
                          没有任何数据。
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Server Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '12px 0 4px', flexWrap: 'wrap' }}>
                <Button variant="outline" size="sm" disabled={currentPage <= 1 || isLoading} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} type="button">← 上页</Button>
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
                            <Button
                              key={p}
                              variant={p === currentPage ? "default" : "outline"}
                              size="sm"
                              disabled={isLoading}
                              onClick={() => setCurrentPage(p as number)}
                              type="button"
                              style={{ minWidth: 32 }}
                            >
                              {p}
                            </Button>
                    )
                  );
                })()}
                <Button variant="outline" size="sm" disabled={currentPage >= totalPages || isLoading} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} type="button">下页 →</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
