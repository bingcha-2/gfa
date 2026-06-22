"use client";

// 激活码管理(console / activation-codes)—— 选套餐(selection)+ 数量批量生成激活码;
// 列表查看状态/激活时间/激活客户/批次,可停用未激活的码、导出整批为 txt。
// 生成不碰账号池(不占座位);座位在用户激活那一刻才分配。后端见 ActivationCodeService。

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  computePurchase,
  type CatalogConfig,
  type Selection,
} from "@/lib/account/catalog-pricing";

const SEAT_OPTIONS = [1, 2, 4, 8] as const;

type Line = "bind" | "pool";

type CodeRow = {
  id: string;
  code: string;
  status: "UNUSED" | "ACTIVATED" | "DISABLED";
  name: string | null;
  batchId: string | null;
  activatedAt: string | null;
  activatedByEmail: string | null;
  subscriptionId: string | null;
  createdAt: string;
};

const STATUS_LABEL: Record<CodeRow["status"], string> = {
  UNUSED: "未激活",
  ACTIVATED: "已激活",
  DISABLED: "已停用",
};

export default function ActivationCodesPage() {
  const [catalog, setCatalog] = useState<CatalogConfig | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);

  // ── 生成表单状态 ──
  const [line, setLine] = useState<Line>("bind");
  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const [shareSeats, setShareSeats] = useState<number>(1);
  const [poolProducts, setPoolProducts] = useState<string[]>([]);
  const [usageTier, setUsageTier] = useState<string>("");
  const [deviceLimit, setDeviceLimit] = useState<number>(1);
  const [count, setCount] = useState<number>(1);
  const [name, setName] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [lastGenerated, setLastGenerated] = useState<{ codes: string[]; batchId: string } | null>(null);

  // ── 列表状态 ──
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"" | CodeRow["status"]>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loadingList, setLoadingList] = useState(false);
  const pageSize = 20;

  useEffect(() => {
    fetch("/api/plan-catalog", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { config: CatalogConfig | null }) => {
        if (d.config) setCatalog(d.config);
        else setCatalogErr("套餐目录未发布,无法生成激活码。");
      })
      .catch((e) => setCatalogErr(getErrorMessage(e)));
  }, []);

  const shareCapacity = catalog?.shareCapacity ?? 8;
  const seatOptions = useMemo(() => SEAT_OPTIONS.filter((n) => n <= shareCapacity), [shareCapacity]);
  const tierNames = useMemo(() => Object.keys(catalog?.usageTiers ?? {}), [catalog]);

  // selection 与「新建订阅」同结构(PoolSelection | BindSelection)。
  const selection: Selection | null = useMemo(() => {
    if (line === "bind") {
      const items = Object.entries(bindLevels).map(([product, level]) => ({ product, level }));
      if (items.length === 0) return null;
      return { line: "bind", items, shareSeats, deviceLimit };
    }
    if (poolProducts.length === 0 || !usageTier) return null;
    return { line: "pool", products: poolProducts, usageTier, deviceLimit };
  }, [line, bindLevels, shareSeats, poolProducts, usageTier, deviceLimit]);

  // 价格预览(与激活时一致:对当前目录 computePurchase)。
  const priceCents = useMemo(() => {
    if (!catalog || !selection) return null;
    try {
      return computePurchase(catalog, selection).priceCents;
    } catch {
      return null;
    }
  }, [catalog, selection]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await apiRequest<{ items: CodeRow[]; total: number }>("activation-codes", {
        search: {
          status: statusFilter || undefined,
          search: search.trim() || undefined,
          page,
          pageSize,
        },
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setGenErr(getErrorMessage(e));
    } finally {
      setLoadingList(false);
    }
  }, [statusFilter, search, page]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  function toggleBindProduct(product: string) {
    setBindLevels((prev) => {
      if (product in prev) {
        const next = { ...prev };
        delete next[product];
        return next;
      }
      const firstLevel = catalog?.levels[product]?.[0];
      if (!firstLevel) return prev;
      return { ...prev, [product]: firstLevel };
    });
  }

  function togglePoolProduct(product: string) {
    setPoolProducts((prev) => (prev.includes(product) ? prev.filter((p) => p !== product) : [...prev, product]));
  }

  async function handleGenerate() {
    if (!selection || generating) return;
    setGenerating(true);
    setGenErr(null);
    setLastGenerated(null);
    try {
      const res = await apiRequest<{ count: number; batchId: string; codes: string[] }>("activation-codes", {
        method: "POST",
        body: { selection, count, name: name.trim() || undefined },
      });
      setLastGenerated({ codes: res.codes, batchId: res.batchId });
      await loadList();
    } catch (e) {
      setGenErr(getErrorMessage(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDisable(id: string) {
    try {
      await apiRequest(`activation-codes/${id}/disable`, { method: "POST" });
      await loadList();
    } catch (e) {
      setGenErr(getErrorMessage(e));
    }
  }

  async function handleExport() {
    try {
      const res = await apiRequest<{ codes: string[] }>("activation-codes/export", {
        search: { status: statusFilter || undefined, search: search.trim() || undefined },
      });
      const blob = new Blob([res.codes.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `activation-codes-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setGenErr(getErrorMessage(e));
    }
  }

  function downloadGenerated() {
    if (!lastGenerated) return;
    const blob = new Blob([lastGenerated.codes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `activation-codes-${lastGenerated.batchId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="ac-page" style={{ display: "flex", flexDirection: "column", gap: 24, padding: 24 }}>
      <header>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>激活码管理</h1>
        <p style={{ color: "var(--muted-foreground, #888)", fontSize: 13, marginTop: 4 }}>
          选套餐 + 数量批量生成激活码。生成时不绑定账号、不占座位;用户在账户后台兑换时才开通订阅并分配账号。
        </p>
      </header>

      {/* ── 生成 ── */}
      <section style={{ border: "1px solid var(--border, #e5e5e5)", borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>生成激活码</h2>
        {catalogErr && <p style={{ color: "#dc2626", fontSize: 13 }}>{catalogErr}</p>}
        {!catalog && !catalogErr && <p style={{ fontSize: 13, color: "#888" }}>加载套餐目录…</p>}

        {catalog && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {(["bind", "pool"] as Line[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLine(l)}
                  style={pill(line === l)}
                >
                  {l === "bind" ? "绑定线" : "号池线"}
                </button>
              ))}
            </div>

            {line === "bind" ? (
              <>
                <Field label="产品 + 会员等级">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {(catalog.products ?? []).map((product) => {
                      const checked = product in bindLevels;
                      return (
                        <div key={product} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 120 }}>
                            <input type="checkbox" checked={checked} onChange={() => toggleBindProduct(product)} />
                            {product}
                          </label>
                          {checked && (
                            <select
                              value={bindLevels[product]}
                              onChange={(e) => setBindLevels((p) => ({ ...p, [product]: e.target.value }))}
                            >
                              {(catalog.levels[product] ?? []).map((lvl) => (
                                <option key={lvl} value={lvl}>{lvl}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Field>
                <Field label={`份额(1=拼车 … ${shareCapacity}=独享)`}>
                  <select value={shareSeats} onChange={(e) => setShareSeats(Number(e.target.value))}>
                    {seatOptions.map((n) => (
                      <option key={n} value={n}>{n} 份</option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="产品">
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {(catalog.products ?? []).map((product) => (
                      <label key={product} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={poolProducts.includes(product)}
                          onChange={() => togglePoolProduct(product)}
                        />
                        {product}
                      </label>
                    ))}
                  </div>
                </Field>
                <Field label="用量档">
                  <select value={usageTier} onChange={(e) => setUsageTier(e.target.value)}>
                    <option value="">选择用量档</option>
                    {tierNames.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <Field label="设备数">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={deviceLimit}
                  onChange={(e) => setDeviceLimit(Math.max(1, Number(e.target.value) || 1))}
                  style={{ width: 80 }}
                />
              </Field>
              <Field label="数量(1–200)">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                  style={{ width: 80 }}
                />
              </Field>
              <Field label="备注(可选)">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如:618活动" />
              </Field>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!selection || generating}
                style={primaryBtn(!selection || generating)}
              >
                {generating ? "生成中…" : `生成 ${count} 个`}
              </button>
              {priceCents != null && (
                <span style={{ fontSize: 13, color: "#888" }}>
                  单个等值价格:¥{(priceCents / 100).toFixed(2)}
                </span>
              )}
            </div>
            {genErr && <p style={{ color: "#dc2626", fontSize: 13 }}>{genErr}</p>}

            {lastGenerated && (
              <div style={{ border: "1px solid var(--border, #e5e5e5)", borderRadius: 8, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>
                    已生成 {lastGenerated.codes.length} 个(批次 {lastGenerated.batchId})
                  </strong>
                  <button type="button" onClick={downloadGenerated} style={ghostBtn()}>下载 .txt</button>
                </div>
                <textarea
                  readOnly
                  value={lastGenerated.codes.join("\n")}
                  rows={Math.min(8, lastGenerated.codes.length)}
                  style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── 列表 ── */}
      <section style={{ border: "1px solid var(--border, #e5e5e5)", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginRight: "auto" }}>激活码列表</h2>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as any); setPage(1); }}>
            <option value="">全部状态</option>
            <option value="UNUSED">未激活</option>
            <option value="ACTIVATED">已激活</option>
            <option value="DISABLED">已停用</option>
          </select>
          <input
            placeholder="搜索激活码"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <button type="button" onClick={handleExport} style={ghostBtn()}>导出当前筛选</button>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#888" }}>
              <th style={th}>激活码</th>
              <th style={th}>状态</th>
              <th style={th}>激活客户</th>
              <th style={th}>激活时间</th>
              <th style={th}>批次</th>
              <th style={th}>备注</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                <td style={{ ...td, fontFamily: "monospace" }}>{r.code}</td>
                <td style={td}>{STATUS_LABEL[r.status]}</td>
                <td style={td}>{r.activatedByEmail ?? "—"}</td>
                <td style={td}>{r.activatedAt ? new Date(r.activatedAt).toLocaleString() : "—"}</td>
                <td style={td}>{r.batchId ?? "—"}</td>
                <td style={td}>{r.name ?? "—"}</td>
                <td style={td}>
                  {r.status === "UNUSED" ? (
                    <button type="button" onClick={() => handleDisable(r.id)} style={ghostBtn()}>停用</button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loadingList && (
              <tr><td style={td} colSpan={7}>暂无激活码</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 13 }}>
          <span style={{ color: "#888" }}>共 {total} 个</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={ghostBtn(page <= 1)}>上一页</button>
            <span>{page} / {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={ghostBtn(page >= totalPages)}>下一页</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span style={{ color: "#888" }}>{label}</span>
      {children}
    </label>
  );
}

const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 500 };
const td: React.CSSProperties = { padding: "8px 10px" };

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 999,
    border: "1px solid var(--border, #ddd)",
    background: active ? "var(--primary, #2563eb)" : "transparent",
    color: active ? "#fff" : "inherit",
    cursor: "pointer",
  };
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 18px",
    borderRadius: 8,
    border: "none",
    background: disabled ? "#9ca3af" : "var(--primary, #2563eb)",
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function ghostBtn(disabled = false): React.CSSProperties {
  return {
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid var(--border, #ddd)",
    background: "transparent",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontSize: 13,
  };
}
