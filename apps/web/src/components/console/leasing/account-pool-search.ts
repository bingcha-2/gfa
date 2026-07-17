export type SearchableAccountPool = {
  id: number;
  email: string;
  alias?: string;
  quotaPool?: { boundCustomerEmails?: string[] };
};

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function boundCustomerEmailMatches(
  account: SearchableAccountPool,
  query: string,
): string[] {
  const needle = normalize(query);
  if (!needle) return [];
  return (account.quotaPool?.boundCustomerEmails || [])
    .filter((email) => normalize(email).includes(needle));
}

export function matchesAccountPoolSearch(
  account: SearchableAccountPool,
  query: string,
): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  return normalize(account.email).includes(needle)
    || normalize(account.alias).includes(needle)
    || String(account.id) === needle.replace(/^#/, "")
    || boundCustomerEmailMatches(account, needle).length > 0;
}

export function filterAccountPools<T extends SearchableAccountPool>(accounts: T[], query: string): T[] {
  return accounts.filter((account) => matchesAccountPoolSearch(account, query));
}
