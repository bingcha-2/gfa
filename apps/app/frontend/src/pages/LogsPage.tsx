import { useEffect, useRef, useState } from 'react'
import { useLogStore, type LogFilter } from '@/stores/useLogStore'
import { LogLine } from '@/components/LogLine'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { exportDiagnosticBundle, repairCodexAuth } from '@/services/wails'
import { Modal, useModal } from '@/components/Modal'
import { AlertCircle, CheckCircle2, Copy, Download, Filter, FolderOpen, KeyRound, Loader2, Pause, Play, Search, Trash2 } from 'lucide-react'

export function LogsPage() {
  const t = useT()
  const { filter, searchQuery, setFilter, setSearchQuery, clearLogs, getFilteredLogs, logs } = useLogStore()
  const { modalProps, showConfirm } = useModal()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [repairingAuth, setRepairingAuth] = useState(false)
  const [exportNotice, setExportNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const filters: { id: LogFilter; label: string }[] = [
    { id: 'all', label: t('logs.filterAll') },
    { id: 'error', label: t('logs.filterError') },
    { id: 'warn', label: t('logs.filterWarn') },
    { id: 'proxy', label: t('logs.filterProxy') },
    { id: 'inject', label: t('logs.filterInject') },
  ]
  const filteredLogs = getFilteredLogs()

  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [follow, logs.length])

  const handleCopyLogs = () => navigator.clipboard.writeText(filteredLogs.map((log) => log.raw).join('\n'))

  const handleExportDiagnostics = async () => {
    if (exporting) return
    setExporting(true)
    setExportNotice(null)
    try {
      const path = await exportDiagnosticBundle()
      if (path) setExportNotice({ kind: 'success', message: t('logs.exportSuccess', { path }) })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setExportNotice({ kind: 'error', message: t('logs.exportFailed', { error: detail }) })
    } finally {
      setExporting(false)
    }
  }

  const handleRepairCodexAuth = async () => {
    if (repairingAuth) return
    setRepairingAuth(true)
    const confirmed = await showConfirm(t('logs.repairAuthConfirmTitle'), t('logs.repairAuthConfirmBody'), {
      confirmLabel: t('logs.repairAuthConfirm'),
      cancelLabel: t('logs.repairAuthCancel'),
    })
    if (!confirmed) {
      setRepairingAuth(false)
      return
    }
    setExportNotice(null)
    try {
      const result = await repairCodexAuth()
      const keychainPresent = result.startsWith('removed-keychain-present:')
      const backupPath = keychainPresent ? result.slice('removed-keychain-present:'.length) : result
      const message = result === 'restored-managed'
        ? t('logs.repairAuthRestored')
        : result === 'missing'
          ? t('logs.repairAuthMissing')
          : keychainPresent
            ? t('logs.repairAuthKeychainPresent', { path: backupPath })
            : t('logs.repairAuthSuccess', { path: backupPath })
      setExportNotice({ kind: 'success', message })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setExportNotice({ kind: 'error', message: t('logs.repairAuthFailed', { error: detail }) })
    } finally {
      setRepairingAuth(false)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[1080px] flex-col gap-4 pt-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">{t('nav.logs')}</h2>
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">{t('logs.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={exporting} onClick={() => void handleExportDiagnostics()}>
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {exporting ? t('logs.exporting') : t('logs.exportBundle')}
          </Button>
          <Button size="sm" variant="secondary" disabled={repairingAuth} onClick={() => void handleRepairCodexAuth()}>
            {repairingAuth ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {repairingAuth ? t('logs.repairingAuth') : t('logs.repairAuth')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setFollow((value) => !value)}>
            {follow ? <Pause size={13} /> : <Play size={13} />}
            {follow ? t('logs.pause') : t('logs.resume')}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleCopyLogs}><Copy size={13} />{t('logs.copy')}</Button>
          <Button size="sm" variant="secondary" onClick={clearLogs}><Trash2 size={13} />{t('logs.clear')}</Button>
        </div>
      </div>
      {exportNotice && (
        <div
          role={exportNotice.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-[11px]',
            exportNotice.kind === 'error'
              ? 'border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] text-[var(--danger)]'
              : 'border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] text-[var(--text-secondary)]'
          )}
        >
          {exportNotice.kind === 'error' ? <AlertCircle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--success)]" />}
          <span className="break-all">{exportNotice.message}</span>
        </div>
      )}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('logs.searchPlaceholder')}
              className="h-8 pl-8 text-[12px]"
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] p-1">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={cn(
                  'rounded-[6px] px-2.5 py-1 text-[11px] font-semibold transition-colors',
                  filter === item.id
                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="flex items-center gap-1.5 px-1.5 text-[11px] text-[var(--text-muted)]">
            <i className={cn('h-1.5 w-1.5 rounded-full', follow ? 'bg-[var(--success)]' : 'bg-[var(--warning)]')} />
            {follow ? t('logs.following') : t('logs.paused')}
          </span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-tertiary)] py-2 font-mono">
          {filteredLogs.length === 0
            ? <div className="grid h-full place-items-center text-[12px] text-[var(--text-muted)]">{t('logs.empty')}</div>
            : filteredLogs.map((log, index) => <LogLine key={index} log={log} terminal />)}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5"><Filter size={11} />{t('logs.visible', { count: filteredLogs.length })} · desktop.log</span>
          <span className="flex items-center gap-1"><FolderOpen size={11} />{t('logs.localOnly')}</span>
        </div>
      </section>
      <Modal {...modalProps} />
    </div>
  )
}
