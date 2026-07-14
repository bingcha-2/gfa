/** 把恢复剩余毫秒格式化成短时长；≥24h 显示天，≤0 返回空串。 */
export function formatResetDuration(ms: number): string {
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin <= 0) return ''
  if (totalMin >= 24 * 60) {
    const days = Math.floor(totalMin / (24 * 60))
    const hours = Math.floor((totalMin % (24 * 60)) / 60)
    return hours > 0 ? `${days}天${hours}h` : `${days}天`
  }
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** 用户血条只展示剩余比例。无有效上限时按 100% 处理；超额时钳制为 0%。 */
export function quotaRemainingPercent(used: number, limit: number): number {
  const normalizedLimit = Math.max(0, Number(limit) || 0)
  if (normalizedLimit <= 0) return 100
  const normalizedUsed = Math.max(0, Number(used) || 0)
  return Math.max(0, Math.min(100, Math.round((1 - normalizedUsed / normalizedLimit) * 100)))
}
