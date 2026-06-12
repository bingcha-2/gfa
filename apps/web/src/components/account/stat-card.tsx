import { AccountSkeleton } from "./account-ui";
import { cn } from "@/lib/utils";
import type { AccountStatusTone } from "./account-status-badge";

export type StatCardProps = {
  label: string;
  value?: string | number | null;
  sub?: string;
  icon?: React.ReactNode;
  tone?: AccountStatusTone | "primary";
  loading?: boolean;
  className?: string;
};

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = "muted",
  loading = false,
  className,
}: StatCardProps) {
  return (
    <div
      data-slot="stat-card"
      data-tone={tone}
      className={cn("account-stat-card", className)}
    >
      <div className="account-stat-card__top">
        <span data-slot="stat-label">{label}</span>
        {icon && (
          <span data-slot="stat-icon" className="account-stat-card__icon">
            {icon}
          </span>
        )}
      </div>

      {loading ? (
        <div className="account-stat-card__loading">
          <AccountSkeleton className="account-skeleton--stat-value" />
          {sub !== undefined && <AccountSkeleton className="account-skeleton--stat-sub" />}
        </div>
      ) : (
        <div className="account-stat-card__body">
          <div data-slot="stat-value">
            {value ?? "—"}
          </div>
          {sub && <div>{sub}</div>}
        </div>
      )}
    </div>
  );
}
