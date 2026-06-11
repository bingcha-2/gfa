/**
 * 更新日志的本地留存:更新可用/就绪时记下 {版本, 内容},重启进入新版本后
 * 用于「更新完成 · 本次更新内容」横幅,以及设置页「更新日志」随时回看。
 */

const KEY = 'bcai_changelog'

export interface ChangelogRecord {
  version: string
  changelog: string
  /** 用户是否已在「更新完成」横幅里看过(看过则不再弹,但关于页仍可查看)。 */
  seen: boolean
}

export function getChangelogRecord(): ChangelogRecord | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const rec = JSON.parse(raw) as ChangelogRecord
    if (!rec || typeof rec.version !== 'string' || typeof rec.changelog !== 'string') return null
    return rec
  } catch {
    return null
  }
}

/** 记录(或更新)某版本的更新内容;同版本已存在时保留其 seen 状态。 */
export function rememberChangelog(version: string, changelog: string) {
  if (!version || !changelog.trim()) return
  try {
    const prev = getChangelogRecord()
    const seen = prev?.version === version ? prev.seen : false
    localStorage.setItem(KEY, JSON.stringify({ version, changelog, seen } satisfies ChangelogRecord))
  } catch { /* ignore */ }
}

export function markChangelogSeen() {
  try {
    const rec = getChangelogRecord()
    if (rec) localStorage.setItem(KEY, JSON.stringify({ ...rec, seen: true }))
  } catch { /* ignore */ }
}
