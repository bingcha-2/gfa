import { useCallback, useEffect, useState } from 'react'
import {
  Download, Upload, Cloud, CloudUpload, CloudDownload, RefreshCw, Trash2,
  Play, Square, RotateCcw, Eye, Activity, Database, History as HistoryIcon, Check, X,
} from 'lucide-react'
import {
  type WebDAVConfig, type AntigravitySwitchHistoryItem,
  exportDataBundle, importDataBundle,
  getWebDAVConfig, setWebDAVConfig, webdavUploadBackup, webdavDownloadBackup,
  antigravityStartDefault, antigravityStopDefault, antigravityRestartDefault,
  antigravityFocusDefault, antigravityRuntimeStatus,
  antigravitySwitchHistory, clearAntigravitySwitchHistory,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 数据 tab —— 本地数据迁移(导出/导入 bundle)+ WebDAV 备份同步,codex / antigravity 共用。
 * antigravity 额外:默认实例运行时控制(启/停/重启/聚焦/状态)+ 切换历史列表 + 清空。
 *
 * 红线:bundle 只打包本地配置与实例库,绝不导出远程租号 / token 出口;WebDAV 仅同步本地
 * bundle,与远程租号 / 网关出口物理隔离;运行时只控制本机 IDE 进程,切换历史只读写本地 JSON。
 * 视觉沿用 GFA token(琥珀单色、近白/深靛卡片、克制语义色、对比 ≥4.5:1),WebDAV 密码掩码
 * 展示(type=password),只用已封装的 localApi 函数。
 */

export interface LocalDataTabProps {
  /** antigravity 额外显示默认实例运行时控制 + 切换历史。codex 不显示。 */
  showAntigravity?: boolean
}

function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
      <div>
        <div className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">{icon} {title}</div>
        {desc && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

const FIELD_CLS =
  'w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 h-[32px] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]'
const BTN_CLS =
  'text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 disabled:opacity-50'

export function LocalDataTab({ showAntigravity = false }: LocalDataTabProps) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // 数据迁移 bundle
  const [exported, setExported] = useState('')
  const [importText, setImportText] = useState('')
  const [migrateMsg, setMigrateMsg] = useState('')

  // WebDAV
  const [dav, setDav] = useState<WebDAVConfig>({ enabled: false, url: '', username: '', password: '', remoteDir: 'bcai-backup' })
  const [davMsg, setDavMsg] = useState('')

  // antigravity 运行时 + 切换历史
  const [running, setRunning] = useState<boolean | null>(null)
  const [history, setHistory] = useState<AntigravitySwitchHistoryItem[]>([])

  const refreshRuntime = useCallback(async () => {
    if (!showAntigravity) return
    try {
      const [r, h] = await Promise.all([antigravityRuntimeStatus(), antigravitySwitchHistory()])
      setRunning(r)
      setHistory(h || [])
    } catch (e) {
      setErr(String(e))
    }
  }, [showAntigravity])

  const refresh = useCallback(async () => {
    try {
      setDav(await getWebDAVConfig())
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
    await refreshRuntime()
  }, [refreshRuntime])

  useEffect(() => { void refresh() }, [refresh])

  // ── 数据迁移 ──

  const onExport = async () => {
    setBusy('export'); setMigrateMsg('')
    try {
      setExported(await exportDataBundle())
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onImport = async () => {
    setBusy('import'); setMigrateMsg('')
    try {
      const n = await importDataBundle(importText)
      setMigrateMsg(`导入了 ${n} 个实例`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // ── WebDAV ──

  const onSaveDav = async () => {
    setBusy('dav-save'); setDavMsg('')
    try {
      setDav(await setWebDAVConfig(dav))
      setDavMsg('已保存')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onUpload = async () => {
    setBusy('dav-up'); setDavMsg('')
    try {
      await webdavUploadBackup()
      setDavMsg('已上传备份')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onDownload = async () => {
    setBusy('dav-down'); setDavMsg('')
    try {
      const n = await webdavDownloadBackup()
      setDavMsg(`恢复了 ${n} 个实例`)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // ── antigravity 运行时 ──

  const runtimeAction = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key)
    try {
      await fn()
      await refreshRuntime()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onClearHistory = async () => {
    setBusy('clear-history')
    try {
      await clearAntigravitySwitchHistory()
      await refreshRuntime()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      {/* 数据迁移:导出/导入本地配置 + 实例库 bundle */}
      <Section
        icon={<Database size={14} />}
        title="数据迁移"
        desc="导出「本地配置 + 实例库」为版本化 JSON,换机时粘贴还原。不含远程租号 / token。"
      >
        <div className="grid md:grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <button onClick={() => void onExport()} disabled={busy === 'export'} className={BTN_CLS}>
              <Download size={13} /> 导出
            </button>
            <textarea
              aria-label="导出的数据"
              readOnly
              value={exported}
              placeholder="点「导出」后这里出现可复制的 JSON。"
              className="h-[120px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-2 text-[11px] font-mono-data text-[var(--text-secondary)] resize-none"
            />
          </div>
          <div className="flex flex-col gap-2">
            <button onClick={() => void onImport()} disabled={busy === 'import' || !importText.trim()} className={BTN_CLS}>
              <Upload size={13} /> 导入
            </button>
            <textarea
              aria-label="待导入的数据"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="粘贴此前导出的 JSON 文本…"
              className="h-[120px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-2 text-[11px] font-mono-data text-[var(--text-primary)] resize-none"
            />
          </div>
        </div>
        {migrateMsg && <div className="text-[11px] text-[var(--success)] inline-flex items-center gap-1"><Check size={12} /> {migrateMsg}</div>}
      </Section>

      {/* WebDAV 备份同步 */}
      <Section
        icon={<Cloud size={14} />}
        title="WebDAV 同步"
        desc="把本地 bundle 同步到自有 WebDAV;仅同步本地配置/实例,与远程租号物理隔离。"
      >
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-[var(--text-secondary)]">启用 WebDAV</span>
          <button
            onClick={() => setDav({ ...dav, enabled: !dav.enabled })}
            role="switch"
            aria-checked={dav.enabled}
            aria-label="启用 WebDAV"
            className={cn('w-[42px] h-[24px] rounded-full relative transition-colors', dav.enabled ? 'bg-[var(--primary)]' : 'bg-[#cbd2dc]')}
          >
            <span className={cn('absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all', dav.enabled ? 'right-[3px]' : 'left-[3px]')} />
          </button>
        </div>
        <div className="grid md:grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
            地址
            <input aria-label="WebDAV 地址" value={dav.url} onChange={(e) => setDav({ ...dav, url: e.target.value })} placeholder="https://dav.example.com/dav" className={FIELD_CLS} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
            远程目录
            <input aria-label="WebDAV 远程目录" value={dav.remoteDir} onChange={(e) => setDav({ ...dav, remoteDir: e.target.value })} placeholder="bcai-backup" className={FIELD_CLS} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
            用户名
            <input aria-label="WebDAV 用户名" value={dav.username} onChange={(e) => setDav({ ...dav, username: e.target.value })} autoComplete="off" className={FIELD_CLS} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]">
            密码
            <input aria-label="WebDAV 密码" type="password" value={dav.password} onChange={(e) => setDav({ ...dav, password: e.target.value })} autoComplete="new-password" className={FIELD_CLS} />
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-[var(--border-light)]">
          <button onClick={() => void onSaveDav()} disabled={busy === 'dav-save'} className={cn(BTN_CLS, 'border-[var(--primary)] text-[var(--primary-strong)]')}>
            保存 WebDAV
          </button>
          <button onClick={() => void onUpload()} disabled={busy === 'dav-up'} className={BTN_CLS}>
            <CloudUpload size={13} /> 上传备份
          </button>
          <button onClick={() => void onDownload()} disabled={busy === 'dav-down'} className={BTN_CLS}>
            <CloudDownload size={13} /> 下载恢复
          </button>
          {davMsg && <span className="text-[11px] text-[var(--success)] inline-flex items-center gap-1"><Check size={12} /> {davMsg}</span>}
        </div>
      </Section>

      {/* Antigravity 额外:默认实例运行时控制 + 切换历史 */}
      {showAntigravity && (
        <>
          <Section
            icon={<Activity size={14} />}
            title="默认实例运行时"
            desc="控制本机已装 Antigravity IDE 进程(启 / 停 / 重启 / 聚焦)。"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] text-[var(--text-secondary)]">状态</span>
              {running === null ? (
                <span className="text-[12px] text-[var(--text-muted)]">—</span>
              ) : (
                <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-semibold', running ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
                  <span className={cn('w-1.5 h-1.5 rounded-full', running ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
                  {running ? '运行中' : '已停止'}
                </span>
              )}
              <button onClick={() => void refreshRuntime()} className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新状态"><RefreshCw size={13} /></button>
            </div>
            <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-[var(--border-light)]">
              <button onClick={runtimeAction('rt-start', antigravityStartDefault)} disabled={busy === 'rt-start'} className={BTN_CLS}>
                <Play size={13} /> 启动
              </button>
              <button onClick={runtimeAction('rt-stop', antigravityStopDefault)} disabled={busy === 'rt-stop'} className={BTN_CLS}>
                <Square size={13} /> 停止
              </button>
              <button onClick={runtimeAction('rt-restart', antigravityRestartDefault)} disabled={busy === 'rt-restart'} className={BTN_CLS}>
                <RotateCcw size={13} /> 重启
              </button>
              <button onClick={runtimeAction('rt-focus', antigravityFocusDefault)} disabled={busy === 'rt-focus'} className={BTN_CLS}>
                <Eye size={13} /> 聚焦窗口
              </button>
            </div>
          </Section>

          <Section icon={<HistoryIcon size={14} />} title="切换历史" desc="自有号自动/手动切换的本地记录(最近在前)。">
            <div className="flex items-center justify-end gap-2 -mt-1">
              <button onClick={() => void refreshRuntime()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新"><RefreshCw size={13} /></button>
              <button onClick={() => void onClearHistory()} disabled={busy === 'clear-history' || history.length === 0} className="text-[12px] font-semibold px-2.5 h-[28px] rounded-[8px] border border-[var(--border)] text-[var(--danger)] hover:bg-[var(--danger)]/5 inline-flex items-center gap-1.5 disabled:opacity-50">
                <Trash2 size={13} /> 清空历史
              </button>
            </div>
            {history.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">还没有切换记录。自动/手动切号后这里会出现历史。</div>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border-light)]">
                {history.slice(0, 50).map((h) => (
                  <div key={h.id} className="grid grid-cols-[auto_1fr_auto] gap-3 items-center py-1.5 text-[11px]">
                    <span className="font-mono-data text-[var(--text-muted)]">{h.timestamp ? new Date(h.timestamp).toLocaleString() : '—'}</span>
                    <span className="truncate text-[var(--text-secondary)]">
                      {h.targetEmail || h.accountId}
                      {!h.success && h.errorMessage && <span className="ml-1 text-[var(--danger)]">· {h.errorMessage}</span>}
                    </span>
                    <span className={cn('inline-flex items-center gap-1', h.success ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
                      {h.success ? <Check size={12} /> : <X size={12} />}{h.success ? '成功' : '失败'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
