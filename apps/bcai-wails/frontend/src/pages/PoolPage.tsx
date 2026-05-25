import { useState } from 'react'
import { usePoolStore } from '@/stores/usePoolStore'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Plus, Trash2, ToggleLeft, ToggleRight, Globe, Key, Users } from 'lucide-react'

export function PoolPage() {
  const { accounts, mode, loading, addAccount, removeAccount, toggleAccount, oauthLogin } = usePoolStore()
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

  const total = accounts.length
  const available = accounts.filter((a) => a.enabled && a.quotaStatus !== 'exhausted').length
  const exhausted = accounts.filter((a) => a.quotaStatus === 'exhausted').length
  const withToken = accounts.filter((a) => a.hasAccessToken).length

  return (
    <div className="max-w-[720px]">
      <h2 className="text-[18px] font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2">
        <Users size={20} /> 本地号池管理
      </h2>

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
          <div className="text-xl font-bold font-mono-data text-[var(--primary)]">{withToken}</div>
          <div className="text-[11px] text-[var(--text-muted)]">活跃</div>
        </Card>
      </div>

      {/* Account list */}
      <Card className="mb-4 overflow-hidden">
        {accounts.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-[var(--text-muted)]">暂无账号，请在下方添加</div>
        ) : (
          <div className="divide-y divide-[var(--border-light)]">
            {accounts.map((acc) => {
              let dotColor = 'bg-[var(--success)]'
              if (!acc.enabled) dotColor = 'bg-[var(--text-muted)]'
              else if (acc.quotaStatus === 'exhausted') dotColor = 'bg-[var(--warning)]'
              else if (acc.consecutiveErrors >= 3) dotColor = 'bg-[var(--danger)]'

              return (
                <div key={acc.id} className={cn('flex items-center gap-3 px-4 py-3', !acc.enabled && 'opacity-50')}>
                  <div className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColor)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[var(--text-primary)] font-medium truncate">{acc.email}</div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate">
                      {[
                        acc.oauthProfile,
                        acc.hasAccessToken && `token: ${acc.tokenExpiresIn}s`,
                        acc.quotaStatus === 'exhausted' && '冷却中',
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => toggleAccount(acc.id, !acc.enabled)}
                      title={acc.enabled ? '禁用' : '启用'}
                    >
                      {acc.enabled
                        ? <ToggleRight size={16} className="text-[var(--success)]" />
                        : <ToggleLeft size={16} className="text-[var(--text-muted)]" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removeAccount(acc.id)}
                      title="删除"
                      className="hover:text-[var(--danger)]"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              )
            })}
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
