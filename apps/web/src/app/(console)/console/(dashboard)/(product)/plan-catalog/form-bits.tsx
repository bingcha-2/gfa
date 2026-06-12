"use client";

// 套餐配置表单的小型受控输入件(复用于各 section,统一样式)。
//   - YuanInput:元价格输入框(带 ¥ 前缀,允许负数用于折扣)。
//   - NumberInput:整数输入框(token / 设备 / 天 等,可带后缀单位)。
// 都是受控:value 为字符串,onChange 回传原始字符串(允许「清空」中间态),
// 由上层 formToConfig 在组装时解析。

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface YuanInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 允许负数(绑定线共享折扣常为负)。默认 false。 */
  allowNegative?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function YuanInput({
  value,
  onChange,
  disabled,
  allowNegative,
  className,
  "aria-label": ariaLabel,
}: YuanInputProps) {
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        ¥
      </span>
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min={allowNegative ? undefined : 0}
        className="h-8 pl-6 text-sm"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  min?: number;
  placeholder?: string;
  /** 右侧单位后缀,如 "天" / "tokens"。 */
  suffix?: string;
  className?: string;
  "aria-label"?: string;
}

export function NumberInput({
  value,
  onChange,
  disabled,
  min = 0,
  placeholder,
  suffix,
  className,
  "aria-label": ariaLabel,
}: NumberInputProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        className="h-8 text-sm"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
      {suffix && (
        <span className="whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>
      )}
    </div>
  );
}
