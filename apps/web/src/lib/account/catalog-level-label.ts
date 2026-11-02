/** Business names only; preserve persisted IDs, purchase prices and entitlements. */
export function catalogLevelLabel(product: string, level: string, fallback = level, locale = 'zh') {
  if (product !== 'anthropic') return fallback;
  const labels: Record<string, [string, string]> = {
    pro: ['基础版', 'Basic'], 'max-5x': ['标准版', 'Standard'],
    'max-20x': ['高配版', 'Premium'], ultra: ['高配版', 'Premium'],
  };
  return labels[level]?.[locale.startsWith('en') ? 1 : 0] ?? fallback;
}
