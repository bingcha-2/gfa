"use client";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";

const SEAT_OPTIONS = [1, 2, 4, 8] as const;
const MAX_DEVICES = 20;

const PRODUCT_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  codex: "Codex",
  antigravity: "Antigravity (Gemini)",
};
const productLabel = (p: string) => PRODUCT_LABELS[p] ?? p;

const LEVEL_LABELS: Record<string, string> = {
  pro: "Pro",
  "max-5x": "Max 5x",
  "max-20x": "Max 20x",
  plus: "Plus",
  ultra: "Ultra",
};
const levelLabel = (l: string) => LEVEL_LABELS[l] ?? l;

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    const msg = data?.message ?? data?.error;
    if (Array.isArray(msg)) return msg.join(", ");
    if (typeof msg === "string") return msg;
  } catch {
    // non-JSON
  }
  return fallback;
}

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; catalog: CatalogConfig }
  | { kind: "unavailable" }
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
  onGranted: () => void | Promise<void>;
}) {
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [granting, setGranting] = useState(false);

  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const [shareSeats, setShareSeats] = useState(1);
  const [deviceLimit, setDeviceLimit] = useState(1);
  const [durationDays, setDurationDays] = useState("");

  useEffect(() => {
    if (!open) return;
    setState({ kind: "loading" });
    setBindLevels({});
    setShareSeats(1);
    setDeviceLimit(1);
    setDurationDays("");

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
          setState({ kind: "ready", catalog: data.config });
          setDurationDays(String(data.config.durationDays || 30));
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
  const shareCapacity = catalog?.shareCapacity ?? 8;
  const seatOptions = useMemo(
    () => SEAT_OPTIONS.filter((n) => n <= shareCapacity),
    [shareCapacity],
  );

  const selection: Selection = {
    line: "bind",
    items: Object.entries(bindLevels).map(([product, level]) => ({ product, level })),
    shareSeats,
    deviceLimit,
  };

  const priced = useMemo(() => {
    if (!catalog) return null;
    try {
      if (selection.items.length === 0) return null;
      return computePurchase(catalog, selection);
    } catch {
      return null;
    }
  }, [catalog, selection]);

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
      toast.error("请为选中的产品各选一个等级");
      return;
    }
    const days = Number(durationDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      toast.error("有效期必须是 1-3650 天");
      return;
    }
    try {
      setGranting(true);
      await apiRequest(`customers/${customerId}/subscriptions`, {
        method: "POST",
        body: { selection, durationDays: days },
      });
      toast.success("已发放订阅");
      onOpenChange(false);
      await onGranted();
    } catch (err) {
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
            按当前发布的套餐目录发放统一绑定线订阅。同产品的旧订阅会被自动取代。
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner /> 加载套餐目录...
          </div>
        )}

        {state.kind === "unavailable" && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            尚未发布套餐目录,请先到“套餐配置”发布后再发放。
          </div>
        )}

        {state.kind === "error" && (
          <div className="py-8 text-center text-sm text-destructive">{state.message}</div>
        )}

        {state.kind === "ready" && catalog && (
          <div className="space-y-4 py-2">
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
              <Label>席位</Label>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="席位">
                {seatOptions.map((n) => (
                  <Button
                    key={n}
                    type="button"
                    size="sm"
                    variant={shareSeats === n ? "default" : "outline"}
                    role="radio"
                    aria-checked={shareSeats === n}
                    onClick={() => setShareSeats(n)}
                  >
                    {n}/{shareCapacity} 席
                  </Button>
                ))}
              </div>
            </div>

            <DeviceStepper value={deviceLimit} onChange={setDeviceLimit} />

            <div>
              <Label htmlFor="grant-duration-days">有效期</Label>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id="grant-duration-days"
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                  className="w-32"
                />
                <span className="text-sm text-muted-foreground">天</span>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                参考价（免费发放） · 目录默认 {catalog.durationDays} 天
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
            {granting ? "发放中..." : "确认发放"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
          -
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
