"use client";

import { useEffect, useState } from "react";
import { Clock3, Gift } from "lucide-react";
import { toast } from "sonner";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type GrantTrialResponse = {
  created: boolean;
  subscription: {
    id: string;
    expiresAt: string | null;
  };
};

export function GrantTrialDialog({
  open,
  onOpenChange,
  customerId,
  customerEmail,
  defaultDurationDays = 3,
  defaultWeeklyUsdLimit = 20,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerEmail: string;
  defaultDurationDays?: number;
  defaultWeeklyUsdLimit?: number;
  onGranted: () => void | Promise<void>;
}) {
  const [durationDays, setDurationDays] = useState(String(defaultDurationDays));
  const [weeklyUsdLimit, setWeeklyUsdLimit] = useState(
    String(defaultWeeklyUsdLimit),
  );
  const [submitting, setSubmitting] = useState(false);
  const days = Number(durationDays);
  const weeklyLimit = Number(weeklyUsdLimit);
  const invalidDays = durationDays !== ""
    && (!Number.isInteger(days) || days < 1 || days > 365);
  const invalidWeeklyUsdLimit = weeklyUsdLimit !== ""
    && (
      !Number.isFinite(weeklyLimit)
      || weeklyLimit <= 0
      || weeklyLimit > 1_000_000
    );
  const invalid = invalidDays || invalidWeeklyUsdLimit;

  useEffect(() => {
    if (open) {
      setDurationDays(String(defaultDurationDays));
      setWeeklyUsdLimit(String(defaultWeeklyUsdLimit));
    }
  }, [
    defaultDurationDays,
    defaultWeeklyUsdLimit,
    open,
  ]);

  async function grantTrial() {
    if (
      invalid
      || durationDays === ""
      || weeklyUsdLimit === ""
    ) {
      toast.error("请填写有效的试用天数和每周额度");
      return;
    }
    try {
      setSubmitting(true);
      const result = await apiRequest<GrantTrialResponse>(`customers/${customerId}/trial`, {
        method: "POST",
        body: {
          durationDays: days,
          weeklyUsdLimit: weeklyLimit,
        },
      });
      if (result.created) {
        toast.success(
          `已开通 ${days} 天 Codex 试用，每周额度 $${weeklyLimit.toFixed(2)}`,
        );
      } else {
        toast.info("该客户已经领取过试用，未重复发放");
      }
      onOpenChange(false);
      await onGranted();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>发放试用</DialogTitle>
          <DialogDescription>
            为 {customerEmail} 开通一次试用，立即开始计时。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Alert>
            <Clock3 />
            <AlertTitle>每位客户仅限一次</AlertTitle>
            <AlertDescription>
              仅开通 Codex 号池，不绑定固定母号。只计算每周 USD 额度，重复提交不会延长试用或重置额度。
            </AlertDescription>
          </Alert>

          <Field data-invalid={invalidDays || undefined}>
            <FieldLabel htmlFor="trial-duration-days">试用天数</FieldLabel>
            <Input
              id="trial-duration-days"
              type="number"
              min={1}
              max={365}
              step={1}
              value={durationDays}
              aria-invalid={invalidDays || undefined}
              onChange={(event) => setDurationDays(event.target.value)}
            />
            {invalidDays && <FieldError>请输入 1-365 的整数。</FieldError>}
          </Field>

          <Field data-invalid={invalidWeeklyUsdLimit || undefined}>
            <FieldLabel htmlFor="trial-weekly-usd-limit">
              每周额度（USD）
            </FieldLabel>
            <Input
              id="trial-weekly-usd-limit"
              type="number"
              min={0.01}
              max={1_000_000}
              step={0.1}
              value={weeklyUsdLimit}
              aria-invalid={invalidWeeklyUsdLimit || undefined}
              onChange={(event) => setWeeklyUsdLimit(event.target.value)}
            />
            <FieldDescription>
              按 Codex API 等价美元价值累计，与正式 Codex 订阅口径一致。
            </FieldDescription>
            {invalidWeeklyUsdLimit && (
              <FieldError>请输入大于 $0 且不超过 $1,000,000 的金额。</FieldError>
            )}
          </Field>

          <FieldDescription>
            正式套餐开通后，系统会结束仍在生效的试用。
          </FieldDescription>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button
            onClick={() => void grantTrial()}
            disabled={
              submitting
              || invalid
              || durationDays === ""
              || weeklyUsdLimit === ""
            }
          >
            {submitting ? <Spinner data-icon="inline-start" /> : <Gift data-icon="inline-start" />}
            {submitting ? "发放中" : "确认发放"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
