"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

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
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type ConfirmButtonProps = {
  children: ReactNode;
  confirmLabel?: ReactNode;
  loadingLabel?: ReactNode;
  confirmStyle?: CSSProperties;
  onConfirm: () => Promise<unknown> | void;
  timeout?: number;
  className?: string;
  style?: CSSProperties;
  armedStyle?: CSSProperties;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit" | "reset";
  id?: string;
};

export function ConfirmButton({
  children,
  confirmLabel = "确定执行这个操作？",
  loadingLabel = "执行中...",
  confirmStyle,
  onConfirm,
  className,
  style,
  disabled,
  title,
  type = "button",
  id,
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            id={id}
            type={type}
            className={className}
            style={style}
            disabled={disabled || loading}
            title={title}
            variant="outline"
          />
        }
      >
        {loading ? (
          <>
            <Spinner data-icon="inline-start" />
            {loadingLabel}
          </>
        ) : children}
      </AlertDialogTrigger>
      <AlertDialogContent style={confirmStyle}>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmLabel}</AlertDialogTitle>
          <AlertDialogDescription>此操作会立即生效。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <>
                <Spinner data-icon="inline-start" />
                {loadingLabel}
              </>
            ) : "确认"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
