"use client";
import { toast } from "sonner";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildSubscriptionView } from "@/lib/console/subscription-view";
import { RebindRow } from "./rebind-row";
import type { ConsoleSubscription } from "@/lib/console/types";

export function SubscriptionDetailDrawer({
  sub,
  open,
  onOpenChange,
  onChanged,
}: {
  sub: ConsoleSubscription | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void | Promise<void>;
}) {
  if (!sub) return null;
  const view = buildSubscriptionView({ config: sub.config });

  async function revoke() {
    try {
      await apiRequest(`subscriptions/${sub!.id}/revoke`, { method: "POST" });
      toast.success("已撤销订阅");
      onOpenChange(false);
      await onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="ml-auto h-full w-full max-w-md">
        <DrawerHeader>
          <DrawerTitle>订阅详情</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4 overflow-y-auto">
          <div className="text-sm text-muted-foreground">
            <a
              className="text-blue-600 hover:underline"
              href={`/console/customers/${sub.customerId}`}
            >
              客户 {sub.customer?.email ?? sub.customerId} ↗
            </a>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                view.line === "bind"
                  ? "border-blue-300 text-blue-600"
                  : "text-muted-foreground"
              }
            >
              {view.line === "bind" ? "绑定线" : "号池线"}
            </Badge>
            <Badge variant="secondary">{sub.status}</Badge>
            <span className="text-xs text-muted-foreground">
              共享 w{view.weight} · 设备 {view.deviceLimit} 台
            </span>
          </div>
          {view.line === "bind" ? (
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground mb-1">产品与绑定</div>
              {view.rows.map((row) => (
                <RebindRow key={row.product} subId={sub.id} row={row} onDone={onChanged} />
              ))}
            </div>
          ) : (
            <div className="rounded-md border p-3 text-sm">
              号池线 · 用量档 {view.usageTier ?? "—"} · 运行时动态调度,不绑定具体号。
            </div>
          )}
          {sub.status === "ACTIVE" && (
            <div className="flex justify-end pt-2 border-t">
              <Button
                variant="outline"
                className="text-destructive border-destructive/40"
                onClick={() => void revoke()}
              >
                撤销订阅
              </Button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
