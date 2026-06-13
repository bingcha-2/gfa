"use client";

// 目录版手动发放订阅弹窗(管理员,bypass 支付)。
//
// 拉当前 PUBLISHED 的套餐目录(GET /api/plan-catalog),让运营按目录 selection 选配:
//   - 号池线:多选产品 + 用量档 + 设备数。
//   - 绑定线:每选中产品各选一个等级 + 共享人数 + 设备数。
// 选配口径与客户购买页(catalog-purchase.tsx)完全一致 —— 同一个 Selection、同一个
// computePurchase 算价(此处只做参考预览,发放免费)。提交 POST
// console/customers/:id/subscriptions { selection },后端用 computePurchase 权威校验
// (未知 tier/level/product / 无发布版 / 无可用座位 → 400),成功返回新订阅。

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  computePurchase,
  type CatalogConfig,
  type Selection,
} from "@/lib/account/catalog-pricing";
import { fmtYuan } from "@/lib/console/format";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Line = "pool" | "bind";

/** 共享人数档(与购买页一致;权重由后端按 capacity/N 推导)。 */
const SHARE_OPTIONS = [1, 2, 4, 8] as const;
const MAX_DEVICES = 20;

/** 产品展示名(与套餐配置 PRODUCT_LABELS 一致;键缺失回退原始 key)。 */
const PRODUCT_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  codex: "Codex",
  antigravity: "Antigravity (Gemini)",
};
const productLabel = (p: string) => PRODUCT_LABELS[p] ?? p;

/** 等级展示名(与购买页 levelNames 一致;键缺失回退原始 key)。 */
const LEVEL_LABELS: Record<string, string> = {
  pro: "Pro",
  "max-5x": "Max 5x",
  "max-20x": "Max 20x",
  plus: "Plus",
  ultra: "Ultra",
};
const levelLabel = (l: string) => LEVEL_LABELS[l] ?? l;
const usageLabel = (k: string) => (k === "small" ? "小用量" : k === "large" ? "大用量" : k);

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    const msg = data?.message ?? data?.error;
    if (Array.isArray(msg)) return msg.join(", ");
    if (typeof msg === "string") return msg;
  } catch {
    /* 非 JSON */
  }
  return fallback;
}

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; catalog: CatalogConfig }
  | { kind: "unavailable" } // 后端在,但无 PUBLISHED 版
  | { kind: "error"; message: string };

export function GrantSubscriptionDialog({
  open,
  onOpenChange,
  customerId,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  /** 发放成功后刷新客户详情(订阅列表)。 */
  onGranted: () => void | Promise<void>;
}) {
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [granting, setGranting] = useState(false);

  // ── 选配状态 ──
  const [line, setLine] = useState<Line>("pool");
  // 号池线
  const [poolProducts, setPoolProducts] = useState<string[]>([]);
  const [usageTier, setUsageTier] = useState<string>("small");
  const [poolDevices, setPoolDevices] = useState(1);
  // 绑定线:product → chosen level(不在表示未选中)。
  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const [shareUsers, setShareUsers] = useState<number>(1);
  const [bindDevices, setBindDevices] = useState(1);

  // 打开时拉目录并重置选配。
  useEffect(() => {
    if (!open) return;
    setState({ kind: "loading" });
    setLine("pool");
    setPoolProducts([]);
    setPoolDevices(1);
    setBindLevels({});
    setShareUsers(1);
    setBindDevices(1);

    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/plan-catalog", { cache: "no-store" });
        if (!res.ok) {
          const message = await readError(res, "加载套餐目录失败");
          if (alive) setState({ kind: "error", message });
          return;
        }
        const data = (await res.json()) as {
          version: number | null;
          config: CatalogConfig | null;
        };
        if (!alive) return;
        if (data.config) {
          setUsageTier(Object.keys(data.config.usageTiers)[0] ?? "small");
          setState({ kind: "ready", catalog: data.config });
        } else {
          setState({ kind: "unavailable" });
        }
      } catch (err) {
        if (alive) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : "加载套餐目录失败",
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  const catalog = state.kind === "ready" ? state.catalog : null;
  const tierKeys = useMemo(
    () => (catalog ? Object.keys(catalog.usageTiers) : []),
    [catalog],
  );

  // 当前选配 → Selection(与购买页同口径)。
  const selection: Selection =
    line === "pool"
      ? { line: "pool", products: poolProducts, usageTier, deviceLimit: poolDevices }
      : {
          line: "bind",
          items: Object.entries(bindLevels).map(([product, level]) => ({ product, level })),
          shareUsers,
          deviceLimit: bindDevices,
        };

  // 参考价(免费发放,仅展示;computePurchase 对空/非法选配抛错 → 视为「未就绪」)。
  const priced = useMemo(() => {
    if (!catalog) return null;
    try {
      const hasProduct =
        selection.line === "pool"
          ? selection.products.length > 0
          : selection.items.length > 0;
      if (!hasProduct) return null;
      return computePurchase(catalog, selection);
    } catch {
      return null;
    }
  }, [catalog, selection]);

  function togglePoolProduct(product: string) {
    setPoolProducts((prev) =>
      prev.includes(product) ? prev.filter((p) => p !== product) : [...prev, product],
    );
  }

  function toggleBindProduct(product: string) {
    if (!catalog) return;
    setBindLevels((prev) => {
      if (product in prev) {
        const next = { ...prev };
        delete next[product];
        return next;
      }
      const firstLevel = catalog.levels[product]?.[0];
      if (!firstLevel) return prev;
      return { ...prev, [product]: firstLevel };
    });
  }

  async function doGrant() {
    if (!priced) {
      toast.error(line === "pool" ? "请至少选择一个产品" : "请为选中的产品各选一个等级");
      return;
    }
    try {
      setGranting(true);
      await apiRequest(`customers/${customerId}/subscriptions`, {
        method: "POST",
        body: { selection },
      });
      toast.success("已发放订阅");
      onOpenChange(false);
      await onGranted();
    } catch (err) {
      // 后端 400 的可读消息(如「暂无可用座位」)直达运营。
      toast.error(getErrorMessage(err));
    } finally {
      setGranting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>手动发放订阅</DialogTitle>
          <DialogDescription>
            按当前发布的套餐目录选配,直接为该客户开通订阅(不走支付)。同产品的旧订阅会被自动取代。
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner /> 加载套餐目录…
          </div>
        )}

        {state.kind === "unavailable" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            尚未发布套餐目录,请先到「套餐配置」发布后再发放。
          </div>
        )}

        {state.kind === "error" && (
          <div className="py-8 text-center text-sm text-destructive">{state.message}</div>
        )}

        {state.kind === "ready" && catalog && (
          <div className="space-y-4 py-2">
            {/* 线选择 */}
            <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="计费线">
              <Button
                type="button"
                variant={line === "pool" ? "default" : "outline"}
                size="sm"
                role="tab"
                aria-selected={line === "pool"}
                onClick={() => setLine("pool")}
              >
                号池线
              </Button>
              <Button
                type="button"
                variant={line === "bind" ? "default" : "outline"}
                size="sm"
                role="tab"
                aria-selected={line === "bind"}
                onClick={() => setLine("bind")}
              >
                绑定线
              </Button>
            </div>

            {/* ── 号池线 ── */}
            {line === "pool" && (
              <div className="space-y-4">
                <div>
                  <Label>产品(可多选)</Label>
                  <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="产品">
                    {catalog.products.map((product) => (
                      <Button
                        key={product}
                        type="button"
                        size="sm"
                        variant={poolProducts.includes(product) ? "default" : "outline"}
                        aria-pressed={poolProducts.includes(product)}
                        onClick={() => togglePoolProduct(product)}
                      >
                        {productLabel(product)}
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>用量</Label>
                  <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="用量">
                    {tierKeys.map((key) => (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant={usageTier === key ? "default" : "outline"}
                        role="radio"
                        aria-checked={usageTier === key}
                        onClick={() => setUsageTier(key)}
                      >
                        {usageLabel(key)}
                      </Button>
                    ))}
                  </div>
                </div>

                <DeviceStepper value={poolDevices} onChange={setPoolDevices} />
              </div>
            )}

            {/* ── 绑定线 ── */}
            {line === "bind" && (
              <div className="space-y-4">
                <div>
                  <Label>产品与等级</Label>
                  <div className="mt-2 space-y-2">
                    {catalog.products.map((product) => {
                      const selected = product in bindLevels;
                      const levels = catalog.levels[product] ?? [];
                      return (
                        <div
                          key={product}
                          className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5"
                          data-selected={selected || undefined}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant={selected ? "default" : "outline"}
                            aria-pressed={selected}
                            onClick={() => toggleBindProduct(product)}
                          >
                            {productLabel(product)}
                          </Button>
                          {selected && (
                            <div
                              className="flex flex-wrap gap-1.5"
                              role="radiogroup"
                              aria-label={`${productLabel(product)} 等级`}
                            >
                              {levels.map((level) => (
                                <Button
                                  key={level}
                                  type="button"
                                  size="sm"
                                  variant={bindLevels[product] === level ? "secondary" : "ghost"}
                                  role="radio"
                                  aria-checked={bindLevels[product] === level}
                                  onClick={() =>
                                    setBindLevels((prev) => ({ ...prev, [product]: level }))
                                  }
                                >
                                  {levelLabel(level)}
                                </Button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <Label>共享人数</Label>
                  <Select
                    value={String(shareUsers)}
                    onValueChange={(v) => setShareUsers(Number(v))}
                    items={SHARE_OPTIONS.map((n) => ({
                      label: n === 1 ? `${n} 人独号` : `${n} 人拼车`,
                      value: String(n),
                    }))}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {SHARE_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n === 1 ? `${n} 人独号` : `${n} 人拼车`}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                <DeviceStepper value={bindDevices} onChange={setBindDevices} />
              </div>
            )}

            {/* 参考价 + 有效期 */}
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                参考价（免费发放）· 有效期 {catalog.durationDays} 天
              </span>
              <Badge variant="secondary">{priced ? fmtYuan(priced.priceCents) : "—"}</Badge>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={granting}>
            取消
          </Button>
          <Button
            onClick={() => void doGrant()}
            disabled={granting || state.kind !== "ready" || !priced}
          >
            {granting ? "发放中…" : "确认发放"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 设备数加减步进器(1–20)。 */
function DeviceStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <Label>设备数</Label>
      <div className="mt-2 flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="减少"
          disabled={value <= 1}
          onClick={() => onChange(Math.max(1, value - 1))}
        >
          −
        </Button>
        <span className="w-16 text-center text-sm tabular-nums" aria-live="polite">
          {value} 台
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="增加"
          disabled={value >= MAX_DEVICES}
          onClick={() => onChange(Math.min(MAX_DEVICES, value + 1))}
        >
          +
        </Button>
      </div>
    </div>
  );
}
