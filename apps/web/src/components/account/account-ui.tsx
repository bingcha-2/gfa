import { cn } from "@/lib/utils";

export function AccountButton({
  variant = "primary",
  className,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button
      className={cn("account-btn", `account-btn--${variant}`, className)}
      {...props}
    />
  );
}

export function AccountInput({
  label,
  error,
  className,
  ...props
}: React.ComponentProps<"input"> & {
  label: string;
  error?: string | null;
}) {
  return (
    <label className="account-field">
      <span className="account-field__label">{label}</span>
      <input className={cn("account-input", className)} aria-invalid={!!error} {...props} />
      {error && <span className="account-field__error">{error}</span>}
    </label>
  );
}

export function AccountTextarea({
  label,
  error,
  className,
  ...props
}: React.ComponentProps<"textarea"> & {
  label: string;
  error?: string | null;
}) {
  return (
    <label className="account-field">
      <span className="account-field__label">{label}</span>
      <textarea className={cn("account-textarea", className)} aria-invalid={!!error} {...props} />
      {error && <span className="account-field__error">{error}</span>}
    </label>
  );
}

export function AccountPill({
  tone = "muted",
  className,
  children,
}: {
  tone?: "success" | "warning" | "danger" | "info" | "muted" | "brand";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("account-pill", className)} data-tone={tone}>
      <span className="account-pill__dot" aria-hidden />
      {children}
    </span>
  );
}

export function AccountSkeleton({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return <span data-slot="skeleton" className={cn("account-skeleton", className)} {...props} />;
}

export function AccountEmpty({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("account-empty", className)}>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {children && <div className="account-empty__actions">{children}</div>}
    </div>
  );
}
