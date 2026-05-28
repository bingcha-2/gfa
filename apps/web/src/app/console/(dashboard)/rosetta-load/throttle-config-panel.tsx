"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { RefreshCw, Plus, X, Save, Trash2 } from "lucide-react";

import type {
  ThrottleConfig,
  ThrottleGlobal,
  ThrottleModelOverride,
  ThrottleEscalationThreshold,
  ModelRow,
  EscalationRow,
} from "./types";
import { uid } from "./constants";

export function ThrottleConfigPanel() {
  const [throttleLoaded, setThrottleLoaded] = useState(false);
  const [throttlePath, setThrottlePath] = useState("");
  const [hasThrottleConfig, setHasThrottleConfig] = useState(false);
  const [emergencyEnabled, setEmergencyEnabled] = useState(false);
  const [emergencyMaxAttempts, setEmergencyMaxAttempts] = useState("3");
  const [emergencyBaseDelay, setEmergencyBaseDelay] = useState("5000");
  const [emergencyMessage, setEmergencyMessage] = useState("");
  const [globalMaxAttempts, setGlobalMaxAttempts] = useState("");
  const [globalBaseDelay, setGlobalBaseDelay] = useState("");
  const [globalCapacityWait, setGlobalCapacityWait] = useState("");
  const [globalBackoff, setGlobalBackoff] = useState("");
  const [modelRows, setModelRows] = useState<ModelRow[]>([]);
  const [escalationEnabled, setEscalationEnabled] = useState(true);
  const [escalationRows, setEscalationRows] = useState<EscalationRow[]>([
    { id: uid(), rate503: "0.3", addDelayMs: "500" },
    { id: uid(), rate503: "0.5", addDelayMs: "1500" },
    { id: uid(), rate503: "0.8", addDelayMs: "3000" },
  ]);
  const [savingThrottle, setSavingThrottle] = useState(false);

  function populateThrottleState(config: ThrottleConfig | null | undefined) {
    const c = config || ({} as ThrottleConfig);
    setHasThrottleConfig(!!config);
    setEmergencyEnabled(!!c.emergency?.enabled);
    setEmergencyMaxAttempts(String(c.emergency?.maxAttempts || 3));
    setEmergencyBaseDelay(String(c.emergency?.baseDelayMs || 5000));
    setEmergencyMessage(c.emergency?.message || "");
    setGlobalMaxAttempts(c.global?.maxAttempts != null ? String(c.global.maxAttempts) : "");
    setGlobalBaseDelay(c.global?.baseDelayMs != null ? String(c.global.baseDelayMs) : "");
    setGlobalCapacityWait(c.global?.capacityWaitMs != null ? String(c.global.capacityWaitMs) : "");
    setGlobalBackoff(c.global?.backoffMultiplier != null ? String(c.global.backoffMultiplier) : "");
    if (c.models) {
      setModelRows(
        Object.entries(c.models).map(([name, cfg]) => ({
          id: uid(),
          name,
          baseDelayMs: cfg.baseDelayMs != null ? String(cfg.baseDelayMs) : "",
          capacityWaitMs: cfg.capacityWaitMs != null ? String(cfg.capacityWaitMs) : "",
          maxAttempts: cfg.maxAttempts != null ? String(cfg.maxAttempts) : "",
          backoffMultiplier: cfg.backoffMultiplier != null ? String(cfg.backoffMultiplier) : "",
        }))
      );
    } else {
      setModelRows([]);
    }
    setEscalationEnabled(c.autoEscalation?.enabled !== false);
    const thresholds = c.autoEscalation?.thresholds || [
      { rate503: 0.3, addDelayMs: 500 },
      { rate503: 0.5, addDelayMs: 1500 },
      { rate503: 0.8, addDelayMs: 3000 },
    ];
    setEscalationRows(
      thresholds.map((t) => ({
        id: uid(),
        rate503: String(t.rate503),
        addDelayMs: String(t.addDelayMs),
      }))
    );
  }

  const fetchThrottleConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/rosetta/throttle-config");
      if (!res.ok) return;
      const data = await res.json();
      setThrottleLoaded(true);
      setThrottlePath(data.path || "");
      populateThrottleState(data.config);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    fetchThrottleConfig();
  }, [fetchThrottleConfig]);

  async function handleSaveThrottle() {
    setSavingThrottle(true);
    const config: ThrottleConfig = {};
    if (emergencyEnabled) {
      config.emergency = {
        enabled: true,
        maxAttempts: Number(emergencyMaxAttempts) || 3,
        baseDelayMs: Number(emergencyBaseDelay) || 5000,
        message: emergencyMessage,
      };
    }
    const global: ThrottleGlobal = {};
    if (globalMaxAttempts !== "") global.maxAttempts = Number(globalMaxAttempts);
    if (globalBaseDelay !== "") global.baseDelayMs = Number(globalBaseDelay);
    if (globalCapacityWait !== "") global.capacityWaitMs = Number(globalCapacityWait);
    if (globalBackoff !== "") global.backoffMultiplier = Number(globalBackoff);
    if (Object.keys(global).length) config.global = global;
    const models: Record<string, ThrottleModelOverride> = {};
    for (const row of modelRows) {
      if (!row.name.trim()) continue;
      const entry: ThrottleModelOverride = {};
      if (row.baseDelayMs !== "") entry.baseDelayMs = Number(row.baseDelayMs);
      if (row.capacityWaitMs !== "") entry.capacityWaitMs = Number(row.capacityWaitMs);
      if (row.maxAttempts !== "") entry.maxAttempts = Number(row.maxAttempts);
      if (row.backoffMultiplier !== "") entry.backoffMultiplier = Number(row.backoffMultiplier);
      if (Object.keys(entry).length) models[row.name.trim()] = entry;
    }
    if (Object.keys(models).length) config.models = models;
    const thresholds: ThrottleEscalationThreshold[] = escalationRows
      .filter((r) => r.rate503 !== "" && r.addDelayMs !== "")
      .map((r) => ({ rate503: Number(r.rate503), addDelayMs: Number(r.addDelayMs) }))
      .sort((a, b) => a.rate503 - b.rate503);
    if (thresholds.length || !escalationEnabled) {
      config.autoEscalation = { enabled: escalationEnabled, thresholds };
    }
    try {
      await fetch("/api/rosetta/throttle-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      toast.success("节流配置已保存，立即对新请求生效");
      await fetchThrottleConfig();
    } catch (err) {
      toast.error("保存失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setSavingThrottle(false);
    }
  }

  async function handleDeleteThrottle() {
    try {
      await fetch("/api/rosetta/throttle-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: true }),
      });
      toast.success("已恢复自动模式");
      await fetchThrottleConfig();
    } catch (err) {
      toast.error("删除失败: " + (err instanceof Error ? err.message : "未知错误"));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">动态节流配置</h2>
          <p className="text-xs text-muted-foreground">
            控制客户端重试速率。无配置时使用自动模式（根据号池健康度动态调整）。修改后立即对所有新请求生效。
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={fetchThrottleConfig}>
            <RefreshCw data-icon className="size-3.5" />
            刷新
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="destructive" size="sm" disabled={!hasThrottleConfig}>
                  <Trash2 data-icon className="size-3.5" />
                  恢复自动
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>恢复自动模式</AlertDialogTitle>
                <AlertDialogDescription>
                  确定恢复自动模式？将删除手动配置文件。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={handleDeleteThrottle}>确认</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {throttleLoaded && (
        <div className="text-xs text-muted-foreground">
          {hasThrottleConfig ? (
            <span className="text-primary">
              当前有手动配置生效。路径: {throttlePath}
            </span>
          ) : (
            "自动模式（无手动配置文件）"
          )}
        </div>
      )}

      <div className="grid gap-3">
        {/* Emergency */}
        <Card className="border-red-500/25 bg-red-500/[0.04]">
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-red-400">紧急模式</span>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Switch
                  checked={emergencyEnabled}
                  onCheckedChange={setEmergencyEnabled}
                  size="sm"
                />
                启用
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">最大重试</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={emergencyMaxAttempts}
                  onChange={(e) =>
                    setEmergencyMaxAttempts((e.target as HTMLInputElement).value)
                  }
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">基础延迟(ms)</label>
                <Input
                  type="number"
                  min={500}
                  value={emergencyBaseDelay}
                  onChange={(e) =>
                    setEmergencyBaseDelay((e.target as HTMLInputElement).value)
                  }
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">提示消息</label>
                <Input
                  placeholder="维护中..."
                  value={emergencyMessage}
                  onChange={(e) =>
                    setEmergencyMessage((e.target as HTMLInputElement).value)
                  }
                  className="h-8 text-sm"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Global defaults */}
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div>
              <span className="text-sm font-semibold">全局默认</span>
              <p className="text-xs text-muted-foreground">
                所有模型生效。留空 = 自动模式。
              </p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {([
                ["maxAttempts", globalMaxAttempts, setGlobalMaxAttempts],
                ["baseDelayMs", globalBaseDelay, setGlobalBaseDelay],
                ["capacityWaitMs", globalCapacityWait, setGlobalCapacityWait],
                ["backoffMultiplier", globalBackoff, setGlobalBackoff],
              ] as const).map(([label, value, setter]) => (
                <div key={label} className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">{label}</label>
                  <Input
                    type="number"
                    step={label === "backoffMultiplier" ? 0.1 : undefined}
                    placeholder="自动"
                    value={value}
                    onChange={(e) => setter((e.target as HTMLInputElement).value)}
                    className="h-8 text-sm"
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Per-model overrides */}
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-semibold">按模型覆盖</span>
                <p className="text-xs text-muted-foreground">
                  优先于全局。只设置需要覆盖的字段。
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setModelRows((prev) => [
                    ...prev,
                    { id: uid(), name: "", baseDelayMs: "", capacityWaitMs: "", maxAttempts: "", backoffMultiplier: "" },
                  ])
                }
              >
                <Plus data-icon className="size-3.5" />
                添加模型
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {modelRows.map((row) => (
                <div key={row.id} className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr_auto] gap-2 items-end">
                  {(["name", "baseDelayMs", "capacityWaitMs", "maxAttempts", "backoffMultiplier"] as const).map(
                    (field) => (
                      <div key={field} className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">
                          {field === "name" ? "模型名" : field === "backoffMultiplier" ? "backoff" : field}
                        </label>
                        <Input
                          type={field === "name" ? "text" : "number"}
                          step={field === "backoffMultiplier" ? 0.1 : undefined}
                          value={row[field]}
                          placeholder={field === "name" ? "gemini-2.5-pro" : "自动"}
                          onChange={(e) =>
                            setModelRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id ? { ...r, [field]: (e.target as HTMLInputElement).value } : r,
                              ),
                            )
                          }
                          className="h-8 text-sm"
                        />
                      </div>
                    ),
                  )}
                  <Button
                    variant="destructive"
                    size="icon-xs"
                    className="mb-0.5"
                    onClick={() => setModelRows((prev) => prev.filter((r) => r.id !== row.id))}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
              {modelRows.length === 0 && (
                <p className="text-xs text-muted-foreground">暂无模型覆盖配置</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 503 Escalation */}
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-semibold">503 频率自动升级</span>
                <p className="text-xs text-muted-foreground">
                  当 503 错误占比超过阈值时，自动增加延迟。
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Switch
                  checked={escalationEnabled}
                  onCheckedChange={setEscalationEnabled}
                  size="sm"
                />
                启用
              </label>
            </div>
            <div className="flex flex-col gap-2">
              {escalationRows.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[1fr_20px_1fr_auto] gap-2 items-center"
                >
                  <Input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1}
                    value={row.rate503}
                    placeholder="503占比 (0~1)"
                    onChange={(e) =>
                      setEscalationRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? { ...r, rate503: (e.target as HTMLInputElement).value }
                            : r
                        )
                      )
                    }
                    className="h-8 text-sm"
                  />
                  <span className="text-center text-muted-foreground text-xs">→</span>
                  <Input
                    type="number"
                    min={0}
                    value={row.addDelayMs}
                    placeholder="追加延迟(ms)"
                    onChange={(e) =>
                      setEscalationRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? { ...r, addDelayMs: (e.target as HTMLInputElement).value }
                            : r
                        )
                      )
                    }
                    className="h-8 text-sm"
                  />
                  <Button
                    variant="destructive"
                    size="icon-xs"
                    onClick={() =>
                      setEscalationRows((prev) => prev.filter((r) => r.id !== row.id))
                    }
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setEscalationRows((prev) => [
                  ...prev,
                  { id: uid(), rate503: "", addDelayMs: "" },
                ])
              }
            >
              <Plus data-icon className="size-3.5" />
              添加阈值
            </Button>
          </CardContent>
        </Card>

        {/* Save button */}
        <Button onClick={handleSaveThrottle} disabled={savingThrottle} className="self-start">
          {savingThrottle ? (
            <Spinner size={14} className="mr-1" />
          ) : (
            <Save data-icon className="size-3.5" />
          )}
          保存节流配置
        </Button>
      </div>
    </div>
  );
}
