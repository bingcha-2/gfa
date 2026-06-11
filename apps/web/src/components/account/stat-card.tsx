import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type StatCardProps = {
  label: string;
  value?: string | number | null;
  sub?: string;
  icon?: React.ReactNode;
  loading?: boolean;
  className?: string;
};

export function StatCard({
  label,
  value,
  sub,
  icon,
  loading = false,
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-5 flex flex-col gap-3 transition-colors",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
        {icon && (
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        )}
      </div>

      {loading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-28" />
          {sub !== undefined && <Skeleton className="h-4 w-20" />}
        </div>
      ) : (
        <div className="space-y-0.5">
          <div className="text-2xl font-semibold tabular-nums tracking-tight">
            {value ?? "—"}
          </div>
          {sub && (
            <div className="text-xs text-muted-foreground">{sub}</div>
          )}
        </div>
      )}
    </div>
  );
}
