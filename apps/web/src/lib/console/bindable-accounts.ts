/** 产品绑定下拉用的账号(provider 标签 + 份额信息)。结构对齐 rosetta-keys/types.ts 的同名接口。 */
interface BindableAccount {
  provider: string;
  id: number;
  email: string;
  usedShares: number;
  shareCapacity: number;
  planType?: string;
}

interface RawAccount {
  id: number;
  email: string;
  usedShares?: number;
  shareCapacity?: number;
  planType?: string;
}

/**
 * Merge the codex, antigravity and claude account-pool API shapes into a single
 * provider-tagged list for the rosetta-keys binding pickers. Codex first (the
 * pool sold first), then antigravity, then claude.
 */
export function toBindableAccounts(
  codex: RawAccount[] | undefined,
  antigravity: RawAccount[] | undefined,
  claude?: RawAccount[] | undefined,
): BindableAccount[] {
  const tag = (list: RawAccount[] | undefined, provider: string): BindableAccount[] =>
    (list || []).map((a) => ({
      provider,
      id: Number(a.id),
      email: String(a.email || ""),
      usedShares: Number(a.usedShares || 0),
      shareCapacity: Number(a.shareCapacity || 0) > 0 ? Number(a.shareCapacity) : 8,
      planType: String(a.planType || ""),
    }));
  return [...tag(codex, "codex"), ...tag(antigravity, "antigravity"), ...tag(claude, "anthropic")];
}
