import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function AuthCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div
        className={cn(
          "w-full max-w-sm rounded-2xl border bg-card shadow-sm p-8 space-y-6",
          className
        )}
      >
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
