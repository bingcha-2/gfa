import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Plus, RefreshCw, Trash2, ArrowUpRight, Loader2, Download, Upload, X, Globe, KeyRound, ClipboardPaste, Pencil, ChevronDown, ChevronRight, Gauge, FolderInput, FileUp, MonitorDown, BellRing, Shuffle, Zap, CreditCard, Gift, RefreshCcw } from 'lucide-react'
import {
  type LocalAccountView, type ProviderLocalApi,
  type AlertConfig, type SwitchConfig, type AppSpeed, type ServiceTier, type ContextPreset,
  getAlertConfig, setAlertConfig, getSwitchConfig, setSwitchConfig, getAppSpeed, setAppSpeed,
  refreshCodexSubscription, getCodexResetCredits, consumeCodexResetCredit,
  codexReferralEligibility, sendCodexReferralInvites,
  type CodexSubscriptionSnapshot, type CodexResetCreditsSnapshot, type CodexReferralInviteEligibility,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/** 账号 tab(本地主功能):列表 + 登录 + 池/优先/删除 + 导入导出 + 批量多选。 */

function planBadgeClass(plan: string): string {
  if (/pro/i.test(plan)) return 'bg-[var(--primary-light)] text-[var(--primary-strong)]'
  return 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
}

function statusLabel(s: string): { text: string; cls: string } {
  switch (s) {
    case 'ok': return { text: '在线', cls: 'text-[var(--success)]' }
    case 'cooling': return { text: '冷却中', cls: 'text-[var(--warning)]' }
    case 'exhausted': return { text: '额度用尽', cls: 'text-[var(--danger)]' }
    case 'error': return { text: '需重登', cls: 'text-[var(--danger)]' }
    default: return { text: '未知', cls: 'text-[var(--text-muted)]' }
  }
}

function QuotaBar({ label, percent }: { label: string; percent: number }) {
  const p = Math.max(0, Math.min(100, percent))
  const color = p >= 90 ? 'var(--danger)' : p >= 75 ? 'var(--warning)' : 'var(--primary)'
  return (
    <div className="flex-1 min-w-[80px]">
      <div className="flex justify-between text-[10px] text-[var(--text-muted)] mb-1">
        <span>{label}</span>
        <span className="font-mono-data">{p}%</span>
      </div>
      <div className="h-[5px] rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
      </div>
    </div>
  )
}

/** 小开关(沿用 GatewayTab 的 switch 样式),受控。 */
function Toggle({ on, label, disabled, onToggle }: { on: boolean; label: string; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn('cursor-pointer w-[38px] h-[22px] rounded-full relative transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0', on ? 'bg-[var(--primary)]' : 'bg-[#cbd2dc]')}
    >
      <span className={cn('absolute top-[3px] w-[16px] h-[16px] rounded-full bg-white transition-all', on ? 'right-[3px]' : 'left-[3px]')} />
    </button>
  )
}

const SPEED_TIERS: [ServiceTier | 'custom', string][] = [
  ['standard', '默认'],
  ['fast', '快速'],
  ['custom', '自定义'],
]

/**
 * 经济与自动化条(codex 专属):超额预警(开关+阈值)、自动切号(开关)、速度档(段控+自定义上下文)。
 * 三项后端配置均为全局(非按号),故置于列表顶部一条克制的横条,不堆卡片。
 */
function EconomyBar() {
  const [alert, setAlertState] = useState<AlertConfig | null>(null)
  const [sw, setSwState] = useState<SwitchConfig | null>(null)
  const [speed, setSpeedState] = useState<AppSpeed | null>(null)
  // 段控选中态独立于服务端回显:点「自定义」即露出输入框,不被服务端归一覆盖。
  const [tierSel, setTierSel] = useState<ServiceTier | 'custom' | null>(null)
  const [thr, setThr] = useState('')
  const [ctx, setCtx] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [a, s, sp] = await Promise.all([getAlertConfig(), getSwitchConfig(), getAppSpeed()])
        setAlertState(a); setThr(String(a.thresholdPct))
        setSwState(s)
        setSpeedState(sp)
        setTierSel(sp.contextPreset === 'custom' ? 'custom' : sp.tier)
        setCtx(sp.customContextWindow ? String(sp.customContextWindow) : '')
      } catch (e) { setErr(String(e)) }
    })()
  }, [])

  const saveAlert = async (next: AlertConfig) => {
    setErr('')
    try { setAlertState(await setAlertConfig(next)) } catch (e) { setErr(String(e)) }
  }
  const saveSwitch = async (next: SwitchConfig) => {
    setErr('')
    try { setSwState(await setSwitchConfig(next)) } catch (e) { setErr(String(e)) }
  }
  const saveSpeed = async (next: AppSpeed) => {
    setErr('')
    try { setSpeedState(await setAppSpeed(next)) } catch (e) { setErr(String(e)) }
  }

  const onPickTier = (t: ServiceTier | 'custom') => {
    if (!speed) return
    setTierSel(t)
    if (t === 'custom') {
      const v = Number(ctx) || 0
      void saveSpeed({ ...speed, contextPreset: 'custom', customContextWindow: v > 0 ? v : undefined })
      return
    }
    const preset: ContextPreset = speed.contextPreset === 'custom' ? 'default' : speed.contextPreset
    void saveSpeed({ ...speed, tier: t, contextPreset: preset })
  }

  const activeTier: ServiceTier | 'custom' = tierSel ?? 'standard'

  return (
    <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
      {err && <div className="w-full text-[11px] text-[var(--danger)] break-all">{err}</div>}

      {/* 超额预警 */}
      <div className="flex items-center gap-2">
        <Toggle on={!!alert?.enabled} label="超额预警" disabled={!alert} onToggle={() => alert && void saveAlert({ ...alert, enabled: !alert.enabled })} />
        <span className="text-[12px] font-semibold text-[var(--text-secondary)] inline-flex items-center gap-1"><BellRing size={13} /> 超额预警</span>
        <input
          type="number" min={0} max={100}
          aria-label="预警阈值"
          value={thr}
          disabled={!alert}
          onChange={(e) => setThr(e.target.value)}
          onBlur={() => { if (alert) { const v = Math.max(0, Math.min(100, Number(thr) || 0)); void saveAlert({ ...alert, thresholdPct: v }) } }}
          className="w-[56px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[28px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--primary)] disabled:opacity-50"
        />
        <span className="text-[11px] text-[var(--text-muted)]">% 剩余即报</span>
      </div>

      {/* 自动切号 */}
      <div className="flex items-center gap-2">
        <Toggle on={!!sw?.enabled} label="自动切号" disabled={!sw} onToggle={() => sw && void saveSwitch({ ...sw, enabled: !sw.enabled })} />
        <span className="text-[12px] font-semibold text-[var(--text-secondary)] inline-flex items-center gap-1"><Shuffle size={13} /> 自动切号</span>
      </div>

      {/* 速度档 */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-[var(--text-secondary)] inline-flex items-center gap-1"><Zap size={13} /> 速度档</span>
        <div className="inline-flex rounded-[9px] bg-[var(--bg-tertiary)] p-0.5">
          {SPEED_TIERS.map(([t, label]) => {
            const active = activeTier === t
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                disabled={!speed}
                onClick={() => onPickTier(t)}
                className={cn('cursor-pointer text-[12px] font-semibold px-2.5 h-[26px] rounded-[7px] transition-colors disabled:opacity-50', active ? 'bg-[var(--bg-card)] text-[var(--primary-strong)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]')}
              >
                {label}
              </button>
            )
          })}
        </div>
        {activeTier === 'custom' && (
          <input
            type="number" min={1}
            aria-label="自定义上下文窗口"
            value={ctx}
            placeholder="上下文窗口"
            onChange={(e) => setCtx(e.target.value)}
            onBlur={() => { if (speed) { const v = Number(ctx) || 0; void saveSpeed({ ...speed, contextPreset: 'custom', customContextWindow: v > 0 ? v : undefined }) } }}
            className="w-[100px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[28px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--primary)]"
          />
        )}
      </div>
    </div>
  )
}

/**
 * 账号行展开区(codex 专属):刷新订阅、reset 次数(显示+消费)、邀请返利(资格+发送)。
 * 直接调按 id 的 codexbiz 函数(自有号查自己,等同额度刷新路径)。
 */
function RowExtras({ account }: { account: LocalAccountView }) {
  const id = account.id
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [sub, setSub] = useState<CodexSubscriptionSnapshot | null>(null)
  const [credits, setCredits] = useState<CodexResetCreditsSnapshot | null>(null)
  const [referral, setReferral] = useState<CodexReferralInviteEligibility | null>(null)
  const [referralOpen, setReferralOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [sent, setSent] = useState('')

  useEffect(() => {
    void (async () => {
      try { setCredits(await getCodexResetCredits(id)) } catch (e) { setErr(String(e)) }
    })()
  }, [id])

  const onRefreshSub = async () => {
    setBusy('sub'); setErr('')
    try { setSub(await refreshCodexSubscription(id)) } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }
  const onConsume = async () => {
    setBusy('consume'); setErr('')
    try { await consumeCodexResetCredit(id, ''); setCredits(await getCodexResetCredits(id)) } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }
  const onReferral = async () => {
    setBusy('referral'); setErr(''); setReferralOpen(true)
    try { setReferral(await codexReferralEligibility(id, '')) } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }
  const onSend = async () => {
    const emails = inviteEmail.split(',').map((s) => s.trim()).filter(Boolean)
    if (emails.length === 0) return
    setBusy('send'); setErr(''); setSent('')
    try {
      const res = await sendCodexReferralInvites(id, emails, '')
      setSent(`已发 ${(res.invites || []).length} 封`)
      setInviteEmail('')
    } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  const available = credits?.available_count ?? 0

  return (
    <div className="col-span-3 mt-2 rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-tertiary)]/40 px-3 py-2.5 flex flex-col gap-2.5">
      {err && <div className="text-[11px] text-[var(--danger)] break-all">{err}</div>}

      {/* 订阅 + reset 次数 */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshSub}
            disabled={busy === 'sub'}
            className="cursor-pointer text-[12px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'sub' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />} 刷新订阅
          </button>
          {sub && <span className="text-[var(--text-muted)]">{sub.PlanType || '—'} · {sub.SubscriptionActiveUntil || '—'}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-secondary)] inline-flex items-center gap-1"><CreditCard size={13} /> 主动重置:可用 {available} 次</span>
          <button
            onClick={onConsume}
            disabled={busy === 'consume' || available <= 0}
            className="cursor-pointer text-[12px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'consume' ? <Loader2 size={13} className="animate-spin" /> : null} 消费一次
          </button>
        </div>
        <button
          onClick={onReferral}
          disabled={busy === 'referral'}
          className="cursor-pointer text-[12px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {busy === 'referral' ? <Loader2 size={13} className="animate-spin" /> : <Gift size={13} />} 邀请返利
        </button>
      </div>

      {/* 邀请返利展开 */}
      {referralOpen && referral && (
        <div className="rounded-[8px] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2 flex flex-col gap-2">
          <div className="text-[11px] text-[var(--text-muted)]">
            {referral.should_show ? `可邀请 · 剩余 ${referral.remaining_referrals ?? 0} 个名额` : `当前不可邀请${referral.ineligible_reason_code ? ` · ${referral.ineligible_reason_code}` : ''}`}
          </div>
          {referral.should_show && (
            <div className="flex items-center gap-2">
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="邮箱,多个用逗号分隔"
                aria-label="邀请邮箱"
                className="flex-1 min-w-0 rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 h-[30px] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
              />
              <button
                onClick={onSend}
                disabled={busy === 'send' || !inviteEmail.trim()}
                className="cursor-pointer text-[12px] font-semibold px-3 h-[30px] rounded-[7px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {busy === 'send' ? <Loader2 size={13} className="animate-spin" /> : null} 发送邀请
              </button>
            </div>
          )}
          {sent && <div className="text-[11px] text-[var(--success)]">{sent}</div>}
        </div>
      )}
    </div>
  )
}

export function LocalAccountsTab({ title, api }: { title: string; api: ProviderLocalApi }) {
  const [accounts, setAccounts] = useState<LocalAccountView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // codex 专属经济区:用 importFromLocal 这个 codex 唯一能力作判别(antigravity 无),不污染 antigravity。
  const hasEconomy = !!api.importFromLocal
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 加号下拉 + 两种粘贴弹窗
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importInfo, setImportInfo] = useState('')
  const [addMode, setAddMode] = useState<'token' | 'apikey' | null>(null)
  const [tokRefresh, setTokRefresh] = useState('')
  const [tokAccess, setTokAccess] = useState('')
  const [tokEmail, setTokEmail] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [keyBaseUrl, setKeyBaseUrl] = useState('')
  const [keyEmail, setKeyEmail] = useState('')
  // 行内编辑(重命名/备注/标签)
  const [editing, setEditing] = useState<LocalAccountView | null>(null)
  const [editName, setEditName] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editTags, setEditTags] = useState('')

  useEffect(() => {
    if (!addMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [addMenuOpen])

  const toggleSel = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const toggleExpand = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const refresh = useCallback(async () => {
    try {
      setAccounts((await api.listAccounts()) || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  const onLogin = async () => {
    setBusy('login')
    try {
      const id = await api.startLogin()
      await api.waitLogin(id) // SDK 自动开浏览器,等回调
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try { await fn(); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  const onExport = async () => {
    setBusy('export')
    try {
      const json = await api.exportAccounts([])
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${title.toLowerCase()}-accounts.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onBatchDelete = async () => {
    if (selected.size === 0) return
    setBusy('batch')
    try {
      await api.deleteAccounts([...selected])
      setSelected(new Set())
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onImportConfirm = async () => {
    setBusy('import')
    try {
      await api.importFromJSON(importText)
      setImportOpen(false)
      setImportText('')
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // 从本机已装客户端导入(仅 codex,读 ~/.codex/auth.json)。
  const onImportFromLocal = async () => {
    if (!api.importFromLocal) return
    setBusy('import-local')
    setImportInfo('')
    try {
      const n = await api.importFromLocal()
      setImportInfo(`已从本地导入 ${n} 个账号`)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // 从已装 IDE 同步当前登录号(仅 antigravity,读 state.vscdb)。
  const onSyncFromIDE = async () => {
    if (!api.syncFromIDE) return
    setBusy('sync-ide')
    setImportInfo('')
    try {
      const n = await api.syncFromIDE()
      setImportInfo(`已从 IDE 同步 ${n} 个账号`)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // 「从文件导入」:触发隐藏 file input;选定后逐个读文本 → importAuthFiles(contents)。
  const onPickFiles = () => {
    setAddMenuOpen(false)
    fileInputRef.current?.click()
  }

  const onFilesChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!api.importAuthFiles || !files || files.length === 0) return
    setBusy('import-files')
    setImportInfo('')
    try {
      const contents = await Promise.all([...files].map((f) => f.text()))
      const n = await api.importAuthFiles(contents)
      setImportInfo(`已从文件导入 ${n} 个账号`)
      await refresh()
    } catch (err) {
      setErr(String(err))
    } finally {
      setBusy(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const onAddToken = async () => {
    setBusy('add')
    try {
      await api.addByToken(tokRefresh.trim(), tokAccess.trim(), tokEmail.trim())
      setAddMode(null)
      setTokRefresh(''); setTokAccess(''); setTokEmail('')
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onAddApiKey = async () => {
    setBusy('add')
    try {
      await api.addByApiKey(keyValue.trim(), keyBaseUrl.trim(), keyEmail.trim())
      setAddMode(null)
      setKeyValue(''); setKeyBaseUrl(''); setKeyEmail('')
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const openEdit = (a: LocalAccountView) => {
    setEditing(a)
    setEditName(a.name || '')
    setEditNote(a.note || '')
    setEditTags((a.tags || []).join(', '))
  }

  const onEditSave = async () => {
    if (!editing) return
    const id = editing.id
    const name = editName.trim()
    const note = editNote.trim()
    const tags = editTags.split(',').map((t) => t.trim()).filter(Boolean)
    setBusy('edit')
    try {
      if (name !== (editing.name || '')) await api.rename(id, name)
      if (note !== (editing.note || '')) await api.setNote(id, note)
      if (tags.join(' ') !== (editing.tags || []).join(' ')) await api.setTags(id, tags)
      setEditing(null)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}
      {importInfo && <div className="rounded-[8px] border border-[var(--success)] bg-[var(--success)]/5 px-3 py-2 text-[12px] text-[var(--success)]">{importInfo}</div>}

      {hasEconomy && <EconomyBar />}

      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
          <span className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">我的 {title} 账号 · {accounts.length}</span>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setImportOpen(true)} className="text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1" title="从 JSON 导入">
              <Upload size={12} /> 导入
            </button>
            <button onClick={onExport} disabled={busy === 'export' || accounts.length === 0} className="text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 disabled:opacity-40" title="导出全部为 JSON">
              <Download size={12} /> 导出
            </button>
            <button
              onClick={() => act('refresh-all', () => api.refreshAllQuotas())}
              disabled={busy === 'refresh-all' || accounts.length === 0}
              className="text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 disabled:opacity-40"
              title="去上游重新拉取全部在池账号额度"
            >
              {busy === 'refresh-all' ? <Loader2 size={12} className="animate-spin" /> : <Gauge size={12} />} 全部刷新额度
            </button>
            <div className="relative" ref={addMenuRef}>
              <button onClick={() => setAddMenuOpen((v) => !v)} disabled={busy === 'login'} aria-label="加号" aria-haspopup="menu" aria-expanded={addMenuOpen} className="text-[11px] font-semibold px-2.5 h-[26px] rounded-[7px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1 disabled:opacity-50">
                {busy === 'login' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} 加号 <ChevronDown size={11} />
              </button>
              {addMenuOpen && (
                <div role="menu" className="absolute right-0 mt-1 w-[176px] z-[55] rounded-[10px] border border-[var(--border)] bg-[var(--bg-card)] shadow-lg py-1 overflow-hidden">
                  <button role="menuitem" onClick={() => { setAddMenuOpen(false); void onLogin() }} className="w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <Globe size={13} className="text-[var(--text-muted)]" /> 浏览器登录
                  </button>
                  <button role="menuitem" onClick={() => { setAddMenuOpen(false); setAddMode('token') }} className="w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <ClipboardPaste size={13} className="text-[var(--text-muted)]" /> 粘贴 token
                  </button>
                  <button role="menuitem" onClick={() => { setAddMenuOpen(false); setAddMode('apikey') }} className="w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <KeyRound size={13} className="text-[var(--text-muted)]" /> 粘贴 API Key
                  </button>
                  {(api.importFromLocal || api.syncFromIDE || api.importAuthFiles) && (
                    <div className="my-1 border-t border-[var(--border-light)]" />
                  )}
                  {api.importFromLocal && (
                    <button role="menuitem" onClick={() => { setAddMenuOpen(false); void onImportFromLocal() }} className="w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <FolderInput size={13} className="text-[var(--text-muted)]" /> 从本地 ~/.codex 导入
                    </button>
                  )}
                  {api.syncFromIDE && (
                    <button role="menuitem" onClick={() => { setAddMenuOpen(false); void onSyncFromIDE() }} className="w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <MonitorDown size={13} className="text-[var(--text-muted)]" /> 从已装 IDE 同步
                    </button>
                  )}
                  {api.importAuthFiles && (
                    <button role="menuitem" onClick={onPickFiles} className="w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <FileUp size={13} className="text-[var(--text-muted)]" /> 从文件导入
                    </button>
                  )}
                </div>
              )}
              {api.importAuthFiles && (
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".json"
                  className="hidden"
                  aria-label="选择凭证文件"
                  onChange={onFilesChosen}
                />
              )}
            </div>
            <button onClick={() => void refresh()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] ml-1" title="刷新">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center justify-between px-4 py-2 bg-[var(--primary-light)] border-b border-[var(--border-light)] text-[12px]">
            <span className="text-[var(--primary-strong)] font-semibold">已选 {selected.size}</span>
            <div className="flex gap-3">
              <button onClick={() => setSelected(new Set())} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
              <button onClick={onBatchDelete} disabled={busy === 'batch'} className="text-[var(--danger)] font-semibold hover:underline disabled:opacity-50">批量删除</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
        ) : accounts.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-1">还没有本地账号</div>
            <div className="text-[12px] text-[var(--text-muted)] mb-4">登录你自己的账号,接管本地 {title},凭证只留在本机。</div>
            <button onClick={onLogin} disabled={busy === 'login'} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5">
              <Plus size={14} /> 登录新账号
            </button>
          </div>
        ) : (
          accounts.map((a) => {
            const st = statusLabel(a.quotaStatus)
            return (
              <div key={a.id} className={cn('px-4 py-3 border-t border-[var(--border-light)] first:border-t-0', a.priority && 'bg-[var(--primary-light)]')}>
                <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-center">
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} className="w-3.5 h-3.5 accent-[var(--primary)] cursor-pointer" aria-label="选择账号" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {a.priority && <ArrowUpRight size={15} className="text-[var(--primary-strong)] shrink-0" />}
                    <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">{a.name || a.email || '(未知邮箱)'}</span>
                    {a.name && a.email && <span className="text-[11px] text-[var(--text-muted)] truncate">{a.email}</span>}
                    {a.planType && <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', planBadgeClass(a.planType))}>{a.planType}</span>}
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{a.authKind === 'apikey' ? 'API Key' : 'OAuth'}</span>
                    <span className={cn('text-[11px] ml-1', st.cls)}>{st.text}</span>
                  </div>
                  <div className="flex gap-4 mt-2 max-w-[420px]">
                    <QuotaBar label="5 小时" percent={a.hourlyPercent} />
                    <QuotaBar label="本周" percent={a.weeklyPercent} />
                  </div>
                  {(a.note || (a.tags && a.tags.length > 0)) && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      {(a.tags || []).map((t) => (
                        <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[5px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t}</span>
                      ))}
                      {a.note && <span className="text-[11px] text-[var(--text-muted)] truncate">{a.note}</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => act(`quota-${a.id}`, () => api.refreshQuota(a.id))}
                    disabled={busy === `quota-${a.id}`}
                    className="text-[var(--text-muted)] hover:text-[var(--text-primary)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    aria-label="刷新额度"
                    title="去上游重新拉取该号额度"
                  >
                    {busy === `quota-${a.id}` ? <Loader2 size={13} className="animate-spin" /> : <Gauge size={13} />}
                  </button>
                  <button
                    onClick={() => openEdit(a)}
                    className="text-[var(--text-muted)] hover:text-[var(--text-primary)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--bg-hover)]"
                    aria-label="编辑账号"
                    title="重命名 / 备注 / 标签"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => act(`pool-${a.id}`, () => api.setPoolEnabled(a.id, !a.poolEnabled))}
                    disabled={busy === `pool-${a.id}`}
                    className={cn('text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border', a.poolEnabled ? 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]' : 'border-[var(--primary)] text-[var(--primary-strong)] bg-[var(--primary-light)]')}
                  >
                    {a.poolEnabled ? '移出池' : '加入池'}
                  </button>
                  <button
                    onClick={() => act(`prio-${a.id}`, () => api.setPriority(a.id))}
                    disabled={busy === `prio-${a.id}` || a.priority}
                    className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    title="设为优先出口"
                  >
                    优先
                  </button>
                  <button
                    onClick={() => act(`del-${a.id}`, () => api.deleteAccount(a.id))}
                    disabled={busy === `del-${a.id}`}
                    className="text-[var(--text-muted)] hover:text-[var(--danger)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--danger)]/10"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                  {hasEconomy && (
                    <button
                      onClick={() => toggleExpand(a.id)}
                      aria-label="更多"
                      aria-expanded={expanded.has(a.id)}
                      title="订阅 / 重置次数 / 邀请返利"
                      className="text-[var(--text-muted)] hover:text-[var(--text-primary)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--bg-hover)]"
                    >
                      {expanded.has(a.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                  )}
                </div>
                </div>
                {hasEconomy && expanded.has(a.id) && (
                  <div className="grid grid-cols-[auto_1fr_auto]">
                    <RowExtras account={a} />
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {importOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setImportOpen(false)}>
          <div className="w-[460px] max-w-[90vw] rounded-[12px] bg-[var(--bg-card)] border border-[var(--border)] shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-[var(--text-primary)]">从 JSON 导入账号</span>
              <button onClick={() => setImportOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={15} /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mb-2">粘贴导出的 JSON,按邮箱去重(已存在的自动跳过)。</div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              placeholder='[{"email":"you@example.com","authKind":"oauth","refreshToken":"..."}]'
              className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 text-[12px] font-mono-data text-[var(--text-primary)] resize-none"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setImportOpen(false)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
              <button onClick={onImportConfirm} disabled={busy === 'import' || !importText.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">导入</button>
            </div>
          </div>
        </div>
      )}

      {addMode === 'token' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setAddMode(null)}>
          <div className="w-[460px] max-w-[90vw] rounded-[12px] bg-[var(--bg-card)] border border-[var(--border)] shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-[var(--text-primary)]">粘贴 OAuth Token 加号</span>
              <button onClick={() => setAddMode(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={15} /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mb-3">自备已登录账号的 OAuth 令牌,凭证只留在本机。</div>
            <div className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">Refresh Token
                <input aria-label="Refresh Token" value={tokRefresh} onChange={(e) => setTokRefresh(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">Access Token
                <input aria-label="Access Token" value={tokAccess} onChange={(e) => setTokAccess(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">邮箱(可选)
                <input aria-label="邮箱(可选)" value={tokEmail} onChange={(e) => setTokEmail(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)]" />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setAddMode(null)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
              <button onClick={onAddToken} disabled={busy === 'add' || !tokRefresh.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">添加账号</button>
            </div>
          </div>
        </div>
      )}

      {addMode === 'apikey' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setAddMode(null)}>
          <div className="w-[460px] max-w-[90vw] rounded-[12px] bg-[var(--bg-card)] border border-[var(--border)] shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-[var(--text-primary)]">粘贴 API Key 加号</span>
              <button onClick={() => setAddMode(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={15} /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mb-3">自备 API Key,凭证只留在本机。</div>
            <div className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">API Key
                <input aria-label="API Key" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">Base URL(可选)
                <input aria-label="Base URL(可选)" value={keyBaseUrl} onChange={(e) => setKeyBaseUrl(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">邮箱(可选)
                <input aria-label="邮箱(可选)" value={keyEmail} onChange={(e) => setKeyEmail(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)]" />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setAddMode(null)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
              <button onClick={onAddApiKey} disabled={busy === 'add' || !keyValue.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">添加账号</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setEditing(null)}>
          <div className="w-[460px] max-w-[90vw] rounded-[12px] bg-[var(--bg-card)] border border-[var(--border)] shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-[var(--text-primary)]">编辑账号</span>
              <button onClick={() => setEditing(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={15} /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mb-3 truncate">{editing.email || editing.id}</div>
            <div className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">名称
                <input aria-label="名称" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="留空则显示邮箱" className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">备注
                <input aria-label="备注" value={editNote} onChange={(e) => setEditNote(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)]" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">标签(逗号分隔)
                <input aria-label="标签(逗号分隔)" value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="主力, 备用" className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)]" />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setEditing(null)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
              <button onClick={onEditSave} disabled={busy === 'edit'} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
