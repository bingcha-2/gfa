"use client";

// 套餐配置页(console / plan-catalog)—— 运营用表单编辑 / 发布 PlanCatalog(spec §4.1 / §7),
// 全程不碰 JSON。瘦容器:取数 + 表单状态编排,渲染委托给各 section 子组件。
//
// 数据流:
//   - 进页面:GET /api/plan-catalog 取当前 PUBLISHED 的 {version, config},预填表单
//     (在发布版上改);无发布版则用 catalog-defaults 的占位 config。
//   - 编辑:全部落 form(PlanCatalogForm)单一状态;改任一格 → 实时算价预览。
//   - 存草稿:formToConfig(form) → POST /api/console/plan-catalog 建草稿(留版本)。
//   - 发布:先存草稿拿到 id,再 POST :id/publish(旧版自动归档),编辑不影响线上。
//
// 顶栏徽章:当前发布 vM(只读 PUBLISHED) + 草稿 vN(本次存草稿后)。发布留版本可回滚。

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SaveIcon, UploadIcon, RotateCcwIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import {
  configToForm,
  formToConfig,
  validateForm,
  type PlanCatalogForm,
} from "@/lib/console/plan-catalog-form";
import { usePlanCatalog } from "./use-plan-catalog";
import { DEFAULT_CONFIG } from "./catalog-defaults";
import { ProductsSection } from "./products-section";
import { PricingSection } from "./pricing-section";
import { UsageSection } from "./usage-section";
import { PricePreview } from "./price-preview";
import { NumberInput } from "./form-bits";

export default function PlanCatalogPage() {
  const { publishedConfig, publishedVersion, loading, error, refresh, saveDraft, publish } =
    usePlanCatalog();

  // 表单单一真相源。null = 尚未从后端初始化。
  const [form, setForm] = useState<PlanCatalogForm | null>(null);
  // 上次存草稿后的草稿版本号(展示「草稿 vN」徽章)。
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  // 自上次保存以来是否有改动(用于徽章「未保存」提示)。
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  // 后端加载完成后,用发布版(或占位)初始化表单一次。
  useEffect(() => {
    if (loading || form) return;
    setForm(configToForm(publishedConfig ?? DEFAULT_CONFIG));
  }, [loading, form, publishedConfig]);

  // 受控更新:任意 patch 合并进 form 并标记 dirty。
  const patchForm = useCallback((patch: Partial<PlanCatalogForm>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }, []);

  const enabledProducts = useMemo(
    () => (form ? form.products.filter((p) => p.enabled).map((p) => p.product) : []),
    [form],
  );

  // 校验错误(实时,用于禁用发布 + 提示)。
  const validationErrors = useMemo(() => (form ? validateForm(form) : []), [form]);

  // 重置回当前发布版(放弃本地改动)。
  const resetToPublished = useCallback(() => {
    setForm(configToForm(publishedConfig ?? DEFAULT_CONFIG));
    setDirty(false);
    setDraftVersion(null);
  }, [publishedConfig]);

  // 存草稿:formToConfig → POST。成功后记草稿版本号、清 dirty。返回草稿 id(供发布复用)。
  const handleSaveDraft = useCallback(async (): Promise<string | null> => {
    if (!form) return null;
    setSaving(true);
    try {
      const draft = await saveDraft(formToConfig(form));
      setDraftVersion(draft.version);
      setDirty(false);
      toast.success(`已存为草稿 v${draft.version}`);
      return draft.id;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "存草稿失败");
      return null;
    } finally {
      setSaving(false);
    }
  }, [form, saveDraft]);

  // 发布:先存草稿拿 id,再发布;成功后刷新发布徽章。
  const handlePublish = useCallback(async () => {
    if (!form) return;
    setConfirmPublish(false);
    setPublishing(true);
    try {
      const draft = await saveDraft(formToConfig(form));
      setDraftVersion(draft.version);
      setDirty(false);
      const published = await publish(draft.id);
      toast.success(`已发布 v${published.version}(线上生效)`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "发布失败");
    } finally {
      setPublishing(false);
    }
  }, [form, saveDraft, publish, refresh]);

  const busy = saving || publishing;

  // ── 加载 / 错误态 ──
  if (loading || !form) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Spinner />
        加载套餐配置…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── 顶栏:标题 + 版本徽章 + 操作 ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">套餐配置</h1>
          <p className="text-sm text-muted-foreground">
            用表单编辑 PlanCatalog 并发布。编辑不影响线上(客户端只读已发布版),
            发布会留版本可回滚。价格单位:元。
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">
              当前发布{" "}
              {publishedVersion != null ? `v${publishedVersion}` : "无"}
            </Badge>
            {draftVersion != null && (
              <Badge variant="secondary">草稿 v{draftVersion}</Badge>
            )}
            {dirty && (
              <Badge className="bg-amber-500 text-white">未保存改动</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={resetToPublished}
              disabled={busy || !dirty}
            >
              <RotateCcwIcon data-icon className="size-3.5" />
              重置
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSaveDraft()}
              disabled={busy}
            >
              {saving ? <Spinner data-icon className="size-3.5" /> : <SaveIcon data-icon className="size-3.5" />}
              存草稿
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmPublish(true)}
              disabled={busy || validationErrors.length > 0}
            >
              {publishing ? <Spinner data-icon className="size-3.5" /> : <UploadIcon data-icon className="size-3.5" />}
              发布
            </Button>
          </div>
        </div>
      </div>

      {/* 取数错误(发布版拉取失败)。 */}
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      )}

      {/* 校验提示(发布前需修)。 */}
      {validationErrors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-500">
          <div className="mb-1 font-medium">发布前请修正:</div>
          <ul className="list-inside list-disc space-y-0.5 text-xs">
            {validationErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 左:编辑区(2/3) */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>产品与等级</CardTitle>
              <CardDescription>
                每个产品的启用开关与绑定线等级档(等级 = 绑定线可选档)。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProductsSection
                value={form.products}
                onChange={(products) => patchForm({ products })}
                disabled={busy}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>定价</CardTitle>
              <CardDescription>
                号池线 = 产品价 + 用量加价 + 设备;绑定线 = 等级矩阵 + 共享折扣 + 设备。元为单位。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PricingSection
                products={form.products}
                usageTiers={form.usageTiers}
                pool={form.pricing.pool}
                bind={form.pricing.bind}
                onPoolChange={(poolNext) =>
                  patchForm({ pricing: { ...form.pricing, pool: poolNext } })
                }
                onBindChange={(bindNext) =>
                  patchForm({ pricing: { ...form.pricing, bind: bindNext } })
                }
                disabled={busy}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>用量档(号池线)</CardTitle>
              <CardDescription>
                每档逐模型 token 上限 + 周限额。桶随启用产品自动列出。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <UsageSection
                value={form.usageTiers}
                onChange={(usageTiers) => patchForm({ usageTiers })}
                enabledProducts={enabledProducts}
                disabled={busy}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>有效期与窗口</CardTitle>
              <CardDescription>
                有效期(单一周期)与限额窗口(锁死 5 小时 = 18000000 毫秒)。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-6">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">有效期</span>
                  <NumberInput
                    className="w-40"
                    value={form.durationDays}
                    onChange={(durationDays) => patchForm({ durationDays })}
                    min={1}
                    suffix="天"
                    aria-label="有效期天数"
                    disabled={busy}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">限额窗口</span>
                  <NumberInput
                    className="w-48"
                    value={form.windowMs}
                    onChange={(windowMs) => patchForm({ windowMs })}
                    min={60000}
                    suffix="ms"
                    aria-label="限额窗口毫秒"
                    disabled={busy}
                  />
                </label>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右:实时算价预览(1/3,sticky) */}
        <div className="lg:col-span-1">
          <Card className="lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle>实时算价预览</CardTitle>
              <CardDescription>代表套餐组合的价格(随编辑即时更新)。</CardDescription>
            </CardHeader>
            <CardContent>
              <PricePreview form={form} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Separator />
      <p className="text-xs text-muted-foreground">
        提示:「存草稿」只保存版本不上线;「发布」会把当前编辑保存为新版并设为线上,
        旧版自动归档(可回滚)。
      </p>

      {/* 发布二次确认。 */}
      <AlertDialog
        open={confirmPublish}
        onOpenChange={(o) => {
          if (!o && !publishing) setConfirmPublish(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>发布到线上?</AlertDialogTitle>
            <AlertDialogDescription>
              将把当前编辑保存为新草稿版本并发布,客户端购买页立即读到新配置;
              当前发布版
              {publishedVersion != null ? ` v${publishedVersion}` : ""}
              将归档(可回滚)。在售订单不受影响(各自快照)。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handlePublish()} disabled={publishing}>
              {publishing ? <Spinner data-icon className="size-3.5" /> : null}
              确认发布
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
