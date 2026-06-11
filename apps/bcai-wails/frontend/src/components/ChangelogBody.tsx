/** 更新日志正文:按行拆条;多条渲染为列表,单条渲染为一段。 */
export function ChangelogBody({ text, className }: { text: string; className?: string }) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-•·*]\s*/, '').trim())
    .filter(Boolean)
  if (lines.length === 0) return null
  if (lines.length === 1) {
    return <p className={className}>{lines[0]}</p>
  }
  return (
    <ul className={className}>
      {lines.map((l, i) => (
        <li key={i} className="flex gap-1.5">
          <span className="shrink-0 select-none text-[var(--text-muted)]">·</span>
          <span>{l}</span>
        </li>
      ))}
    </ul>
  )
}
