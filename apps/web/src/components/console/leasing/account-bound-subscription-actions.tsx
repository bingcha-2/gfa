"use client";

import { useState } from "react";
import { GitBranchIcon, TimerResetIcon } from "lucide-react";
import { toast } from "sonner";

import { consoleApiPath } from "@/lib/console/client-api";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/alert-dialog";

type Product = "codex" | "anthropic";

type AccountBoundSubscriptionActionsProps = {
  product: Product;
  account: { id: number; email?: string | null; boundCardCount?: number | null };
  onChanged: () => void | Promise<void>;
  disabled?: boolean;
};

type ResetResult = {
  matchedSubscriptions: number;
  resetSubscriptions: number;
  resetWindows: number;
};

type RebindResult = {
  movedSubscriptions: number;
  targets: Array<{ accountId: number; email: string | null; count: number }>;
};

async function post<T>(resource: string, body: object): Promise<T> {
  const response = await fetch(consoleApiPath(resource), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
  return payload as T;
}

export function AccountBoundSubscriptionActions({
  product,
  account,
  onChanged,
  disabled = false,
}: AccountBoundSubscriptionActionsProps) {
  const [dialog, setDialog] = useState<"reset" | "rebind" | null>(null);
  const [busy, setBusy] = useState<"reset" | "rebind" | null>(null);
  const boundCount = Number(account.boundCardCount || 0);
  const unavailable = disabled;
  const productName = product === "codex" ? "Codex" : "Claude";

  async function reset() {
    setBusy("reset");
    try {
      const result = await post<ResetResult>("account-bindings/reset", { product, accountId: account.id });
      toast.success(`已重置 ${result.resetSubscriptions}/${result.matchedSubscriptions} 个绑定订阅的 ${productName} 额度`, {
        description: `已清除 ${result.resetWindows} 个额度窗口。`,
      });
      setDialog(null);
      await onChanged();
    } catch (error) {
      toast.error("重置绑定用户额度失败", { description: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setBusy(null);
    }
  }

  async function rebind() {
    setBusy("rebind");
    try {
      const result = await post<RebindResult>("account-bindings/rebind", { product, accountId: account.id });
      const targetSummary = result.targets.map((target) => `#${target.accountId} ${target.count} 人`).join("；");
      toast.success(`已换绑 ${result.movedSubscriptions} 个 ${productName} 订阅`, {
        description: targetSummary || "当前账号没有需要换绑的订阅。",
      });
      setDialog(null);
      await onChanged();
    } catch (error) {
      toast.error("一键换绑失败", { description: error instanceof Error ? error.message : "请检查同等级账号是否有空位" });
    } finally {
      setBusy(null);
    }
  }

  const countHint = boundCount < 1 ? "当前列表未显示绑定订阅，仍可执行核对" : undefined;

  return (
    <>
      <Button variant="ghost" size="icon" aria-label={`重置 ${account.email || `账号 #${account.id}`} 绑定用户的 ${productName} 额度`} title={countHint || "重置所有绑定用户的本地额度"} disabled={unavailable} onClick={() => setDialog("reset")}>
        <TimerResetIcon className="size-4 text-violet-500" />
      </Button>
      <Button variant="ghost" size="icon" aria-label={`换绑 ${account.email || `账号 #${account.id}`} 的所有 ${productName} 用户`} title={countHint || "将所有绑定用户分配到同等级空位账号"} disabled={unavailable} onClick={() => setDialog("rebind")}>
        <GitBranchIcon className="size-4 text-blue-500" />
      </Button>

      <AlertDialog open={dialog === "reset"} onOpenChange={(open) => !open && !busy && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置绑定用户额度</AlertDialogTitle>
            <AlertDialogDescription>将清除账号 #{account.id}（{account.email || productName}）下所有绑定订阅的本地 5 小时与每周额度用量。</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">不会修改套餐额度，也不会重置上游账号本身的额度。</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "reset"}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy === "reset"} onClick={(event) => { event.preventDefault(); void reset(); }}>{busy === "reset" ? <Spinner size={14} /> : null}确认重置</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "rebind"} onOpenChange={(open) => !open && !busy && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>一键换绑全部用户</AlertDialogTitle>
            <AlertDialogDescription>将账号 #{account.id}（{account.email || productName}）下所有绑定订阅迁移至一个或多个同等级、启用且有空位的账号。</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">系统会汇总多个账号的剩余容量并自动分配；总容量不足时，整批不会变更。</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "rebind"}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy === "rebind"} onClick={(event) => { event.preventDefault(); void rebind(); }}>{busy === "rebind" ? <Spinner size={14} /> : null}确认换绑</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
