export type SubProductRow = {
  product: string;
  level: string | null;
  accountId: number | null;
  bound: boolean;
};

export type SubscriptionView = {
  line: "bind" | "pool";
  rows: SubProductRow[];
  weight: number;
  deviceLimit: number;
  usageTier: string | null;
};

function safeParse(json: string | null): Record<string, any> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function buildSubscriptionView(input: { config: string | null }): SubscriptionView {
  const c = safeParse(input.config);
  if (!c) return { line: "pool", rows: [], weight: 1, deviceLimit: 1, usageTier: null };

  const products: string[] = Array.isArray(c.products) ? c.products.map(String) : [];
  const line: "bind" | "pool" = c.line === "bind" ? "bind" : "pool";
  const levels = (c.levels && typeof c.levels === "object" ? c.levels : {}) as Record<string, string>;
  const bindings = (c.bindings && typeof c.bindings === "object" ? c.bindings : {}) as Record<string, number>;

  const rows: SubProductRow[] = products.map((product) => {
    const accountId = line === "bind" ? Number(bindings[product]) || null : null;
    return {
      product,
      level: line === "bind" ? (levels[product] ? String(levels[product]) : null) : null,
      accountId: accountId && accountId > 0 ? accountId : null,
      bound: line === "bind" && accountId != null && accountId > 0,
    };
  });

  return {
    line,
    rows,
    weight: Math.max(1, Math.floor(Number(c.weight) || 1)),
    deviceLimit: Math.max(1, Math.floor(Number(c.deviceLimit) || 1)),
    usageTier: line === "pool" && c.usageTier ? String(c.usageTier) : null,
  };
}
