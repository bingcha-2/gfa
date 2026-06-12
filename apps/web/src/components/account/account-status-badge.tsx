import { cn } from "@/lib/utils";

export type AccountStatusTone =
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "muted";

export function AccountStatusBadge({
  tone = "muted",
  className,
  children,
}: {
  tone?: AccountStatusTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      data-tone={tone}
      className={cn("account-status-badge", className)}
    >
      <span data-slot="status-dot" aria-hidden />
      {children}
    </span>
  );
}
