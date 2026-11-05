import { useCallback, useEffect, useState } from 'react'
import {
  BellRing,
  Check,
  FileUp,
  KeyRound,
  Loader2,
  LogIn,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
} from 'lucide-react'

import { Modal, useModal } from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import {
  announceSelfAccountChange,
  cleanSelfAccountError,
  formatSelfAccountTime,
  SELF_ACCOUNT_STATE_EVENT,
  selfAccountName,
} from '@/lib/selfAccounts'
import * as api from '@/services/wails'
import type { SelfAccount, SelfAccountQuotaWindow, SelfAccountState } from '@/types'

export function selfAccountQuotaStatus(account: SelfAccount): string {
  const fetchedAt = account.quota?.fetchedAt
  if (account.quota?.error) {
    return fetchedAt
      ? `${account.quota.error} · 上次更新 ${formatSelfAccountTime(fetchedAt)}`
      : account.quota.error
  }
  return `更新于 ${formatSelfAccountTime(fetchedAt)}`
}

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[var(--primary)]' : 'bg-[var(--switch-off)]',
      )}
    >
      <span className={cn('absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all', checked ? 'right-[3px]' : 'left-[3px]')} />
    </button>
  )
}

function QuotaBar({ label, quota }: { label: string; quota?: SelfAccountQuotaWindow | null }) {
  if (!quota?.known) {
    return (
      <div className="grid grid-cols-[52px_1fr_38px] items-center gap-2">
        <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
        <Progress value={0} className="h-[5px]" indicatorClassName="bg-transparent" />
        <span className="text-right text-[11px] text-[var(--text-muted)]">未知</span>
      </div>
    )
  }
  const remaining = Math.max(0, Math.min(100, quota.remaining))
  const color = remaining <= 10 ? 'bg-[var(--danger)]' : remaining <= 25 ? 'bg-[var(--warning)]' : 'bg-[var(--success-strong)]'
  const textColor = remaining <= 10 ? 'text-[var(--danger)]' : remaining <= 25 ? 'text-[var(--warning-deep)]' : 'text-[var(--text-secondary)]'
  return (
    <div className="grid grid-cols-[52px_1fr_38px] items-center gap-2">
      <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      <Progress value={remaining} aria-label={`${label}剩余 ${remaining}%`} className="h-[5px]" indicatorClassName={color} />
      <span className={cn('text-right text-[11px] font-mono-data', textColor)}>{remaining}%</span>
    </div>
  )
}

function AccountRow({ account, busy, onSwitch, onRefresh, onEdit, onDelete }: {
  account: SelfAccount
  busy: string | null
  onSwitch: () => void
  onRefresh: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const rowBusy = busy?.endsWith(account.id)
  return (
    <section aria-label={selfAccountName(account)} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
      <div className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[13px] font-bold',
        account.current ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
      )}>
        {(account.alias || account.email || 'C').trim().slice(0, 1).toUpperCase()}
      </div>

      <div className="min-w-[180px] flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{selfAccountName(account)}</h3>
          {account.current && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--primary-light)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary-strong)]">
              <Check size={10} /> 当前使用
            </span>
          )}
          {account.planType && <span className="shrink-0 text-[10px] uppercase text-[var(--text-muted)]">{account.planType}</span>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{account.email || `账户 ID ${account.accountId || account.id.slice(0, 12)}`}</p>
      </div>

      <div className="w-[260px] max-w-full space-y-1.5">
        <QuotaBar label="5 小时" quota={account.quota?.fiveHour} />
        <QuotaBar label="本周" quota={account.quota?.weekly} />
        <p className={cn('text-[10px]', account.quota?.error ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]')}>
          {selfAccountQuotaStatus(account)}
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="sm" title="刷新额度" disabled={!!busy} onClick={onRefresh}>
          {busy === `refresh:${account.id}` ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </Button>
        <Button variant="ghost" size="sm" title="修改备注" disabled={!!busy} onClick={onEdit}><Pencil size={14} /></Button>
        <Button variant="ghost" size="sm" title="从列表删除" disabled={!!busy} onClick={onDelete}><Trash2 size={14} /></Button>
        <Button size="sm" variant={account.current ? 'secondary' : 'default'} disabled={!!busy || account.current} onClick={onSwitch}>
          {busy === `switch:${account.id}` && <Loader2 size={14} className="animate-spin" />}
          {account.current ? '使用中' : '切换使用'}
        </Button>
      </div>
      {rowBusy && <span className="sr-only">处理中</span>}
    </section>
  )
}

export function SelfAccountsPage() {
  const [state, setState] = useState<SelfAccountState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<SelfAccount | null>(null)
  const [alias, setAlias] = useState('')
  const [threshold, setThreshold] = useState('20')
  const { modalProps, showConfirm } = useModal()

  const load = useCallback(async () => {
    try {
      const next = await api.getSelfAccountState()
      setState(next)
      setThreshold(String(next.alert.threshold))
      setError('')
    } catch (e) {
      setError(cleanSelfAccountError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const onChange = () => void load()
    window.addEventListener(SELF_ACCOUNT_STATE_EVENT, onChange)
    return () => window.removeEventListener(SELF_ACCOUNT_STATE_EVENT, onChange)
  }, [load])

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key); setError(''); setNotice('')
    try {
      const result = await action()
      if (result === null) return
      await load()
      setNotice(success)
      announceSelfAccountChange()
    } catch (e) {
      setError(cleanSelfAccountError(e))
    } finally {
      setBusy(null)
    }
  }

  const switchAccount = async (account: SelfAccount) => {
    setBusy(`switch:${account.id}`); setError(''); setNotice('')
    try {
      const result = await api.switchSelfAccount(account.id)
      await load()
      const reload = result.reloadMode === 'daemon_restarted'
        ? 'Codex 后台已重新加载'
        : result.reloadMode === 'app_restarted'
          ? 'Codex 已自动重启'
          : '下次启动 Codex 时生效'
      setNotice(`已切换到 ${selfAccountName(result.account)}，${reload}${result.takeoverDisabled ? '；Codex 接管已停止' : ''}。`)
      announceSelfAccountChange()
    } catch (e) {
      setError(cleanSelfAccountError(e))
    } finally {
      setBusy(null)
    }
  }

  const saveAlias = async () => {
    if (!editing) return
    await run(`edit:${editing.id}`, () => api.updateSelfAccountAlias(editing.id, alias), '账号备注已保存。')
    setEditing(null)
  }

  const removeAccount = async (account: SelfAccount) => {
    const confirmed = await showConfirm(
      '从本机账号列表删除',
      `确定删除“${selfAccountName(account)}”吗？这只会删除冰茶AI保存的副本，不会退出当前 Codex 登录。`,
      { confirmLabel: '删除账号' },
    )
    if (confirmed) await run(`delete:${account.id}`, () => api.deleteSelfAccount(account.id), '账号已从本机列表删除。')
  }

  const saveAlert = async (enabled = state?.alert.enabled ?? true) => {
    const value = Math.max(1, Math.min(100, Number(threshold) || 20))
    setThreshold(String(value))
    await run('alert', () => api.setSelfAccountAlertConfig(enabled, value), '额度提醒设置已保存。')
  }

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 pt-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[620px]">
          <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">自有账号管理</h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-secondary)]">保存多个 Codex ChatGPT 账号，需要时一键切换并自动生效。</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-[10px] bg-[var(--bg-tertiary)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
          <ShieldCheck size={15} className="text-[var(--success-strong)]" />
          凭证仅保存在本机，并由系统账户加密
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!busy} onClick={() => void run('save', () => api.saveCurrentSelfAccount(), '当前 Codex 账号已保存。')}>
          {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <UserRoundCheck size={15} />} 保存当前账号
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={() => void run('login', () => api.loginNewSelfAccount(), '新账号已保存，可以在列表中切换使用。')}>
          {busy === 'login' ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />} 浏览器登录新账号
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={() => void run('import', () => api.importSelfAccountAuth(), '账号文件已导入。')}>
          {busy === 'import' ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />} 导入 auth.json
        </Button>
      </div>

      {(error || notice) && (
        <div role={error ? 'alert' : 'status'} className={cn(
          'rounded-[10px] px-4 py-2.5 text-[12px]',
          error ? 'bg-red-500/10 text-[var(--danger)]' : 'bg-emerald-500/10 text-[var(--success-strong)]',
        )}>{error || notice}</div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--border-light)] px-5 py-3">
          <div className="flex min-w-[190px] flex-1 items-center gap-2">
            <BellRing size={15} className="text-[var(--text-muted)]" />
            <div>
              <p className="text-[12px] font-semibold text-[var(--text-primary)]">低额度提醒</p>
              <p className="text-[10px] text-[var(--text-muted)]">当前账号低于阈值时，每个额度周期提醒一次</p>
            </div>
          </div>
          <Toggle checked={state?.alert.enabled ?? true} label="低额度提醒" disabled={!state || busy === 'alert'} onChange={(enabled) => void saveAlert(enabled)} />
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            剩余低于
            <Input
              aria-label="额度提醒阈值"
              type="number"
              min={1}
              max={100}
              value={threshold}
              disabled={!state || busy === 'alert'}
              onChange={(event) => setThreshold(event.target.value)}
              onBlur={() => void saveAlert()}
              className="h-8 w-[68px] font-mono-data"
            />
            %
          </label>
        </div>

        {loading ? (
          <div className="space-y-3 px-5 py-6" aria-label="正在加载自有账号">
            {[0, 1].map((item) => <div key={item} className="h-14 animate-pulse rounded-[10px] bg-[var(--bg-tertiary)]" />)}
          </div>
        ) : state?.accounts.length ? (
          <div className="divide-y divide-[var(--border-light)]">
            {state.accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                busy={busy}
                onSwitch={() => void switchAccount(account)}
                onRefresh={() => void run(`refresh:${account.id}`, () => api.refreshSelfAccountQuota(account.id), `${selfAccountName(account)} 的额度已更新。`)}
                onEdit={() => { setEditing(account); setAlias(account.alias || '') }}
                onDelete={() => void removeAccount(account)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-[12px] bg-[var(--primary-light)] text-[var(--primary-strong)]"><KeyRound size={20} /></div>
            <h3 className="mt-4 text-[14px] font-semibold text-[var(--text-primary)]">还没有保存自有账号</h3>
            <p className="mt-1 max-w-[420px] text-[12px] leading-5 text-[var(--text-secondary)]">先在 Codex 登录一个账号并保存，或通过官方浏览器登录添加新账号。账号凭证不会上传到冰茶AI服务器。</p>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-5 text-[var(--text-muted)]">切换时会先回存当前账号的最新凭证。如果 Codex 正在运行，优先重新加载后台服务；必要时客户端会自动重启。</p>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改账号备注</DialogTitle>
            <DialogDescription>{editing?.email || '备注会显示在账号列表中，方便区分多个账号。'}</DialogDescription>
          </DialogHeader>
          <Input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="例如：工作号、备用号" autoFocus />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditing(null)}>取消</Button>
            <Button disabled={busy?.startsWith('edit:')} onClick={() => void saveAlias()}>保存备注</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Modal {...modalProps} />
    </div>
  )
}
