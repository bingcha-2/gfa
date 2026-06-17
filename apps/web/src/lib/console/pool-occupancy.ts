export function isOversold(usedShares: number, shareCapacity: number): boolean {
  return Number(usedShares) > Number(shareCapacity);
}

export function filterOversold<T extends { usedShares?: number; shareCapacity?: number }>(accts: T[]): T[] {
  return accts.filter((a) => isOversold(Number(a.usedShares || 0), Number(a.shareCapacity || 0)));
}
