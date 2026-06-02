import type { BindableAccount } from "@/components/BindAccountControl";

interface RawAccount {
  id: number;
  email: string;
  usedShares?: number;
  shareCapacity?: number;
}

/**
 * Merge the codex and antigravity account-pool API shapes into a single
 * provider-tagged list for BindAccountControl. Codex first (the pool sold
 * first), then antigravity.
 */
export function toBindableAccounts(
  codex: RawAccount[] | undefined,
  antigravity: RawAccount[] | undefined,
): BindableAccount[] {
  const tag = (list: RawAccount[] | undefined, provider: string): BindableAccount[] =>
    (list || []).map((a) => ({
      provider,
      id: Number(a.id),
      email: String(a.email || ""),
      usedShares: Number(a.usedShares || 0),
      shareCapacity: Number(a.shareCapacity || 0) > 0 ? Number(a.shareCapacity) : 4,
    }));
  return [...tag(codex, "codex"), ...tag(antigravity, "antigravity")];
}
