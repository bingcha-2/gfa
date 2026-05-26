import { useState, useEffect } from 'react'
import { usePoolStore } from '@/stores/usePoolStore'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Plus, Trash2, ToggleLeft, ToggleRight, Globe, Key, Users, RefreshCw, Lock, Unlock, ChevronDown, ChevronRight, Zap, Edit2, Check, X } from 'lucide-react'
import type { AccountInfo, QuotaGroup } from '@/types'

// ===== 质量等级配置 =====
const TIER_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  excellent: { icon: '⭐', label: '优秀', color: 'var(--success)' },
  good: { icon: '👍', label: '良好', color: 'var(--primary)' },
  poor: { icon: '👎', label: '较差', color: 'var(--warning)' },
  bad: { icon: '💀', label: '异常', color: 'var(--danger)' },
  new: { icon: '🆕', label: '新号', color: 'var(--text-muted)' },
}

const TONE_COLORS: Record<string, string> = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  muted: 'var(--text-muted)',
}

// ===== Provider 配置 =====
const PROVIDER_META: Record<string, { label: string; icon: string; color: string }> = {
  gemini: { label: 'Gemini', icon: '✦', color: '#4285f4' },
  claude: { label: 'Claude', icon: '◈', color: '#c96442' },
  gpt: { label: 'GPT', icon: '◉', color: '#74aa9c' },
  other: { label: '其他', icon: '○', color: 'var(--text-muted)' },
}

function quotaBarTone(percent: number, allBlocked: boolean): string {
  if (allBlocked) return 'var(--danger)'
  if (percent >= 70) return 'var(--success)'
  if (percent >= 30) return 'var(--warning)'
  return 'var(--danger)'
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
  if (h > 0 && m > 0) return `${h}h${m}m 后刷新`
  if (h > 0) return `${h}h 后刷新`
  return `${m}m 后刷新`
}

// ===== 额度面板组件 =====
function QuotaPanel({ groups }: { groups: QuotaGroup[] }) {
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  if (!groups || groups.length === 0) {
    return (
      <div className="text-[11px] text-[var(--text-muted)] px-2 py-1">
        暂无额度快照，点击「刷新额度」获取
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => {
        const meta = PROVIDER_META[g.provider] || PROVIDER_META.other
        const allBlocked = g.blockedCount === g.modelCount
        const barColor = quotaBarTone(g.percent, allBlocked)
        const isExpanded = expandedProviders.has(g.provider)
        const resetStr = humanizeResetTime(g.resetTime)

        return (
          <div key={g.provider} className="rounded-[6px] bg-[var(--bg-tertiary)] p-2">
            {/* Provider header */}
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span style={{ color: meta.color, fontSize: 13 }}>{meta.icon}</span>
                <span className="text-[12px] font-semibold text-[var(--text-primary)]">{meta.label}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{g.modelCount} 模型</span>
              </div>
              <div className="flex items-center gap-2">
                {resetStr && <span className="text-[10px] text-[var(--text-muted)]">{resetStr}</span>}
                <span className="text-[12px] font-mono font-bold" style={{ color: barColor }}>
                  {allBlocked ? '已耗尽' : `${Math.round(g.percent)}%`}
                </span>
                <button
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
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

            {/* Segmented bar */}
            <div className="flex gap-[2px] h-[4px] rounded-full overflow-hidden">
              {Array.from({ length: 10 }, (_, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-[1px] transition-all"
                  style={{
                    backgroundColor: i < Math.round(g.percent / 10) ? barColor : 'var(--border-light)',
                    opacity: allBlocked ? 0.5 : 1,
                  }}
                />
              ))}
            </div>

            {/* Model tags (expandable) */}
            {isExpanded && g.entries && (
              <div className="flex flex-wrap gap-1 mt-2">
                {g.entries.map((e) => (
                  <span
                    key={e.key}
                    className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded-[4px]',
                      e.isBlocked
                        ? 'bg-[var(--danger)] bg-opacity-15 text-[var(--danger)]'
                        : 'bg-[var(--bg-secondary)] text-[var(--text-muted)]'
                    )}
                  >
                    {e.label || e.key}
                    {!e.isBlocked && e.percent > 0 && ` ${Math.round(e.percent)}%`}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ===== 账号卡片组件 =====
function AccountCard({ acc, isExpanded, onToggleExpand }: {
  acc: AccountInfo
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  const { toggleAccount, removeAccount, lockAccount, unlockAccount, setAlias } = usePoolStore()
  const [editingAlias, setEditingAlias] = useState(false)
  const [aliasInput, setAliasInput] = useState(acc.alias || '')

  const tier = TIER_CONFIG[acc.qualityTier] || TIER_CONFIG.new
  const statusColor = TONE_COLORS[acc.accountStatusTone] || TONE_COLORS.muted

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
    <div className={cn('transition-all', !acc.enabled && 'opacity-50')}>
      {/* Card header (clickable to expand) */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
        onClick={onToggleExpand}
      >
        {/* Status dot */}
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }}>
          {acc.isActive && (
            <div className="w-2 h-2 rounded-full animate-ping" style={{ backgroundColor: dotColor, opacity: 0.4 }} />
          )}
        </div>

        {/* Email + info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-primary)] font-medium truncate">
              {acc.alias || acc.email}
            </span>
            {acc.alias && <span className="text-[11px] text-[var(--text-muted)] truncate">{acc.email}</span>}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {/* Plan type badge */}
            {acc.planType && (
              <Badge
                className={`text-[9px] h-4 px-1 ${
                  acc.planType === 'ultra' ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white' :
                  acc.planType === 'premium' ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white' :
                  acc.planType === 'standard' ? 'bg-[var(--warning)] text-white' :
                  ''
                }`}
                variant={!['ultra', 'premium', 'standard'].includes(acc.planType) ? 'muted' : undefined}
              >
                {acc.planType === 'ultra' ? '✦ Ultra' :
                 acc.planType === 'premium' ? '✦ AI Pro' :
                 acc.planType === 'standard' ? 'Standard' :
                 acc.planType === 'free' ? 'Free' :
                 acc.planType}
              </Badge>
            )}
            {/* Credits badge */}
            {acc.credits?.known && acc.credits.creditAmount > 0 && (
              <Badge
                variant={acc.credits.available ? 'success' : 'danger'}
                className="text-[9px] h-4 px-1"
              >
                积分 {Math.round(acc.credits.creditAmount)}
              </Badge>
            )}
            {/* Active badge */}
            {acc.isActive && (
              <Badge className="text-[9px] h-4 px-1 bg-[var(--success)] text-white">使用中</Badge>
            )}
            {/* Locked badge */}
            {acc.isLocked && (
              <Badge className="text-[9px] h-4 px-1 bg-[var(--warning)] text-white">
                <Lock size={8} className="mr-0.5" />已锁定
              </Badge>
            )}
            {/* Quality tier */}
            <span className="text-[10px]" style={{ color: tier.color }}>
              {tier.icon} {acc.successRate !== null ? `${Math.round(acc.successRate)}%` : tier.label}
            </span>
            {/* Status label */}
            <span className="text-[10px]" style={{ color: statusColor }}>{acc.accountStatusLabel}</span>
          </div>
        </div>

        {/* Right side: quick actions */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => toggleAccount(acc.id, !acc.enabled)}
            title={acc.enabled ? '禁用' : '启用'}
          >
            {acc.enabled
              ? <ToggleRight size={16} className="text-[var(--success)]" />
              : <ToggleLeft size={16} className="text-[var(--text-muted)]" />}
          </Button>
          <button
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
            onClick={onToggleExpand}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded area */}
      {isExpanded && (
        <div className="px-4 pb-3 border-t border-[var(--border-light)]">
          {/* Action buttons */}
          <div className="flex items-center gap-1.5 mt-2 mb-2 flex-wrap">
            {acc.isLocked ? (
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={() => unlockAccount()}>
                <Unlock size={11} /> 解除锁定
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={() => lockAccount(acc.id)}>
                <Lock size={11} /> 锁定账号
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] gap-1"
              onClick={() => { setEditingAlias(true); setAliasInput(acc.alias || '') }}
            >
              <Edit2 size={11} /> 别名
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] gap-1 hover:text-[var(--danger)] hover:border-[var(--danger)]"
              onClick={() => removeAccount(acc.id)}
            >
              <Trash2 size={11} /> 删除
            </Button>
          </div>

          {/* Alias editor */}
          {editingAlias && (
            <div className="flex items-center gap-2 mb-2">
              <Input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                placeholder="设置别名..."
                className="h-7 text-[12px] flex-1"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleSaveAlias()}
              />
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleSaveAlias}>
                <Check size={12} className="text-[var(--success)]" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingAlias(false)}>
                <X size={12} />
              </Button>
            </div>
          )}

          {/* Account details */}
          {acc.quotaRefreshedAt && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mb-2">
              <div className="text-[var(--text-muted)]">额度更新</div>
              <div className="text-[var(--text-primary)]">{new Date(acc.quotaRefreshedAt).toLocaleTimeString()}</div>
            </div>
          )}

          {/* Blocked models */}
          {acc.blockedModels && Object.keys(acc.blockedModels).length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] text-[var(--text-muted)] mb-1">封锁模型</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(acc.blockedModels).map(([model, until]) => (
                  <span key={model} className="text-[10px] px-1.5 py-0.5 rounded-[4px] bg-[var(--danger)] bg-opacity-10 text-[var(--danger)]">
                    {model} → {humanizeResetTime(until)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Quota panel */}
          <QuotaPanel groups={acc.quotaGroups} />
        </div>
      )}
    </div>
  )
}

// ===== 主页面 =====
export function PoolPage() {
  const {
    accounts, mode, loading, refreshing, filter, expandedIds,
    addAccount, oauthLogin, fetchAccounts, refreshQuota,
    setFilter, toggleExpand,
  } = usePoolStore()
  const { modalProps, showAlert } = useModal()
  const [activeTab, setActiveTab] = useState<'oauth' | 'token'>('oauth')

  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [profile, setProfile] = useState('antigravity')
  const [oauthProfile, setOauthProfile] = useState('antigravity')
  const [oauthStatus, setOauthStatus] = useState('')

  // 自动轮询（local 模式下每 3s 刷新账号列表）
  useEffect(() => {
    if (mode !== 'local') return
    fetchAccounts()
    const timer = setInterval(fetchAccounts, 3000)
    return () => clearInterval(timer)
  }, [mode, fetchAccounts])

  const handleAddAccount = async () => {
    if (!email.trim() || !token.trim()) {
      await showAlert('提示', '请填写邮箱和 Refresh Token')
      return
    }
    const result = await addAccount(email.trim(), token.trim(), profile)
    if (result.success) {
      setEmail('')
      setToken('')
    } else {
      await showAlert('添加失败', result.error || '未知错误')
    }
  }

  const handleOAuth = async () => {
    setOauthStatus('等待授权...')
    const result = await oauthLogin(oauthProfile)
    if (result.success) {
      setOauthStatus(`✓ ${result.email} 导入成功`)
    } else {
      setOauthStatus(`✗ ${result.error || '未知错误'}`)
    }
  }

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
    <div className="max-w-[720px]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[18px] font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Users size={20} /> 本地号池管理
          {hasLocked && (
            <Badge className="text-[10px] bg-[var(--warning)] text-white ml-1">
              <Lock size={10} className="mr-0.5" />调试模式
            </Badge>
          )}
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[12px] gap-1.5"
          onClick={refreshQuota}
          disabled={refreshing}
        >
          <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
          {refreshing ? '刷新中...' : '刷新额度'}
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Card className="px-4 py-3 text-center">
          <div className="text-xl font-bold font-mono-data text-[var(--text-primary)]">{total}</div>
          <div className="text-[11px] text-[var(--text-muted)]">总数</div>
        </Card>
        <Card className="px-4 py-3 text-center">
          <div className="text-xl font-bold font-mono-data text-[var(--success)]">{available}</div>
          <div className="text-[11px] text-[var(--text-muted)]">可用</div>
        </Card>
        <Card className="px-4 py-3 text-center">
          <div className="text-xl font-bold font-mono-data text-[var(--warning)]">{exhausted}</div>
          <div className="text-[11px] text-[var(--text-muted)]">冷却</div>
        </Card>
        <Card className="px-4 py-3 text-center">
          <div className="text-xl font-bold font-mono-data text-[var(--primary)]">{active}</div>
          <div className="text-[11px] text-[var(--text-muted)]">活跃</div>
        </Card>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-2 mb-3">
        {([
          ['all', '全部', total],
          ['active', '可用', available],
          ['error', '受限', total - available],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              'px-3 py-1 rounded-full text-[11px] font-medium transition-all',
              filter === key
                ? 'bg-[var(--primary)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]'
            )}
          >
            {label} {count}
          </button>
        ))}
      </div>

      {/* Account list */}
      <Card className="mb-4 overflow-hidden">
        {filteredAccounts.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-[var(--text-muted)]">
            {accounts.length === 0 ? '暂无账号，请在下方添加' : '没有匹配的账号'}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-light)]">
            {filteredAccounts.map((acc) => (
              <AccountCard
                key={acc.id}
                acc={acc}
                isExpanded={expandedIds.has(acc.id)}
                onToggleExpand={() => toggleExpand(acc.id)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Add account */}
      <Card>
        <CardHeader>
          <CardTitle><Plus size={15} /> 添加账号</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Tabs */}
          <div className="flex rounded-[8px] bg-[var(--bg-tertiary)] p-1 mb-4">
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
            <div>
              <p className="text-[12px] text-[var(--text-muted)] mb-3">通过 Google 账号登录自动获取 Refresh Token 并导入号池</p>
              <div className="flex gap-2 mb-2">
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
                <p className={cn('text-[12px] mt-1',
                  oauthStatus.startsWith('✓') ? 'text-[var(--success)]'
                  : oauthStatus.startsWith('✗') ? 'text-[var(--danger)]'
                  : 'text-[var(--text-muted)]'
                )}>
                  {oauthStatus}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
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
                  {loading ? '添加中...' : '+ 添加'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal {...modalProps} />
    </div>
  )
}
