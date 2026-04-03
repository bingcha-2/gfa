"use client";

import { useState, useRef, useCallback, type ReactNode, type CSSProperties } from "react";

type ConfirmButtonProps = {
  /** Label shown in the default (idle) state */
  children: ReactNode;
  /** Label shown when armed (awaiting second click). Defaults to "确定？" */
  confirmLabel?: ReactNode;
  /** Label shown while the action is executing */
  loadingLabel?: ReactNode;
  /** The async action to execute on confirmation */
  onConfirm: () => Promise<unknown> | void;
  /** How long (ms) the armed state lasts before auto-resetting. Default 3000 */
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
 * - 1st click  → enters "armed" state (shows confirmLabel, pulses)
 * - 2nd click  → executes onConfirm()
 * - Auto-resets after `timeout` ms if the 2nd click doesn't happen
 *
 * Replaces `window.confirm()` which is unreliable when browser extensions
 * interfere with dialog APIs.
 */
export function ConfirmButton({
  children,
  confirmLabel = "确定？",
  loadingLabel = "执行中...",
  onConfirm,
  timeout = 3000,
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

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPhase("idle");
  }, []);

  const handleClick = useCallback(async () => {
    if (phase === "idle") {
      setPhase("armed");
      timerRef.current = setTimeout(reset, timeout);
      return;
    }

    if (phase === "armed") {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setPhase("loading");
      try {
        await onConfirm();
      } finally {
        setPhase("idle");
      }
    }
  }, [phase, onConfirm, timeout, reset]);

  const isArmed = phase === "armed";
  const isLoading = phase === "loading";

  const mergedClassName = [
    className,
    isArmed ? "armed" : "",
  ].filter(Boolean).join(" ");

  const mergedStyle = isArmed && armedStyle
    ? { ...style, ...armedStyle }
    : style;

  return (
    <button
      id={id}
      type={type}
      className={mergedClassName}
      style={mergedStyle}
      disabled={disabled || isLoading}
      title={title}
      onClick={handleClick}
    >
      {isLoading ? loadingLabel : isArmed ? confirmLabel : children}
    </button>
  );
}
