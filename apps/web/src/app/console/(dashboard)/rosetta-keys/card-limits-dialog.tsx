"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { SaveIcon, RotateCcwIcon } from "lucide-react";

type BucketInfo = {
  bucket: string;
  label: string;
  customLimit: number | null;
  defaultLimit: number;
  effectiveLimit: number;
  used: number;
};

type LimitsData = {
  id: string;
  name: string;
  tokenWindowLimit: number;
  bucketLimits: Record<string, number>;
  buckets: BucketInfo[];
};

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function CardLimitsDialog({
  card,
  open,
  onOpenChange,
  onSaved,
}: {
  card: { id: string; key: string; name?: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<LimitsData | null>(null);

  // Editable state: empty string = use default, number string = custom value
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  const cardId = card?.id || "";

  const fetchData = useCallback(async () => {
    if (!cardId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/rosetta/access-key-limits?id=${encodeURIComponent(cardId)}`
      );
      const json = await res.json();
      if (json.ok) {
        setData(json);
        // Initialize editable values from custom limits
        const vals: Record<string, string> = {};
        for (const b of json.buckets || []) {
          vals[b.bucket] = b.customLimit != null ? String(b.customLimit) : "";
        }
        setEditValues(vals);
      } else {
        toast.error(json.error || "加载限额失败");
      }
    } catch {
      toast.error("加载限额失败");
    } finally {
      setLoading(false);
    }
  }, [cardId]);

  useEffect(() => {
    if (open && cardId) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cardId]);

  const handleSave = async () => {
    if (!cardId) return;
    setSaving(true);
    try {
      const bucketLimits: Record<string, number | null> = {};
      for (const [bucket, val] of Object.entries(editValues)) {
        const num = Number(val);
        // empty or 0 → remove custom override (use default)
        bucketLimits[bucket] =
          val.trim() !== "" && Number.isFinite(num) && num > 0 ? num : 0;
      }
      const res = await fetch("/api/rosetta/access-key-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cardId, bucketLimits }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "保存失败");
      toast.success("模型限额已保存");
      // Re-fetch to get updated effective limits
      await fetchData();
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    // Reset all to empty = use defaults
    const vals: Record<string, string> = {};
    for (const b of data?.buckets || []) {
      vals[b.bucket] = "";
    }
    setEditValues(vals);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>模型限额设置</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{card?.key}</code>
            {card?.name ? ` · ${card.name}` : ""}
          </DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner />
            加载中...
          </div>
        ) : data ? (
          <div className="flex flex-col gap-4">
            {/* Base limit info */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>基准限额:</span>
              <Badge variant="secondary">
                {data.tokenWindowLimit > 0
                  ? `${fmt(data.tokenWindowLimit)} tokens / 窗口`
                  : "无限制"}
              </Badge>
            </div>

            <Separator />

            {/* Per-bucket rows */}
            <div className="space-y-4">
              {data.buckets.map((b) => {
                const editVal = editValues[b.bucket] ?? "";
                const customNum = Number(editVal);
                const effectiveLimit =
                  editVal.trim() !== "" &&
                  Number.isFinite(customNum) &&
                  customNum > 0
                    ? customNum
                    : b.defaultLimit;
                const usedPercent =
                  effectiveLimit > 0
                    ? Math.min(100, (b.used / effectiveLimit) * 100)
                    : 0;
                const isOverLimit =
                  effectiveLimit > 0 && b.used >= effectiveLimit;
                const isCustom = editVal.trim() !== "";

                return (
                  <div
                    key={b.bucket}
                    className="rounded-lg border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={isOverLimit ? "destructive" : "secondary"}
                          className="text-xs"
                        >
                          {b.label}
                        </Badge>
                        {isCustom && (
                          <span className="text-[10px] text-blue-500 font-medium">
                            自定义
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        已用{" "}
                        <span className="font-medium text-foreground">
                          {fmtK(b.used)}
                        </span>{" "}
                        / {effectiveLimit > 0 ? fmtK(effectiveLimit) : "∞"}
                      </div>
                    </div>

                    {/* Progress bar */}
                    {effectiveLimit > 0 && (
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isOverLimit
                              ? "bg-destructive"
                              : usedPercent > 80
                                ? "bg-yellow-500"
                                : "bg-primary"
                          }`}
                          style={{ width: `${Math.min(100, usedPercent)}%` }}
                        />
                      </div>
                    )}

                    {/* Edit row */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[52px]">
                        限额:
                      </span>
                      <Input
                        type="number"
                        min={0}
                        className="h-8 text-sm"
                        placeholder={`默认 ${fmt(b.defaultLimit)}`}
                        value={editVal}
                        onChange={(e) =>
                          setEditValues((prev) => ({
                            ...prev,
                            [b.bucket]: e.target.value,
                          }))
                        }
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        tokens
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      默认: {fmt(b.defaultLimit)} tokens（基准 × {b.bucket === "gemini" ? "5" : "1"}）
                      {!isCustom && " · 当前使用默认值"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={saving || loading}
          >
            <RotateCcwIcon data-icon className="size-3.5" />
            恢复默认
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving ? (
              <Spinner data-icon className="size-3.5" />
            ) : (
              <SaveIcon data-icon className="size-3.5" />
            )}
            保存限额
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
