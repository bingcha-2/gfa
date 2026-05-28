import { useState, useEffect } from 'react'
import { usePoolStore } from '@/stores/usePoolStore'
import { Modal, useModal } from '@/components/Modal'
import { StatCard } from '@/components/StatCard'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  Plus, Trash2, ToggleLeft, ToggleRight, Globe, Key, Users, RefreshCw,
  Lock, Unlock, ChevronDown, ChevronRight, Zap, Edit2, Check, X,
  UserPlus, Shield, AlertTriangle, Activity,
} from 'lucide-react'
import type { AccountInfo, QuotaGroup } from '@/types'

// ===== 常量配置 =====

const TIER_CONFIG: Record<string, { icon: string; label: string; variant: 'success' | 'default' | 'warning' | 'danger' | 'muted' }> = {
  excellent: { icon: '⭐', label: '优秀', variant: 'success' },
  good:      { icon: '👍', label: '良好', variant: 'default' },
  poor:      { icon: '👎', label: '较差', variant: 'warning' },
  bad:       { icon: '💀', label: '异常', variant: 'danger' },
  new:       { icon: '🆕', label: '新号', variant: 'muted' },
}

const PROVIDER_META: Record<string, { label: string; icon: string; color: string }> = {
  gemini: { label: 'Gemini', icon: '✦', color: '#4285f4' },
  claude: { label: 'Claude', icon: '◈', color: '#c96442' },
  gpt:    { label: 'GPT',    icon: '◉', color: '#74aa9c' },
  other:  { label: '其他',   icon: '○', color: 'var(--text-muted)' },
}

function quotaPercent(percent: number, allBlocked: boolean): 'success' | 'warning' | 'danger' {
  if (allBlocked) return 'danger'
  if (percent >= 70) return 'success'
  if (percent >= 30) return 'warning'
  return 'danger'
}

function quotaBarColor(percent: number, allBlocked: boolean): string {
  if (allBlocked) return 'bg-[var(--danger)]'
  if (percent >= 70) return 'bg-[var(--success)]'
  if (percent >= 30) return 'bg-[var(--warning)]'
  return 'bg-[var(--danger)]'
}

function humanizeResetTime(resetTime: string): string {
  if (!resetTime) return ''
  const date = new Date(resetTime)
  if (isNaN(date.getTime())) return ''
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) return '已重置'
  const totalMin = Math.ceil(diffMs / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0 && m > 0) return `${h}h${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

// ===== 额度面板 =====

function QuotaSection({ groups }: { groups: QuotaGroup[] }) {
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  if (!groups || groups.length === 0) {
    return (
      <div className="text-[11px] text-[var(--text-muted)] py-2">
        暂无额度快照，点击「刷新额度」获取
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => {
        const meta = PROVIDER_META[g.provider] || PROVIDER_META.other
        const allBlocked = g.blockedCount === g.modelCount
        const tone = quotaPercent(g.percent, allBlocked)
        const barColor = quotaBarColor(g.percent, allBlocked)
        const isExpanded = expandedProviders.has(g.provider)
        const resetStr = humanizeResetTime(g.resetTime)

        return (
          <div key={g.provider} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span style={{ color: meta.color, fontSize: 13 }}>{meta.icon}</span>
                <span className="text-[12px] font-semibold text-[var(--text-primary)]">{meta.label}</span>
                <Badge variant="muted" className="text-[9px] h-4 px-1">{g.modelCount} 模型</Badge>
              </div>
              <div className="flex items-center gap-2">
                {resetStr && <span className="text-[10px] text-[var(--text-muted)]">{resetStr}</span>}
                <Badge variant={tone} className="text-[9px] h-4 px-1.5">
                  {allBlocked ? '已耗尽' : `${Math.round(g.percent)}%`}
                </Badge>
                <button
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-0.5"
                  onClick={() => {
                    const next = new Set(expandedProviders)
                    if (next.has(g.provider)) next.delete(g.provider)
                    else next.add(g.provider)
                    setExpandedProviders(next)
                  }}
                >
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              </div>
            </div>

            <Progress
              value={allBlocked ? 100 : g.percent}
              indicatorClassName={barColor}
            />

            {isExpanded && g.entries && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {g.entries.map((e) => (
                  <Badge
                    key={e.key}
                    variant={e.isBlocked ? 'danger' : 'muted'}
                    className="text-[9px] h-4 px-1.5"
                  >
                    {e.label || e.key}
                    {!e.isBlocked && e.percent > 0 && ` ${Math.round(e.percent)}%`}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ===== 账号行 =====

function AccountRow({ acc, isExpanded, onToggleExpand }: {
  acc: AccountInfo
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  const { toggleAccount, removeAccount, lockAccount, unlockAccount, setAlias } = usePoolStore()
  const [editingAlias, setEditingAlias] = useState(false)
  const [aliasInput, setAliasInput] = useState(acc.alias || '')

  const tier = TIER_CONFIG[acc.qualityTier] || TIER_CONFIG.new

  // 状态点颜色
  let dotColor = 'var(--success)'
  if (!acc.enabled) dotColor = 'var(--text-muted)'
  else if (acc.accountStatusTone === 'danger') dotColor = 'var(--danger)'
  else if (acc.accountStatusTone === 'warning') dotColor = 'var(--warning)'
  else if (acc.isActive) dotColor = 'var(--success)'

  const handleSaveAlias = async () => {
    await setAlias(acc.id, aliasInput.trim())
    setEditingAlias(false)
  }

  return (
    <Card className={cn('transition-all', !acc.enabled && 'opacity-50')}>
      {/* Header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors rounded-t-[12px]"
        onClick={onToggleExpand}
      >
        {/* Status dot */}
        <div className="relative flex-shrink-0">
          <div className="size-2 rounded-full" style={{ backgroundColor: dotColor }} />
          {acc.isActive && (
            <div className="absolute inset-0 size-2 rounded-full animate-ping" style={{ backgroundColor: dotColor, opacity: 0.4 }} />
          )}
        </div>

        {/* Email + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-primary)] font-medium truncate">
              {acc.alias || acc.email}
            </span>
            {acc.alias && <span className="text-[11px] text-[var(--text-muted)] truncate">{acc.email}</span>}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {/* Plan */}
            {acc.planType && (
              <Badge
                className={cn('text-[9px] h-4 px-1',
                  acc.planType === 'ultra' && 'bg-gradient-to-r from-purple-500 to-pink-500 text-white',
                  acc.planType === 'premium' && 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white',
                  acc.planType === 'standard' && 'bg-[var(--warning)] text-white',
                )}
                variant={!['ultra', 'premium', 'standard'].includes(acc.planType) ? 'muted' : undefined}
              >
                {acc.planType === 'ultra' ? '✦ Ultra' :
                 acc.planType === 'premium' ? '✦ AI Pro' :
                 acc.planType === 'standard' ? 'Standard' :
                 acc.planType === 'free' ? 'Free' :
                 acc.planType}
              </Badge>
            )}
            {/* Credits */}
            {acc.credits?.known && (
              <Badge variant={acc.credits.available ? 'success' : 'danger'} className="text-[9px] h-4 px-1">
                积分 {Math.round(acc.credits.creditAmount)}
              </Badge>
            )}
            {/* Active */}
            {acc.isActive && (
              <Badge className="text-[9px] h-4 px-1 bg-[var(--success)] text-white">使用中</Badge>
            )}
            {/* Locked */}
            {acc.isLocked && (
              <Badge className="text-[9px] h-4 px-1 bg-[var(--warning)] text-white">
                <Lock size={8} /> 已锁定
              </Badge>
            )}
            {/* Quality */}
            <Badge variant={tier.variant} className="text-[9px] h-4 px-1">
              {tier.icon} {acc.successRate !== null ? `${Math.round(acc.successRate)}%` : tier.label}
            </Badge>
            {/* Status */}
            <span className="text-[10px] text-[var(--text-muted)]">{acc.accountStatusLabel}</span>
          </div>
        </div>

        {/* Right: toggle + expand */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => toggleAccount(acc.id, !acc.enabled)}
            title={acc.enabled ? '禁用' : '启用'}
          >
            {acc.enabled
              ? <ToggleRight size={16} className="text-[var(--success)]" />
              : <ToggleLeft size={16} className="text-[var(--text-muted)]" />}
          </Button>
          <button
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 transition-colors"
            onClick={onToggleExpand}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <CardContent className="pt-0 pb-4 border-t border-[var(--border-light)]">
          {/* Actions */}
          <div className="flex items-center gap-1.5 pt-3 pb-2 flex-wrap">
            {acc.isLocked ? (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => unlockAccount()}>
                <Unlock size={11} /> 解除锁定
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => lockAccount(acc.id)}>
                <Lock size={11} /> 锁定账号
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => { setEditingAlias(true); setAliasInput(acc.alias || '') }}
            >
              <Edit2 size={11} /> 别名
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] text-[var(--danger)] hover:bg-red-50"
              onClick={() => removeAccount(acc.id)}
            >
              <Trash2 size={11} /> 删除
            </Button>
          </div>

          {/* Alias editor */}
          {editingAlias && (
            <div className="flex items-center gap-2 pb-3">
              <Input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                placeholder="设置别名..."
                className="h-7 text-[12px] flex-1"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleSaveAlias()}
              />
              <Button size="icon" variant="ghost" className="size-7" onClick={handleSaveAlias}>
                <Check size={12} className="text-[var(--success)]" />
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditingAlias(false)}>
                <X size={12} />
              </Button>
            </div>
          )}

          {/* Quota refreshed at */}
          {acc.quotaRefreshedAt && (
            <div className="text-[11px] text-[var(--text-muted)] pb-2">
              额度更新: {new Date(acc.quotaRefreshedAt).toLocaleTimeString()}
            </div>
          )}

          {/* Blocked models */}
          {acc.blockedModels && Object.keys(acc.blockedModels).length > 0 && (
            <div className="pb-2">
              <div className="text-[10px] text-[var(--text-muted)] mb-1">封锁模型</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(acc.blockedModels).map(([model, until]) => (
                  <Badge key={model} variant="danger" className="text-[9px] h-4 px-1.5">
                    {model} → {humanizeResetTime(until)}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Quota panel */}
          <QuotaSection groups={acc.quotaGroups} />
        </CardContent>
      )}
    </Card>
  )
}

// ===== 添加账号弹窗 =====

function AddAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { addAccount, oauthLogin, loading } = usePoolStore()
  const { modalProps, showAlert } = useModal()
  const [activeTab, setActiveTab] = useState<'oauth' | 'token'>('oauth')

  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [profile, setProfile] = useState('antigravity')
  const [oauthProfile, setOauthProfile] = useState('antigravity')
  const [oauthStatus, setOauthStatus] = useState('')

  const handleAddAccount = async () => {
    if (!email.trim() || !token.trim()) {
      await showAlert('提示', '请填写邮箱和 Refresh Token')
      return
    }
    const result = await addAccount(email.trim(), token.trim(), profile)
    if (result.success) {
      setEmail(''); setToken('')
      onOpenChange(false)
    } else {
      await showAlert('添加失败', result.error || '未知错误')
    }
  }

  const handleOAuth = async () => {
    setOauthStatus('等待授权...')
    const result = await oauthLogin(oauthProfile)
    if (result.success) {
      setOauthStatus(`✓ ${result.email} 导入成功`)
      setTimeout(() => onOpenChange(false), 1500)
    } else {
      setOauthStatus(`✗ ${result.error || '未知错误'}`)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle><UserPlus size={16} /> 添加账号</DialogTitle>
            <DialogDescription>通过 OAuth 登录或手动导入 Token 添加账号到本地号池</DialogDescription>
          </DialogHeader>

          {/* Tab switch */}
          <div className="flex rounded-[8px] bg-[var(--bg-tertiary)] p-1">
            <button
              onClick={() => setActiveTab('oauth')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[6px] text-[12px] font-semibold transition-all',
                activeTab === 'oauth'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <Globe size={14} /> OAuth 录入
            </button>
            <button
              onClick={() => setActiveTab('token')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[6px] text-[12px] font-semibold transition-all',
                activeTab === 'token'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <Key size={14} /> Token 导入
            </button>
          </div>

          {activeTab === 'oauth' ? (
            <div className="flex flex-col gap-3 pt-2">
              <p className="text-[12px] text-[var(--text-muted)]">通过 Google 账号登录自动获取 Refresh Token 并导入号池</p>
              <div className="flex gap-2">
                <select
                  value={oauthProfile}
                  onChange={(e) => setOauthProfile(e.target.value)}
                  className="flex-1 h-9 rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none"
                >
                  <option value="antigravity">Antigravity</option>
                  <option value="legacy">Legacy (Cloud Code)</option>
                </select>
                <Button onClick={handleOAuth} disabled={loading}>
                  {loading ? '等待授权...' : 'Google 登录'}
                </Button>
              </div>
              {oauthStatus && (
                <p className={cn('text-[12px]',
                  oauthStatus.startsWith('✓') ? 'text-[var(--success)]'
                  : oauthStatus.startsWith('✗') ? 'text-[var(--danger)]'
                  : 'text-[var(--text-muted)]'
                )}>
                  {oauthStatus}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 pt-2">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱地址" />
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Refresh Token (1//...)" />
              <div className="flex gap-2">
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  className="flex-1 h-9 rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none"
                >
                  <option value="antigravity">Antigravity</option>
                  <option value="legacy">Legacy (Cloud Code)</option>
                </select>
                <Button onClick={handleAddAccount} disabled={loading}>
                  {loading ? '添加中...' : '添加'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Modal {...modalProps} />
    </>
  )
}

// ===== 主页面 =====

export function PoolPage() {
  const {
    accounts, mode, refreshing, filter, expandedIds,
    fetchAccounts, refreshQuota, setFilter, toggleExpand,
  } = usePoolStore()
  const { modalProps } = useModal()
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  // 自动轮询（每 3s 刷新账号列表）
  useEffect(() => {
    fetchAccounts()
    const timer = setInterval(fetchAccounts, 3000)
    return () => clearInterval(timer)
  }, [fetchAccounts])

  // 筛选
  const filteredAccounts = accounts.filter((a) => {
    if (filter === 'active') return a.enabled && a.quotaStatus !== 'exhausted' && a.consecutiveErrors < 5
    if (filter === 'error') return !a.enabled || a.quotaStatus === 'exhausted' || a.consecutiveErrors >= 5
    return true
  })

  const total = accounts.length
  const available = accounts.filter((a) => a.enabled && a.quotaStatus !== 'exhausted' && a.consecutiveErrors < 5).length
  const exhausted = accounts.filter((a) => a.quotaStatus === 'exhausted').length
  const active = accounts.filter((a) => a.isActive).length
  const hasLocked = accounts.some((a) => a.isLocked)

  return (
    <div className="max-w-[720px] flex flex-col gap-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-[18px] font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Users size={20} /> 本地号池管理
          {hasLocked && (
            <Badge className="text-[10px] bg-[var(--warning)] text-white">
              <Lock size={10} /> 调试模式
            </Badge>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[12px]"
            onClick={refreshQuota}
            disabled={refreshing}
          >
            <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
            {refreshing ? '刷新中...' : '刷新额度'}
          </Button>
          <Button size="sm" className="h-8 text-[12px]" onClick={() => setAddDialogOpen(true)}>
            <Plus size={13} /> 添加账号
          </Button>
        </div>
      </div>

      {/* ── Stats overview ── */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon={Users} value={total} label="总数" color="text-[var(--text-primary)]" />
        <StatCard icon={Shield} value={available} label="可用" color="text-[var(--success)]" />
        <StatCard icon={AlertTriangle} value={exhausted} label="冷却" color="text-[var(--warning)]" />
        <StatCard icon={Activity} value={active} label="活跃" color="text-[var(--primary)]" />
      </div>

      {/* ── Filter toolbar ── */}
      <div className="flex items-center gap-2">
        {([
          ['all', '全部', total],
          ['active', '可用', available],
          ['error', '受限', total - available],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition-all cursor-pointer',
              filter === key
                ? 'bg-[var(--primary)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            )}
          >
            {label} <span className="font-mono-data">{count}</span>
          </button>
        ))}
      </div>

      {/* ── Account list ── */}
      {filteredAccounts.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 gap-2">
          <Users size={32} className="text-[var(--text-muted)]" />
          <span className="text-[13px] text-[var(--text-muted)]">
            {accounts.length === 0 ? '暂无账号' : '没有匹配的账号'}
          </span>
          {accounts.length === 0 && (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setAddDialogOpen(true)}>
              <Plus size={13} /> 添加第一个账号
            </Button>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredAccounts.map((acc) => (
            <AccountRow
              key={acc.id}
              acc={acc}
              isExpanded={expandedIds.has(acc.id)}
              onToggleExpand={() => toggleExpand(acc.id)}
            />
          ))}
        </div>
      )}

      {/* ── Add account dialog ── */}
      <AddAccountDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />

      <Modal {...modalProps} />
    </div>
  )
}
