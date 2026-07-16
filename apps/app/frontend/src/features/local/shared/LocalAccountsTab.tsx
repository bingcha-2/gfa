import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Plus, RefreshCw, Trash2, Loader2, Download, Upload, Globe, KeyRound, ClipboardPaste, Pencil, ChevronDown, ChevronRight, Gauge, FolderInput, FileUp, MonitorDown, BellRing, Shuffle, CreditCard, Gift, RefreshCcw, ChevronUp, FolderPlus, CheckCircle2, Coffee, CircleAlert, RotateCcw, Search, Users } from 'lucide-react'
import {
  type LocalAccountView, type ProviderLocalApi,
  type AlertConfig, type SwitchConfig,
  getAlertConfig, setAlertConfig, getSwitchConfig, setSwitchConfig,
  refreshCodexSubscription, getCodexResetCredits, consumeCodexResetCredit,
  codexReferralEligibility, sendCodexReferralInvites,
  type CodexSubscriptionSnapshot, type CodexResetCreditsSnapshot, type CodexReferralInviteEligibility,
  type AccountGroup,
  listAccountGroups, createAccountGroup, resolveAccountGroups,
  assignAccountsToGroup, removeAccountsFromGroup,
  setCurrentAccount, reorderAccounts,
} from '@/services/localApi'
import { cn } from '@/lib/utils'
import { Modal, useModal } from '@/components/Modal'
import { PortalMenu, KebabMenu } from '@/components/PortalMenu'
import { RewardModal } from '@/components/RewardModal'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ClipboardGetText } from '../../../../wailsjs/runtime/runtime'

/** 账号 tab(本地主功能):列表 + 登录 + 池/优先/删除 + 导入导出 + 批量多选。 */

type LoginPhase = 'idle' | 'starting' | 'waiting' | 'submitting' | 'success' | 'error'
type AccountViewFilter = 'all' | 'pool' | 'attention'

function planBadgeClass(plan: string): string {
  if (/pro/i.test(plan)) return 'bg-[var(--primary-light)] text-[var(--primary-strong)]'
  return 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
}

function statusLabel(s: string): { text: string; cls: string } {
  switch (s) {
    case 'ok': return { text: '在线', cls: 'text-[var(--success-strong)] font-medium' }
    case 'cooling': return { text: '冷却中', cls: 'text-[var(--warning-deep)] font-medium' }
    case 'exhausted': return { text: '额度用尽', cls: 'text-[var(--danger)] font-medium' }
    case 'error': return { text: '需重登', cls: 'text-[var(--danger)] font-medium' }
    default: return { text: '未知', cls: 'text-[var(--text-muted)]' }
  }
}

/**
 * 紧凑内联额度条:标签 · 短条 · 数字 三者贴在一起,避免 justify-between 把数字甩到半空。
 * percent 是「剩余额度%」(越高越健康,满血=100):剩余越少越红。绿=健康 / 琥珀=告急 / 红=将尽。
 * 数字色只在告急/将尽时上色,健康态保持安静,让视线自动落到有问题的号。
 */
function QuotaBar({ label, percent }: { label: string; percent: number }) {
  const p = Math.max(0, Math.min(100, percent))
  const indicatorClass = p <= 10 ? 'bg-[var(--danger)]' : p <= 25 ? 'bg-[var(--warning)]' : 'bg-[var(--success-strong)]'
  const numColor = p <= 10 ? 'var(--danger)' : p <= 25 ? 'var(--warning-deep)' : 'var(--text-secondary)'
  return (
    <div className="grid grid-cols-[72px_64px_34px] items-center gap-2 whitespace-nowrap">
      <span className="text-[11px] text-[var(--text-muted)] truncate">{label}</span>
      <Progress value={p} aria-label={`${label}剩余 ${p}%`} className="h-[5px]" indicatorClassName={indicatorClass} />
      <span className="text-[11px] font-mono-data tabular-nums" style={{ color: numColor }}>{p}%</span>
    </div>
  )
}

export function visibleDefaultQuotaWindows(provider: 'codex' | 'antigravity', hourlyPercent: number, weeklyPercent: number) {
  const windows = [
    { label: '5 小时', percent: hourlyPercent },
    { label: '本周', percent: weeklyPercent },
  ]
  return provider === 'codex' ? windows.filter((window) => window.percent >= 0) : windows
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
      className={cn('cursor-pointer w-[38px] h-[22px] rounded-full relative transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0', on ? 'bg-[var(--primary)]' : 'bg-[var(--switch-off)]')}
    >
      <span className={cn('absolute top-[3px] w-[16px] h-[16px] rounded-full bg-white transition-all', on ? 'right-[3px]' : 'left-[3px]')} />
    </button>
  )
}

/**
 * 经济与自动化条(codex 专属):超额预警(开关+阈值)、自动切号(开关)。
 * 两项后端配置均为全局(非按号),故置于列表顶部一条克制的横条,不堆卡片。
 * (原「速度档」已删除——Codex 自身就有官方入口调这个,GFA 重复一份徒增一个「改完要重启客户端
 * 才生效」的隐藏坑,见 local-takeover-branch-state 记忆。)
 */
function EconomyBar() {
  const [alert, setAlertState] = useState<AlertConfig | null>(null)
  const [sw, setSwState] = useState<SwitchConfig | null>(null)
  const [thr, setThr] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [a, s] = await Promise.all([getAlertConfig(), getSwitchConfig()])
        setAlertState(a); setThr(String(a.thresholdPct))
        setSwState(s)
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

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[var(--border-light)] px-4 py-2.5">
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
    </div>
  )
}

/**
 * 「名额用尽」类不可邀请原因:此时上游 should_show=false,但仍允许发送邀请
 * (只是本次不再获得奖励/重置名额)。对齐 cockpit isCodexReferralLimitReached。
 */
function isReferralLimitReached(r: CodexReferralInviteEligibility | null): boolean {
  const code = r?.ineligible_reason_code
  return code === 'user_limit_reached' || code === 'workspace_limit_reached'
}

/**
 * 是否放出邀请输入框:should_show=true,或虽 false 但属「名额用尽」(仍可发)。
 * 对齐 cockpit shouldShowCodexReferralInvite —— GFA 旧版只认 should_show,
 * 导致奖励名额用尽的号被整段隐藏、显示「当前不可邀请」而无法发送。
 */
function canSendReferral(r: CodexReferralInviteEligibility | null): boolean {
  return Boolean(r?.should_show) || isReferralLimitReached(r)
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
    <div className="col-span-4 mt-2 rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-tertiary)]/40 px-3 py-2.5 flex flex-col gap-2.5">
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
          {sub && <span className="text-[var(--text-muted)]">{sub.PlanType || '-'} / {sub.SubscriptionActiveUntil || '-'}</span>}
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
            {referral.should_show
              ? `可邀请 · 剩余 ${referral.remaining_referrals ?? 0} 个名额`
              : isReferralLimitReached(referral)
                ? '奖励名额已用完，仍可发送邀请，但本次不再获得奖励或重置名额。'
                : `当前不可邀请${referral.ineligible_reason_code ? ` · ${referral.ineligible_reason_code}` : ''}`}
          </div>
          {canSendReferral(referral) && (
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
  const [notice, setNotice] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // OAuth 登录 UI 与 loginId 解耦:失败后弹窗和用户输入必须保留,不能因会话结束而卸载。
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle')
  const [loginId, setLoginId] = useState<string | null>(null)
  const [callbackURL, setCallbackURL] = useState('')
  const [loginError, setLoginError] = useState('')
  const loginAttemptRef = useRef(0)
  // codex 专属经济区:用 importFromLocal 这个 codex 唯一能力作判别(antigravity 无),不污染 antigravity。
  const hasEconomy = !!api.importFromLocal
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 加号下拉 + 两种粘贴弹窗
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importInfo, setImportInfo] = useState('')
  const [addMode, setAddMode] = useState<'token' | 'apikey' | null>(null)
  const [tokRefresh, setTokRefresh] = useState('')
  const [tokAccess, setTokAccess] = useState('')
  const [tokEmail, setTokEmail] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [keyBaseUrl, setKeyBaseUrl] = useState('')
  const [keyEmail, setKeyEmail] = useState('')
  // 行内编辑(重命名/备注/标签/分组)
  const [editing, setEditing] = useState<LocalAccountView | null>(null)
  const [editName, setEditName] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editGroup, setEditGroup] = useState('')
  // 账号组织:分组列表 + 归属映射(accountId→groupId)+ 当前筛选 + 新建组弹窗
  const [groups, setGroups] = useState<AccountGroup[]>([])
  const [groupOf, setGroupOf] = useState<Record<string, string>>({})
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const [viewFilter, setViewFilter] = useState<AccountViewFilter>('all')
  const [query, setQuery] = useState('')
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  // 破坏性操作确认(删除凭证不可逆)。
  const { modalProps, showConfirm } = useModal()
  // 赞赏作者弹窗。
  const [rewardOpen, setRewardOpen] = useState(false)

  // provider 取号视角:优先取已加载账号的 provider,空列表回退到 title(codex/antigravity)。
  const provider: 'codex' | 'antigravity' =
    accounts[0]?.provider === 'antigravity' || title.toLowerCase() === 'antigravity' ? 'antigravity' : 'codex'

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

  const refreshGroups = useCallback(async () => {
    try {
      const [gs, map] = await Promise.all([listAccountGroups(), resolveAccountGroups()])
      setGroups(gs || [])
      setGroupOf(map || {})
    } catch {
      // 分组只是组织视图,失败不打断账号管理。
    }
  }, [])

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

  useEffect(() => { void refresh(); void refreshGroups() }, [refresh, refreshGroups])

  const onLogin = async () => {
    const attempt = ++loginAttemptRef.current
    setLoginOpen(true)
    setLoginPhase('starting')
    setLoginId(null)
    setLoginError('')
    setCallbackURL('')
    try {
      const id = await api.startLogin()
      if (attempt !== loginAttemptRef.current) {
        if (api.cancelLogin) void api.cancelLogin(id).catch(() => {})
        return
      }
      setLoginId(id)
      setLoginPhase('waiting')
      // 后台等自动回调。失败时只结束本次会话,弹窗、错误和用户已粘贴的 URL 都保留。
      api.waitLogin(id).then(async () => {
        if (attempt !== loginAttemptRef.current) return
        loginAttemptRef.current += 1
        setLoginId(null)
        setLoginPhase('success')
        setLoginError('')
        await refresh()
      }).catch((e) => {
        if (attempt !== loginAttemptRef.current) return
        loginAttemptRef.current += 1
        setLoginId(null)
        setLoginPhase('error')
        setLoginError(String(e).replace(/^Error:\s*/, ''))
      })
    } catch (e) {
      if (attempt !== loginAttemptRef.current) return
      setLoginId(null)
      setLoginPhase('error')
      setLoginError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const onSubmitCallback = async () => {
    if (!loginId || !callbackURL.trim() || !api.submitLoginCallback) return
    const attempt = loginAttemptRef.current
    const id = loginId
    setLoginPhase('submitting')
    setLoginError('')
    try {
      await api.submitLoginCallback(id, callbackURL.trim())
      if (attempt !== loginAttemptRef.current) return
      // 提交只是把 URL 交给后端,真正的 code 换 token 仍由 waitLogin 完成。
      setLoginPhase('waiting')
    } catch (e) {
      if (attempt !== loginAttemptRef.current) return
      setLoginPhase('error')
      setLoginError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const closeLogin = async () => {
    const id = loginId
    loginAttemptRef.current += 1
    setLoginOpen(false)
    setLoginId(null)
    setLoginPhase('idle')
    setLoginError('')
    setCallbackURL('')
    if (!id || !api.cancelLogin) return
    try {
      await api.cancelLogin(id)
    } catch (e) {
      setErr(String(e))
    }
  }

  const onRetryLogin = async () => {
    const id = loginId
    if (id && api.cancelLogin) {
      try { await api.cancelLogin(id) } catch { /* 旧会话可能已经结束,不阻断重试。 */ }
    }
    void onLogin()
  }

  const onPasteCallback = async () => {
    setLoginError('')
    try {
      // Wails 原生剪贴板不依赖 WebView 的权限策略;开发预览再回退到浏览器 API。
      let text = ''
      try { text = await ClipboardGetText() } catch { text = await navigator.clipboard.readText() }
      if (!text.trim()) {
        setLoginError('剪贴板里没有可用文本。')
        return
      }
      setCallbackURL(text.trim())
    } catch {
      setLoginError('无法读取剪贴板,请在输入框中手动粘贴。')
    }
  }

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try { await fn(); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  // 全部刷新额度:逐号刷【全部】自有号(含未在池),回带成功数并给出可见反馈。
  // 后端单号失败不中断(只回成功计数),故这里对比可刷新号总数(API Key 号不支持刷新、
  // 不计入分母),明确「刷了几个/几个失败」,避免「点了没反应/没变化」。
  const onRefreshAll = async () => {
    setBusy('refresh-all'); setErr(''); setNotice('')
    try {
      const refreshable = accounts.filter((a) => a.authKind !== 'apikey').length
      const ok = await api.refreshAllQuotas()
      await refresh()
      if (refreshable === 0) setNotice('没有可刷新的账号(API Key 号请在网页端查看额度)。')
      else if (ok >= refreshable) setNotice(`已刷新 ${ok} 个账号额度。`)
      else setNotice(`已刷新 ${ok}/${refreshable} 个账号,${refreshable - ok} 个失败(见各账号状态)。`)
    } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  // 导出走后端原生保存对话框(Blob + <a download> 在 Wails WebView 里不生效——
  // 点了没反应也没文件)。后端弹框选路径并落盘,返回保存路径;用户取消返回空串。
  const onExport = async () => {
    setBusy('export')
    setErr('')
    try {
      const path = await api.exportAccountsToFile([])
      if (path) setNotice(`已导出 ${accounts.length} 个账号到:${path}`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onBatchDelete = async () => {
    if (selected.size === 0) return
    const ok = await showConfirm('删除所选账号', `将删除 ${selected.size} 个账号,凭证从本机移除且不可恢复。确定继续?`, { confirmLabel: '确认删除', cancelLabel: '取消' })
    if (!ok) return
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
    setEditGroup(groupOf[a.id] || '')
  }

  const onEditSave = async () => {
    if (!editing) return
    const id = editing.id
    const name = editName.trim()
    const note = editNote.trim()
    const tags = editTags.split(',').map((t) => t.trim()).filter(Boolean)
    const prevGroup = groupOf[id] || ''
    setBusy('edit')
    try {
      if (name !== (editing.name || '')) await api.rename(id, name)
      if (note !== (editing.note || '')) await api.setNote(id, note)
      if (tags.join(',') !== (editing.tags || []).join(',')) await api.setTags(id, tags)
      if (editGroup !== prevGroup) {
        if (editGroup) await assignAccountsToGroup(editGroup, [id])
        else if (prevGroup) await removeAccountsFromGroup(prevGroup, [id])
      }
      setEditing(null)
      await refresh()
      await refreshGroups()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // 新建分组:trim 名称,建后重拉分组并关闭弹窗。
  const onCreateGroup = async () => {
    const name = newGroupName.trim()
    if (!name) return
    setBusy('group')
    try {
      await createAccountGroup(name)
      setGroupModalOpen(false)
      setNewGroupName('')
      await refreshGroups()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // 单号删除:先确认(凭证不可恢复),再走通用 act 刷新。
  const onDeleteAccount = async (a: LocalAccountView) => {
    const who = a.name || a.email || '该账号'
    const ok = await showConfirm('删除账号', `删除「${who}」后凭证从本机移除且不可恢复。确定继续?`, { confirmLabel: '确认删除', cancelLabel: '取消' })
    if (!ok) return
    await act(`del-${a.id}`, () => api.deleteAccount(a.id))
  }

  // 显式设为当前号(= 设优先出口;local 接管态后端会重注入)。
  const onSetCurrent = async (id: string) => {
    setBusy(`current-${id}`)
    try {
      await setCurrentAccount(provider, id)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // ↑↓ 重排序:在可见顺序里交换 from/to,持久化整列新顺序。
  const onMove = async (index: number, dir: -1 | 1) => {
    const to = index + dir
    if (to < 0 || to >= accounts.length) return
    const next = accounts.slice()
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    setAccounts(next) // 乐观:先就地反映新顺序
    setBusy(`move-${moved.id}`)
    try {
      await reorderAccounts(provider, next.map((a) => a.id))
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const scopedAccounts = useMemo(
    () => groupFilter === 'all' ? accounts : accounts.filter((account) => groupOf[account.id] === groupFilter),
    [accounts, groupFilter, groupOf],
  )
  const poolCount = useMemo(() => scopedAccounts.filter((a) => a.poolEnabled).length, [scopedAccounts])
  const attentionCount = useMemo(() => scopedAccounts.filter((a) => a.quotaStatus !== 'ok').length, [scopedAccounts])

  // 分组、工作状态与搜索统一落在一个可预期的视图模型里。
  const visible = useMemo(
    () => {
      const needle = query.trim().toLocaleLowerCase()
      return scopedAccounts.filter((account) => {
        if (viewFilter === 'pool' && !account.poolEnabled) return false
        if (viewFilter === 'attention' && account.quotaStatus === 'ok') return false
        if (!needle) return true
        return [account.name, account.email, account.note, account.planType, ...(account.tags || [])]
          .some((value) => String(value || '').toLocaleLowerCase().includes(needle))
      })
    },
    [query, scopedAccounts, viewFilter],
  )

  const activeGroupName = groupFilter === 'all'
    ? '全部账号'
    : groups.find((group) => group.id === groupFilter)?.name || '账号分组'
  const allVisibleSelected = visible.length > 0 && visible.every((account) => selected.has(account.id))
  const toggleAllVisible = () => setSelected((previous) => {
    const next = new Set(previous)
    if (allVisibleSelected) visible.forEach((account) => next.delete(account.id))
    else visible.forEach((account) => next.add(account.id))
    return next
  })

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}
      {notice && <div className="rounded-[8px] border border-[var(--success)] bg-[var(--success)]/10 px-3 py-2 text-[12px] text-[var(--text-secondary)] break-all">{notice}</div>}
      {importInfo && <div className="rounded-[8px] border border-[var(--success)] bg-[var(--success)]/5 px-3 py-2 text-[12px] text-[var(--success)]">{importInfo}</div>}
      <section aria-label={`${activeGroupName}列表`} className="min-w-0 overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex flex-col gap-3 border-b border-[var(--border-light)] px-4 py-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{activeGroupName}</h2>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                {scopedAccounts.length} 个账号 · {poolCount} 个已入池{attentionCount > 0 ? ` · ${attentionCount} 个需处理` : ''}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-1.5 sm:w-auto">
              <div className="relative min-w-[180px] flex-1 sm:w-[240px] sm:flex-none">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索账号" placeholder="搜索账号" className="h-8 pl-8 text-[12px]" />
              </div>
              <div className="relative">
                <Button ref={addBtnRef} type="button" size="sm" onClick={() => setAddMenuOpen((v) => !v)} aria-label="加号" aria-haspopup="menu" aria-expanded={addMenuOpen}>
                  <Plus size={13} data-icon="inline-start" /> 添加账号 <ChevronDown size={12} data-icon="inline-end" />
                </Button>
              <PortalMenu open={addMenuOpen} anchorRef={addBtnRef} onClose={() => setAddMenuOpen(false)} label="加号菜单">
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
              </PortalMenu>
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
              <Button type="button" size="icon" variant="ghost" onClick={() => void refresh()} title="刷新账号列表" aria-label="刷新账号列表">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </Button>
              <KebabMenu
                label="号池更多操作"
                items={[
                  { key: 'import', label: '导入 JSON', icon: <Upload size={14} />, onClick: () => setImportOpen(true) },
                  { key: 'export', label: '导出账号', icon: <Download size={14} />, disabled: busy === 'export' || accounts.length === 0, onClick: onExport },
                  { key: 'refresh-all', label: '全部刷新额度', icon: busy === 'refresh-all' ? <Loader2 size={14} className="animate-spin" /> : <Gauge size={14} />, disabled: busy === 'refresh-all' || accounts.length === 0, onClick: () => void onRefreshAll() },
                ]}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <nav className="flex max-w-full items-center gap-4 overflow-x-auto" aria-label="分组筛选">
              <button
                type="button"
                aria-label="全部账号"
                aria-pressed={groupFilter === 'all'}
                onClick={() => setGroupFilter('all')}
                className={cn('h-7 shrink-0 border-b-2 px-0.5 text-[11px] font-medium transition-colors', groupFilter === 'all' ? 'border-[var(--primary)] text-[var(--primary-strong)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
              >
                全部 <span className="ml-1 font-mono-data text-[10px] text-[var(--text-muted)]">{accounts.length}</span>
              </button>
              {groups.map((group) => {
                const count = accounts.filter((account) => groupOf[account.id] === group.id).length
                const active = groupFilter === group.id
                return (
                  <button
                    key={group.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setGroupFilter(group.id)}
                    className={cn('h-7 shrink-0 border-b-2 px-0.5 text-[11px] font-medium transition-colors', active ? 'border-[var(--primary)] text-[var(--primary-strong)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
                  >
                    {group.name} <span className="ml-1 font-mono-data text-[10px] text-[var(--text-muted)]">{count}</span>
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => { setNewGroupName(''); setGroupModalOpen(true) }}
                aria-label="新建分组"
                className="inline-flex h-7 shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <FolderPlus size={13} /> 新建分组
              </button>
            </nav>

            <div className="flex flex-wrap items-center gap-1">
              <div className="flex items-center gap-0.5" aria-label="账号状态筛选">
                {([
                  ['all', '全部', scopedAccounts.length],
                  ['pool', '已入池', poolCount],
                  ['attention', '需处理', attentionCount],
                ] as const).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={viewFilter === key}
                    onClick={() => setViewFilter(key)}
                    className={cn('h-7 rounded-[6px] px-2 text-[11px] font-medium transition-colors', viewFilter === key ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}
                  >
                    {label} <span className="ml-0.5 font-mono-data text-[10px]">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {hasEconomy && <EconomyBar />}

        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-[var(--primary-light)] border-b border-[var(--border-light)] text-[12px]">
            <span className="text-[var(--primary-strong)] font-semibold">已选择 {selected.size} 个账号</span>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
              <Button type="button" size="sm" variant="danger" onClick={onBatchDelete} disabled={busy === 'batch'}>删除所选</Button>
            </div>
          </div>
        )}

        {accounts.length > 0 && (
          <div className="hidden grid-cols-[auto_minmax(220px,1.3fr)_minmax(190px,.8fr)_auto] items-center gap-3 px-4 py-2 text-[10px] font-semibold text-[var(--text-muted)] xl:grid">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="选择当前视图全部账号" className="size-3.5 accent-[var(--primary)]" />
            <span>账号</span>
            <span>剩余额度</span>
            <span className="text-right">池状态与操作</span>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-3 px-4 py-6" role="status" aria-label="正在加载账号">
            {[0, 1, 2].map((item) => <div key={item} className="h-14 rounded-[8px] bg-[var(--bg-tertiary)] opacity-70" />)}
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="inline-flex size-10 items-center justify-center rounded-[10px] bg-[var(--primary-light)] text-[var(--primary-strong)]"><Users size={18} /></span>
            <div className="mt-3 text-[13px] font-semibold text-[var(--text-primary)]">还没有本地账号</div>
            <div className="mt-1 max-w-[360px] text-[12px] text-[var(--text-secondary)]">登录自有账号后，可以在这里安排当前出口、入池状态和额度刷新。</div>
            <Button type="button" size="sm" onClick={onLogin} className="mt-4"><Plus size={14} data-icon="inline-start" /> 登录账号</Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <Search size={18} className="text-[var(--text-muted)]" />
            <div className="mt-2 text-[12px] font-semibold text-[var(--text-primary)]">没有匹配的账号</div>
            <button type="button" className="mt-1 text-[11px] text-[var(--primary-strong)] hover:underline" onClick={() => { setQuery(''); setViewFilter('all') }}>清除搜索和状态筛选</button>
          </div>
        ) : (
          visible.map((a) => {
            const st = statusLabel(a.quotaStatus)
            const realIndex = accounts.findIndex((x) => x.id === a.id)
            const reorderable = groupFilter === 'all' && viewFilter === 'all' && !query.trim()
            return (
              <div key={a.id} className={cn('border-t border-[var(--border-light)] first:border-t-0 transition-colors hover:bg-[var(--bg-hover)]', a.priority && 'bg-[var(--primary-light)]/65')}>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-4 py-3 xl:grid-cols-[auto_minmax(220px,1.3fr)_minmax(190px,.8fr)_auto] xl:items-center">
                  <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} className="mt-1 size-3.5 accent-[var(--primary)] cursor-pointer xl:mt-0" aria-label="选择账号" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">{a.name || a.email || '(未知邮箱)'}</span>
                      {a.priority && <Badge><CheckCircle2 size={11} /> 当前号</Badge>}
                      <span className={cn('text-[11px]', st.cls)}>{st.text}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                      {a.name && a.email && <span className="truncate">{a.email}</span>}
                      {a.planType && <span className={cn('rounded-[5px] px-1.5 py-0.5 text-[10px] font-semibold', planBadgeClass(a.planType))}>{a.planType}</span>}
                      <span>{a.authKind === 'apikey' ? 'API Key' : 'OAuth'}</span>
                    </div>
                    {(a.note || (a.tags && a.tags.length > 0)) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {(a.tags || []).map((tag) => <Badge key={tag} variant="muted" className="rounded-[5px] px-1.5 py-0 text-[10px]">{tag}</Badge>)}
                        {a.note && <span className="truncate text-[11px] text-[var(--text-muted)]">{a.note}</span>}
                      </div>
                    )}
                  </div>

                  <div className="col-start-2 flex flex-col gap-1.5 xl:col-start-auto">
                    {a.quotaBuckets && a.quotaBuckets.length > 0 ? (
                      <>
                        {a.quotaBuckets.map((bucket) => (
                          <QuotaBar key={bucket.key} label={bucket.label} percent={bucket.percent} />
                        ))}
                      </>
                    ) : (
                      <>
                      {visibleDefaultQuotaWindows(provider, a.hourlyPercent, a.weeklyPercent).map((window) => (
                        <QuotaBar key={window.label} label={window.label} percent={window.percent} />
                      ))}
                      {provider === 'codex' && a.hourlyPercent < 0 && a.weeklyPercent < 0 && (
                        <span className="text-[11px] text-[var(--text-muted)]">额度未知</span>
                      )}
                      </>
                    )}
                  </div>

                  <div className="col-start-2 flex flex-wrap items-center gap-1.5 xl:col-start-auto xl:justify-end">
                  <button
                    onClick={() => act(`pool-${a.id}`, () => api.setPoolEnabled(a.id, !a.poolEnabled))}
                    disabled={busy === `pool-${a.id}`}
                    className={cn('text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border', a.poolEnabled ? 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]' : 'border-[var(--primary)] text-[var(--primary-strong)] bg-[var(--primary-light)]')}
                  >
                    {a.poolEnabled ? '移出池' : '加入池'}
                  </button>
                  {!a.priority && (
                    <button
                      onClick={() => onSetCurrent(a.id)}
                      disabled={busy === `current-${a.id}`}
                      className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 inline-flex items-center gap-1"
                      title="显式设为当前出口号(local 接管态会重注入)"
                    >
                      {busy === `current-${a.id}` ? <Loader2 size={13} className="animate-spin" /> : null} 设为当前号
                    </button>
                  )}
                  <KebabMenu
                    items={[
                      { key: 'quota', label: '刷新额度', icon: <Gauge size={14} />, disabled: busy === `quota-${a.id}`, onClick: () => act(`quota-${a.id}`, () => api.refreshQuota(a.id)) },
                      { key: 'edit', label: '编辑账号', icon: <Pencil size={14} />, onClick: () => openEdit(a) },
                      { key: 'del', label: '删除账号', icon: <Trash2 size={14} />, danger: true, disabled: busy === `del-${a.id}`, onClick: () => void onDeleteAccount(a) },
                    ]}
                  />
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
                    {reorderable && <div className="ml-0.5 flex items-center rounded-[7px] border border-[var(--border-light)]">
                      <button
                        onClick={() => onMove(realIndex, -1)}
                        disabled={!reorderable || realIndex <= 0 || busy === `move-${a.id}`}
                        aria-label="上移"
                        title={reorderable ? '上移' : '清除筛选后可排序'}
                        className="inline-flex size-7 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
                      ><ChevronUp size={13} /></button>
                      <button
                        onClick={() => onMove(realIndex, 1)}
                        disabled={!reorderable || realIndex >= accounts.length - 1 || busy === `move-${a.id}`}
                        aria-label="下移"
                        title={reorderable ? '下移' : '清除筛选后可排序'}
                        className="inline-flex size-7 items-center justify-center border-l border-[var(--border-light)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
                      ><ChevronDown size={13} /></button>
                    </div>}
                  </div>
                </div>
                {hasEconomy && expanded.has(a.id) && (
                  <div className="px-4 pb-3 pl-11">
                    <RowExtras account={a} />
                  </div>
                )}
              </div>
            )
          })
        )}
      </section>

      <div className="flex items-center justify-center gap-2 text-[11px] text-[var(--text-muted)]">
        <Coffee size={14} className="text-[var(--warning-deep)]" />
        <span>支持冰茶AI持续维护</span>
        <button
          onClick={() => setRewardOpen(true)}
          className="font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
        >
          赞赏
        </button>
      </div>

      <RewardModal open={rewardOpen} onClose={() => setRewardOpen(false)} />

      <Dialog open={loginOpen} onOpenChange={(open) => { if (!open) void closeLogin() }}>
        <DialogContent className="max-w-[560px] p-0 overflow-hidden" onEscapeKeyDown={(event) => {
          if (loginPhase === 'starting' || loginPhase === 'submitting') event.preventDefault()
        }}>
          <div className="px-6 pt-6 pb-5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/55">
            <DialogHeader className="mb-0 pr-8">
              <DialogTitle>登录 {title} 账号</DialogTitle>
              <DialogDescription>浏览器授权和手动回调都在这里完成。切到浏览器不会关闭此窗口。</DialogDescription>
            </DialogHeader>
            <div className="mt-4 grid grid-cols-2 gap-2" aria-label="登录进度">
              <div className={cn('flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px] font-semibold', loginPhase === 'starting' ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]')}>
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-[var(--bg-card)] font-mono-data text-[10px]">1</span>
                打开浏览器授权
              </div>
              <div className={cn('flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px] font-semibold', loginPhase !== 'starting' && loginPhase !== 'idle' ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)]')}>
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-[var(--bg-card)] font-mono-data text-[10px]">2</span>
                等待登录结果
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4 px-6 py-5">
            {loginPhase === 'success' ? (
              <div className="flex flex-col items-center gap-3 py-5 text-center" role="status">
                <span className="inline-flex size-11 items-center justify-center rounded-full bg-[var(--success)]/12 text-[var(--success-strong)]">
                  <CheckCircle2 size={24} />
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-[var(--text-primary)]">账号已添加</div>
                  <p className="mt-1 text-[12px] text-[var(--text-secondary)]">本地号池已刷新,现在可以设置当前号或调整入池状态。</p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--primary-light)] text-[var(--primary-strong)]">
                    {loginPhase === 'starting' ? <Loader2 size={16} className="animate-spin" /> : <Globe size={16} />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                      {loginPhase === 'starting' ? '正在发起登录' : loginPhase === 'submitting' ? '正在提交回调' : '请在系统浏览器完成授权'}
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                      授权成功会自动返回。如果浏览器停在 localhost 错误页,复制完整地址并粘贴到下方。
                    </p>
                  </div>
                </div>

                <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void onSubmitCallback() }}>
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor={`${provider}-oauth-callback`} className="text-[12px] font-semibold text-[var(--text-primary)]">回调地址</label>
                    <span className="text-[11px] text-[var(--text-muted)]">输入会在失败后保留</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`${provider}-oauth-callback`}
                      aria-label="OAuth 回调 URL"
                      value={callbackURL}
                      onChange={(event) => { setCallbackURL(event.target.value); if (loginError) setLoginError('') }}
                      placeholder="http://localhost:1455/auth/callback?code=..."
                      className="min-w-0 flex-1 font-mono-data text-[12px]"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button type="button" variant="secondary" onClick={() => void onPasteCallback()} disabled={loginPhase === 'submitting'} aria-label="从剪贴板粘贴回调地址">
                      <ClipboardPaste size={15} />
                      粘贴
                    </Button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">必须包含当前登录生成的 code 和 state。不要粘贴授权页地址。</p>
                </form>

                {loginError && (
                  <div className="flex items-start gap-2 rounded-[10px] bg-[var(--danger)]/8 px-3 py-2.5 text-[12px] text-[var(--danger)]" role="alert">
                    <CircleAlert size={15} className="mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-semibold">本次登录没有完成</div>
                      <div className="mt-0.5 break-all opacity-90">{loginError}</div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter className="mt-0 border-t border-[var(--border-light)] px-6 py-4">
            {loginPhase === 'success' ? (
              <Button onClick={() => void closeLogin()}>完成</Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => void closeLogin()}>取消登录</Button>
                {(loginPhase === 'error' || !loginId) && loginPhase !== 'starting' && (
                  <Button type="button" variant="secondary" onClick={() => void onRetryLogin()}>
                    <RotateCcw size={15} />
                    重新发起
                  </Button>
                )}
                <Button type="button" onClick={() => void onSubmitCallback()} disabled={!loginId || !callbackURL.trim() || loginPhase === 'starting' || loginPhase === 'submitting'}>
                  {loginPhase === 'submitting' && <Loader2 size={15} className="animate-spin" />}
                  提交回调
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={(o) => !o && setImportOpen(false)}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>从 JSON 导入账号</DialogTitle>
            <DialogDescription>粘贴导出的 JSON,按邮箱去重(已存在的自动跳过)。</DialogDescription>
          </DialogHeader>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={8}
            placeholder='[{"email":"you@example.com","authKind":"oauth","refreshToken":"..."}]'
            className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 text-[12px] font-mono-data text-[var(--text-primary)] resize-none"
          />
          <DialogFooter>
            <button onClick={() => setImportOpen(false)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={onImportConfirm} disabled={busy === 'import' || !importText.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">导入</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addMode === 'token'} onOpenChange={(o) => !o && setAddMode(null)}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>粘贴 OAuth Token 加号</DialogTitle>
            <DialogDescription>自备已登录账号的 OAuth 令牌,凭证只留在本机。</DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <button onClick={() => setAddMode(null)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={onAddToken} disabled={busy === 'add' || !tokRefresh.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">添加账号</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addMode === 'apikey'} onOpenChange={(o) => !o && setAddMode(null)}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>粘贴 API Key 加号</DialogTitle>
            <DialogDescription>自备 API Key,凭证只留在本机。</DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <button onClick={() => setAddMode(null)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={onAddApiKey} disabled={busy === 'add' || !keyValue.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">添加账号</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>编辑账号</DialogTitle>
            <DialogDescription className="truncate">{editing.email || editing.id}</DialogDescription>
          </DialogHeader>
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
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">所属分组
                <select aria-label="所属分组" value={editGroup} onChange={(e) => setEditGroup(e.target.value)} className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]">
                  <option value="">(无分组)</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </label>
            </div>
          <DialogFooter>
            <button onClick={() => setEditing(null)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={onEditSave} disabled={busy === 'edit'} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">保存</button>
          </DialogFooter>
        </DialogContent>
        )}
      </Dialog>

      <Dialog open={groupModalOpen} onOpenChange={(o) => !o && setGroupModalOpen(false)}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>新建分组</DialogTitle>
            <DialogDescription>分组只用于本地组织视图,一个账号只属于一个分组。</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-[var(--text-secondary)]">分组名称
            <input
              aria-label="分组名称"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onCreateGroup() }}
              placeholder="如:主力 / 备用 / 测试"
              className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[34px] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
            />
          </label>
          <DialogFooter>
            <button onClick={() => setGroupModalOpen(false)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={onCreateGroup} disabled={busy === 'group' || !newGroupName.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">创建分组</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Modal {...modalProps} />
    </div>
  )
}
