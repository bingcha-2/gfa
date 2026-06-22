import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  RefreshCw, ChevronUp, ChevronDown, Settings, MessageSquare, LogOut, MonitorSmartphone, ExternalLink, KeyRound,
} from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { Modal, useModal } from '@/components/Modal'
import { ActivateCodeModal } from '@/components/ActivateCodeModal'
import * as api from '@/services/wails'
import { formatDate, cn } from '@/lib/utils'
import { productLabel } from '@/lib/usageBars'
import { useT } from '@/i18n'
import type { PageId, AccountSubscription } from '@/types'
import bcaiIcon from '@/assets/images/bcai-icon.png'

/**
 * AccountDock — 左导航栏底部的账户坞:展开态显示「会员头像 + 状态 + 邮箱」一行,
 * 折叠态收成单个头像图标(带状态点)。点击向右上弹出会员通行证面板(会员身份、
 * 订阅接力、设置/反馈/登出等账户操作)。面板用 portal + fixed 定位,避免被侧栏的
 * overflow 裁剪。
 *
 * 这是原 AccountStatusCard 的去向 —— 账户从主控制台抽到侧栏,主区只留运行与用量。
 * 设置 / 意见反馈也聚合进这里的账户菜单,左导航只留主页面入口,更清爽。
 */
export function AccountDock({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  onNavigate?: (page: PageId) => void
}) {
  const t = useT()
  const { account, logout, heartbeat, fetchStats, cardUnusable } = useAppStore()
  const { modalProps, showAlert, showConfirm } = useModal()
  const [open, setOpen] = useState(false)
  const [activateOpen, setActivateOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [orderOverride, setOrderOverride] = useState<AccountSubscription[] | null>(null)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  // 打开时按 trigger 位置算锚点(fixed,贴侧栏右缘、与 trigger 底对齐向上展开);
  // 窗口缩放时跟随重算。Esc 关闭。
  const reposition = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ left: r.right + 8, bottom: window.innerHeight - r.bottom })
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
    }
  }, [open, reposition])

  // 调序失败的 inline 提示 4s 后自动消失。
  useEffect(() => {
    if (!reorderError) return
    const id = setTimeout(() => setReorderError(null), 4000)
    return () => clearTimeout(id)
  }, [reorderError])

  if (!account) return null

  // 「是否已订阅」必须反映真实可用态(见原 AccountStatusCard 注释):卡密被标记不可用
  // 或会话失效时一律视为未订阅;否则才用「有未过期有效期」判定。
  const hasActivePlan =
    !cardUnusable &&
    !account.sessionUnusable &&
    !!account.planExpiry &&
    account.planExpiry !== 'null' &&
    new Date(account.planExpiry).getTime() > Date.now()
  const unusable = cardUnusable || account.sessionUnusable
  const planLabel =
    account.planName || (hasActivePlan ? t('account.activeMember') : t('account.noSubscription'))
  const planExpiryLabel =
    account.planExpiry && account.planExpiry !== 'null' ? formatDate(account.planExpiry) : '—'

  // 全部生效订阅,按接力顺序(priority 升序)展示;> 1 时可 ↑↓ 调序。
  // orderOverride:↑↓ 的乐观顺序(点击即时反映);写回服务端 + 心跳成功后清空,回到 account 权威序。
  const subs = orderOverride ?? [...(account.subscriptions ?? [])].sort((a, b) => a.priority - b.priority)

  const dotClass = unusable
    ? 'bg-[var(--danger)]'
    : hasActivePlan
      ? 'bg-[var(--success)] dot-pulse'
      : 'bg-[var(--text-muted)]'

  // ↑↓ 调整接力顺序:相邻交换 → 整列表重排 0..n-1 写回服务端 → 心跳刷新本地快照。
  // priority 只在多订阅覆盖「同一产品」时决定扣量先后,不影响各产品本身可用(产品并集)。
  async function moveSub(index: number, dir: -1 | 1) {
    if (reordering) return
    const j = index + dir
    if (j < 0 || j >= subs.length) return
    const next = [...subs]
    ;[next[index], next[j]] = [next[j], next[index]]
    setReordering(true)
    setReorderError(null)
    setOrderOverride(next) // 乐观:点击立即显示新顺序,不等网络往返
    try {
      // 整列表重排成稳定 0..n-1,逐个写回服务端
      for (let i = 0; i < next.length; i++) {
        await api.setSubscriptionPriority(next[i].id, i)
      }
      await heartbeat() // 拉权威顺序
      setOrderOverride(null) // 回到 account
    } catch (err) {
      // 失败:回滚 + 一行克制的 inline 提示(不弹模态框、不糊技术细节);详情进 console 供调试。
      setOrderOverride(null)
      setReorderError(t('account.reorderFailed'))
      console.error('reorder failed:', err)
    } finally {
      setReordering(false)
    }
  }

  // 手动刷新:心跳一次(重校会话 + 拉最新订阅)→ 强制拉上游额度并上报 → 刷新租号/额度态;
  // 卡密不可用时顺带重启接管。额度刷新失败不致命,不挡后续本地状态刷新。
  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await heartbeat()
      // GetStats 只读缓存快照,故先主动去上游拉一次最新余量(并上报服务端),再 fetchStats 才能看到新值。
      try {
        await api.refreshQuota()
      } catch (err) {
        console.error('refreshQuota failed:', err)
      }
      await fetchStats()
      if (useAppStore.getState().cardUnusable) {
        await api.restartProxy()
        await fetchStats()
      }
    } catch {
      // 忽略:各 store action 自行记录错误
    } finally {
      setRefreshing(false)
    }
  }

  const handleLogout = async () => {
    const confirmed = await showConfirm(t('account.logoutConfirmTitle'), t('account.logoutConfirmBody'))
    if (!confirmed) return
    setLoggingOut(true)
    try {
      await logout()
    } catch (err) {
      await showAlert('Error', String(err))
    } finally {
      setLoggingOut(false)
    }
  }

  // 会员徽记头像(带右下状态点)。折叠态和展开态共用。
  const Avatar = ({ size = 32 }: { size?: number }) => (
    <span
      className="relative grid place-items-center shrink-0 rounded-[10px] bg-[var(--bg-secondary)] border border-[var(--border-light)] shadow-[var(--shadow-sm)]"
      style={{ width: size, height: size }}
    >
      <img src={bcaiIcon} alt="" className="rounded-[7px]" style={{ width: size - 10, height: size - 10 }} />
      <span
        className={cn('absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--sidebar-bg)]', dotClass)}
      />
    </span>
  )

  // 账户菜单行(普通渲染函数,非组件 —— 避免每次 render 卸载重挂)。
  const menuRow = (
    Icon: typeof Settings,
    label: string,
    onClick: () => void,
    opts?: { external?: boolean; danger?: boolean; disabled?: boolean },
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={opts?.disabled}
      className={cn(
        'w-full flex items-center gap-2.5 px-3.5 py-2 text-[12px] transition-colors disabled:opacity-50',
        opts?.danger
          ? 'text-[var(--danger)] hover:bg-[var(--bg-hover)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={15} className={opts?.danger ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'} />
      <span className="flex-1 text-left">{label}</span>
      {opts?.external && <ExternalLink size={12} className="text-[var(--text-muted)]" />}
    </button>
  )

  return (
    <>
      {/* ── 触发行:展开态= 头像 + 状态/邮箱 + chevron;折叠态= 头像图标 ── */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={collapsed ? planLabel : undefined}
        className={cn(
          'flex items-center rounded-[10px] transition-colors w-full',
          collapsed ? 'justify-center p-1.5' : 'gap-2.5 p-2',
          open ? 'bg-[var(--primary-light)]' : 'hover:bg-[var(--bg-hover)]',
        )}
      >
        <Avatar />
        {!collapsed && (
          <>
            <span className="flex flex-col min-w-0 flex-1 text-left">
              <span className="text-[12px] font-semibold text-[var(--text-primary)] truncate">{planLabel}</span>
              <span className="text-[10px] text-[var(--text-muted)] font-mono-data truncate">{account.email || '—'}</span>
            </span>
            <ChevronUp size={15} className={cn('shrink-0 transition-transform text-[var(--text-muted)]', open && 'rotate-180')} />
          </>
        )}
      </button>

      {/* ── 会员通行证面板(portal + fixed,避免侧栏裁剪)── */}
      {open && pos && createPortal(
        <>
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 cursor-default bg-transparent border-0 z-[var(--z-overlay)]"
          />
          <div
            role="dialog"
            aria-label={t('account.title')}
            className="account-pop-in fixed w-[268px] rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-[var(--shadow-lg)] overflow-hidden z-[var(--z-overlay)]"
            style={{
              left: pos.left,
              bottom: pos.bottom,
              maxHeight: 'min(72vh, 560px)',
              overflowY: 'auto',
            }}
          >
            {/* 会员身份头:琥珀光晕 + 冰茶徽记 + MEMBERSHIP 眉标 */}
            <div className="relative px-3.5 pt-3.5 pb-3 border-b border-[var(--border-light)] overflow-hidden">
              <div
                className="pointer-events-none absolute -top-9 -right-6 w-32 h-20 rounded-full"
                style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
                aria-hidden
              />
              <div className="relative flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar size={36} />
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--text-muted)]">
                      MEMBERSHIP · 冰茶AI
                    </div>
                    <div className="text-[15px] font-bold text-[var(--text-primary)] leading-tight mt-0.5 truncate">
                      {planLabel}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title={t('account.refresh')}
                  aria-label={t('account.refresh')}
                  className="grid place-items-center w-7 h-7 shrink-0 rounded-[8px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                </button>
              </div>
              {/* 会话失效 → 真要重新登录;卡可用态(订阅到期/无生效订阅)→ 提示续费,别叫用户重登。 */}
              {account.sessionUnusable ? (
                <div className="relative mt-2 text-[11px] text-[var(--danger)]">{t('account.sessionExpired')}</div>
              ) : cardUnusable ? (
                <div className="relative mt-2 text-[11px] text-[var(--danger)]">{t('account.subscriptionExpired')}</div>
              ) : null}
            </div>

            {/* 明细:邮箱 / 到期(单订阅或无数组时)/ 设备 / 订阅接力 */}
            <div className="px-3.5 py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[var(--text-muted)]">{t('account.email')}</span>
                <span className="text-[12px] font-medium text-[var(--text-primary)] font-mono-data truncate max-w-[170px]">
                  {account.email || '—'}
                </span>
              </div>

              {hasActivePlan && subs.length <= 1 && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[var(--text-muted)]">{t('account.planExpiry')}</span>
                  <span className="text-[12px] text-[var(--text-secondary)]">{planExpiryLabel}</span>
                </div>
              )}

              {account.deviceName && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[var(--text-muted)]">{t('account.deviceName')}</span>
                  <span className="text-[11px] text-[var(--text-secondary)] font-mono-data truncate max-w-[160px]">
                    {account.deviceName}
                  </span>
                </div>
              )}

              {/* 多订阅接力区:>1 才显示。每条两行 —— 产品 / 设备数·订阅短号·到期(让同产品同到期
                  的订阅也能凭设备档位与短号区分);首条= 当前优先(琥珀 tint);↑↓ 调序。 */}
              {subs.length > 1 && (
                <div className="mt-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                      {t('account.mySubscriptions')}
                    </span>
                    <span className="text-[12px] text-[var(--text-muted)]">· {subs.length}</span>
                  </div>
                  <p className="text-[11px] leading-snug text-[var(--text-muted)] mt-0.5 mb-2">
                    {t('account.relayHint')}
                  </p>

                  {reorderError && (
                    <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--danger)]">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
                      {reorderError}
                    </div>
                  )}

                  <div className="flex flex-col gap-0.5">
                    {subs.map((sub, i) => {
                      const first = i === 0
                      const shortId = sub.id.slice(-4).toUpperCase()
                      const exp =
                        sub.expiresAt && sub.expiresAt !== 'null'
                          ? formatDate(sub.expiresAt)
                          : t('account.neverExpires')
                      // 余量条:取最紧复合桶剩余比例,健康度配色(≥40%绿/15-40%橙/<15%红);
                      // null=无限额/无数据 → 显示「无限额」。两个同产品同到期的订阅靠这条一眼分清。
                      const remain = sub.remainFraction
                      const pct = remain == null ? null : Math.round(remain * 100)
                      const meterColor =
                        remain == null
                          ? ''
                          : remain < 0.15
                            ? 'var(--danger)'
                            : remain < 0.4
                              ? 'var(--warning)'
                              : 'var(--success)'
                      return (
                        <div
                          key={sub.id}
                          className={cn(
                            'flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 transition-colors',
                            first ? 'bg-[var(--primary-light)]' : 'hover:bg-[var(--bg-tertiary)]',
                          )}
                          style={reordering ? { opacity: 0.55 } : undefined}
                        >
                          <span
                            className={cn(
                              'grid place-items-center w-[21px] h-[21px] shrink-0 rounded-[7px] text-[11px] font-bold',
                              first
                                ? 'bg-[var(--primary)] text-[var(--primary-ink)]'
                                : 'bg-[var(--bg-tertiary)] border border-[var(--border-light)] text-[var(--text-muted)]',
                            )}
                          >
                            {i + 1}
                          </span>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {sub.products.length > 0 ? (
                                sub.products.map((p) => (
                                  <span
                                    key={p}
                                    className="px-1.5 py-0.5 rounded-[6px] text-[11px] bg-[var(--bg-secondary)] border border-[var(--border-light)] text-[var(--text-secondary)]"
                                  >
                                    {productLabel(p)}
                                  </span>
                                ))
                              ) : (
                                <span className="text-[11px] text-[var(--text-secondary)]">{t('account.activeMember')}</span>
                              )}
                              {first && (
                                <span className="text-[11px] font-semibold text-[var(--primary-strong)]">
                                  {t('account.priorityTag')}
                                </span>
                              )}
                            </div>
                            {remain != null ? (
                              <div className="flex items-center gap-2 mt-1.5">
                                <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                                  <div
                                    className="h-full rounded-full transition-[width]"
                                    style={{ width: `${pct}%`, backgroundColor: meterColor }}
                                  />
                                </div>
                                <span className="text-[10px] font-mono-data shrink-0" style={{ color: meterColor }}>
                                  {pct}%
                                </span>
                              </div>
                            ) : (
                              <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">{t('account.unlimited')}</div>
                            )}
                            <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--text-muted)] font-mono-data">
                              {sub.deviceLimit > 0 && (
                                <>
                                  <span className="inline-flex items-center gap-0.5">
                                    <MonitorSmartphone size={11} />
                                    {sub.deviceLimit}
                                  </span>
                                  <span className="text-[var(--border)]">·</span>
                                </>
                              )}
                              <span>#{shortId}</span>
                              <span className="text-[var(--border)]">·</span>
                              <span>{exp}</span>
                            </div>
                          </div>

                          <div className="flex flex-col shrink-0 -my-0.5">
                            <button
                              type="button"
                              onClick={() => moveSub(i, -1)}
                              disabled={first || reordering}
                              aria-label={t('account.moveUp')}
                              className="grid place-items-center w-6 h-[18px] text-[var(--text-muted)] hover:text-[var(--primary)] transition-colors disabled:opacity-25 disabled:hover:text-[var(--text-muted)]"
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveSub(i, 1)}
                              disabled={i === subs.length - 1 || reordering}
                              aria-label={t('account.moveDown')}
                              className="grid place-items-center w-6 h-[18px] text-[var(--text-muted)] hover:text-[var(--primary)] transition-colors disabled:opacity-25 disabled:hover:text-[var(--text-muted)]"
                            >
                              <ChevronDown size={14} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 账户菜单:激活码 / 管理设备 / 设置 / 意见反馈 ── 设置与反馈从左导航收纳到此 */}
            <div className="border-t border-[var(--border-light)] py-1.5">
              {menuRow(KeyRound, t('account.activateCode'), () => {
                setActivateOpen(true)
                setOpen(false)
              })}
              {menuRow(MonitorSmartphone, t('account.manageDevices'), () => api.openURL(api.PORTAL_URLS.devices), { external: true })}
              {menuRow(Settings, t('nav.settings'), () => {
                onNavigate?.('settings')
                setOpen(false)
              })}
              {menuRow(MessageSquare, t('nav.feedback'), () => api.openURL(api.PORTAL_URLS.home), { external: true })}
            </div>
            <div className="border-t border-[var(--border-light)] py-1.5">
              {menuRow(LogOut, loggingOut ? '...' : t('account.logout'), handleLogout, { danger: true, disabled: loggingOut })}
            </div>
          </div>
        </>,
        document.body,
      )}

      <Modal {...modalProps} />
      <ActivateCodeModal
        open={activateOpen}
        onClose={() => setActivateOpen(false)}
        onActivated={() => { void heartbeat() }}
      />
    </>
  )
}
