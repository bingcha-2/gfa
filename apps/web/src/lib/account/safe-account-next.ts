export function safeAccountNext(value: string | null | undefined): string {
  if (!value || value.startsWith("//")) return "/account";

  try {
    const parsed = new URL(value, "https://my.bcai.lol");
    if (parsed.origin !== "https://my.bcai.lol") return "/account";
    if (parsed.pathname !== "/account" && !parsed.pathname.startsWith("/account/")) {
      return "/account";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/account";
  }
}
