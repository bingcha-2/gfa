"use client";

import { useState, useRef, useCallback, useEffect, type ReactNode, type CSSProperties } from "react";

type ConfirmButtonProps = {
  /** Label shown in the default (idle) state */
  children: ReactNode;
  /** Label shown when armed (awaiting second click). Defaults to "确定？" */
  confirmLabel?: ReactNode;
  /** Label shown while the action is executing */
  loadingLabel?: ReactNode;
  /** Custom style applied to the confirm popover */
  confirmStyle?: CSSProperties;
  /** The async action to execute on confirmation */
  onConfirm: () => Promise<unknown> | void;
  /** How long (ms) the armed state lasts before auto-resetting. Default 5000 */
  timeout?: number;
  /** Standard button props */
  className?: string;
  style?: CSSProperties;
  armedStyle?: CSSProperties;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit" | "reset";
  id?: string;
};

/**
 * A button that requires two clicks to execute a destructive action.
 *
 * - 1st click  → shows a floating confirm popover above the button
 * - 2nd click (on "确认" in the popover) → executes onConfirm()
 * - Auto-resets after `timeout` ms if the 2nd click doesn't happen
 * - Click outside dismisses the popover
 */
export function ConfirmButton({
  children,
  confirmLabel = "确定？",
  loadingLabel = "执行中...",
  confirmStyle,
  onConfirm,
  timeout = 5000,
  className = "",
  style,
  armedStyle,
  disabled,
  title,
  type = "button",
  id,
}: ConfirmButtonProps) {
  const [phase, setPhase] = useState<"idle" | "armed" | "loading">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPhase("idle");
  }, []);

  // Click outside to dismiss
  useEffect(() => {
    if (phase !== "armed") return;
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        reset();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [phase, reset]);

  const handleTriggerClick = useCallback(() => {
    if (phase === "idle") {
      setPhase("armed");
      timerRef.current = setTimeout(reset, timeout);
    }
  }, [phase, timeout, reset]);

  const handleConfirmClick = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPhase("loading");
    try {
      await onConfirm();
    } finally {
      setPhase("idle");
    }
  }, [onConfirm]);

  const isArmed = phase === "armed";
  const isLoading = phase === "loading";

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-flex" }}>
      {/* Trigger button — always stays the same size */}
      <button
        id={id}
        type={type}
        className={className}
        style={isArmed ? { ...style, ...armedStyle } : style}
        disabled={disabled || isLoading}
        title={title}
        onClick={handleTriggerClick}
      >
        {isLoading ? loadingLabel : children}
      </button>

      {/* Armed popover — floats above */}
      {isArmed && (
        <div
          className="confirm-popover"
          style={confirmStyle}
        >
          <div className="confirm-popover-label">{confirmLabel}</div>
          <div className="confirm-popover-actions">
            <button
              type="button"
              className="confirm-popover-yes"
              onClick={handleConfirmClick}
            >
              确认
            </button>
            <button
              type="button"
              className="confirm-popover-no"
              onClick={reset}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
