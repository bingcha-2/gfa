import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  Filter,
  FolderOpen,
  Gauge,
  Gift,
  Globe2,
  KeyRound,
  Languages,
  ListFilter,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  UserRound,
  Wifi,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/ProviderLogo'
import { cn } from '@/lib/utils'

function PageHeader({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-5">
      <div><h1 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">{title}</h1><p className="mt-1 text-[11px] text-[var(--text-secondary)]">{subtitle}</p></div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

function InlineStatus({ tone = 'success', children }: { tone?: 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[9px] font-semibold',
      tone === 'success' ? 'bg-[var(--success)]/10 text-[var(--success-strong)]' : tone === 'warning' ? 'bg-[var(--warning)]/10 text-[var(--warning-deep)]' : 'bg-[var(--danger)]/10 text-[var(--danger)]',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'success' ? 'bg-[var(--success)]' : tone === 'warning' ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]')} />{children}
    </span>
  )
}

function UsageMeter({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'good' | 'warning' }) {
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
      <span className={cn('block h-full rounded-full', tone === 'good' ? 'bg-[var(--success)]' : tone === 'warning' ? 'bg-[var(--warning)]' : 'bg-[var(--primary)]')} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  )
}

function RatioQuota({ label, remaining, reset }: { label: string; remaining: number; reset: string }) {
  const percent = Math.max(0, Math.min(100, remaining))
  const tone = percent < 20 ? 'warning' : percent > 60 ? 'good' : 'brand'
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2"><span className="text-[8px] font-semibold text-[var(--text-secondary)]">{label}</span><span className="font-mono-data text-[8px] text-[var(--warning-deep)]">{reset}</span></div>
      <UsageMeter value={percent} tone={tone} />
      <div className="mt-1 flex justify-between text-[7px] text-[var(--text-muted)]">
        <span>剩余 {percent}%</span>
      </div>
    </div>
  )
}

function Segmented({ items, value, onChange }: { items: string[]; value: string; onChange: (next: string) => void }) {
  return (
    <div className="inline-flex rounded-[8px] bg-[var(--bg-tertiary)] p-0.5">
      {items.map((item) => <button key={item} type="button" onClick={() => onChange(item)} className={cn('rounded-[6px] px-2.5 py-1 text-[9px] font-semibold transition-colors', item === value ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>{item}</button>)}
    </div>
  )
}

export function DashboardPreview() {
  const [range, setRange] = useState('今日')
  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">
      <PageHeader
        title="用量看板"
        subtitle="订阅余量、本机调用和官方 API 价值放在同一视图"
        actions={<><Segmented items={['今日', '7 天', '30 天']} value={range} onChange={setRange} /><Button size="sm" variant="secondary"><RefreshCw size={13} />刷新额度</Button></>}
      />

      <section className="overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-[var(--border-light)] px-5 py-3">
          <div className="flex items-center gap-3"><InlineStatus>代理运行中</InlineStatus><span className="font-mono-data text-[9px] text-[var(--text-muted)]">127.0.0.1:48800</span><span className="h-3 w-px bg-[var(--border-light)]" /><span className="text-[9px] text-[var(--text-muted)]">当前服务账号 <b className="text-[var(--text-secondary)]">#2187</b></span></div>
          <span className="text-[9px] text-[var(--text-muted)]">刚刚同步</span>
        </div>
        <div className="grid grid-cols-[1.35fr_.85fr]">
          <div className="border-r border-[var(--border-light)] px-5 py-5">
            <p className="text-[10px] font-medium text-[var(--text-muted)]">{range}总 Token</p>
            <div className="mt-1 flex items-baseline gap-3"><span className="font-mono-data text-[30px] font-bold tracking-[-0.04em] text-[var(--text-primary)]">2.60M</span><span className="inline-flex items-center gap-1 text-[9px] font-semibold text-[var(--success-strong)]"><ArrowUpRight size={11} />12.4%</span></div>
            <div className="mt-4 grid grid-cols-4 gap-5 border-t border-[var(--border-light)] pt-4">
              <div><p className="text-[9px] text-[var(--text-muted)]">成功调用</p><p className="mt-1 font-mono-data text-[14px] font-semibold text-[var(--text-primary)]">128</p></div>
              <div><p className="text-[9px] text-[var(--text-muted)]">错误 / 错误率</p><p className="mt-1 font-mono-data text-[14px] font-semibold text-[var(--text-primary)]">2 · 1.5%</p></div>
              <div><p className="text-[9px] text-[var(--text-muted)]">缓存读 / 写</p><p className="mt-1 font-mono-data text-[14px] font-semibold text-[var(--text-primary)]">890K / 120K</p></div>
              <div><p className="text-[9px] text-[var(--text-muted)]">其中 Fast</p><p className="mt-1 font-mono-data text-[14px] font-semibold text-[var(--text-primary)]">318K</p></div>
            </div>
          </div>
          <div className="grid grid-rows-2 divide-y divide-[var(--border-light)]">
            <div className="px-5 py-4">
              <p className="text-[9px] text-[var(--text-muted)]">今日官方 API 价值</p>
              <div className="mt-1 flex items-baseline gap-2"><span className="font-mono-data text-[22px] font-bold text-[var(--primary-strong)]">$47.30</span><span className="text-[8px] text-[var(--text-muted)]">含缓存价格</span></div>
              <p className="mt-1 text-[8px] text-[var(--text-muted)]">按模型真实输入、输出、缓存读写价格折算</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[9px] text-[var(--text-muted)]">累计 API 价值 · 已节省</p>
              <div className="mt-1 flex items-baseline gap-2"><span className="font-mono-data text-[22px] font-bold text-[var(--text-primary)]">$12,345.67</span><span className="inline-flex items-center gap-1 text-[8px] font-semibold text-[var(--success-strong)]"><ArrowUpRight size={10} />本月 $1,284.20</span></div>
              <p className="mt-1 text-[8px] text-[var(--text-muted)]">从首次使用起，按官方 API 定价累计</p>
            </div>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between px-4 py-3">
          <div><div className="flex items-center gap-2"><h2 className="text-[11px] font-bold text-[var(--text-primary)]">订阅与额度</h2><span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[8px] font-semibold text-[var(--text-muted)]">3 条生效订阅</span></div><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">Codex 与 Anthropic 按产品独立显示拼车份数与剩余比例</p></div>
          <div className="flex items-center gap-3"><button className="text-[9px] font-semibold text-[var(--primary-strong)]">调整接力顺序</button><Button size="sm" variant="secondary"><RefreshCw size={12} />刷新全部额度</Button></div>
        </div>

        <div className="grid grid-cols-[150px_1fr_1fr_120px] border-y border-[var(--border-light)] bg-[var(--bg-tertiary)]/55 px-4 py-2 text-[8px] font-semibold text-[var(--text-muted)]"><span>订阅 / 产品</span><span>5h 余量</span><span>周余量</span><span>拼车份数</span></div>

        <div className="grid grid-cols-[150px_1fr_1fr_120px] items-center gap-x-4 px-4 py-3.5">
          <div className="min-w-0"><div className="flex items-center gap-2"><ProviderLogo provider="anthropic" size={12} /><span className="text-[9px] font-bold text-[var(--text-primary)]">Anthropic · Claude</span></div><div className="mt-1.5 flex flex-wrap gap-1"><span className="rounded-[5px] bg-[var(--primary-light)] px-1.5 py-0.5 text-[7px] font-semibold text-[var(--primary-strong)]">Max 20x</span><span className="font-mono-data text-[7px] text-[var(--text-muted)]">#T6HM</span></div></div>
          <RatioQuota label="5h 窗口" remaining={72} reset="1h 42m 后恢复" />
          <RatioQuota label="周窗口" remaining={64} reset="4天 8h 后恢复" />
          <div className="min-w-0"><p className="font-mono-data text-[12px] font-bold text-[var(--text-primary)]">2 份</p></div>
        </div>

        <div className="grid grid-cols-[150px_1fr_1fr_120px] items-center gap-x-4 border-t border-[var(--border-light)] px-4 py-3.5">
          <div className="min-w-0"><div className="flex items-center gap-2"><ProviderLogo provider="codex" size={12} /><span className="text-[9px] font-bold text-[var(--text-primary)]">Codex · GPT</span></div><div className="mt-1.5 flex flex-wrap gap-1"><span className="rounded-[5px] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[7px] font-semibold text-[var(--text-secondary)]">Pro 20x</span><span className="font-mono-data text-[7px] text-[var(--text-muted)]">#9Q2X</span></div></div>
          <RatioQuota label="5h 窗口" remaining={100} reset="暂无限制" />
          <RatioQuota label="周窗口" remaining={77} reset="周一恢复" />
          <div className="min-w-0"><p className="font-mono-data text-[12px] font-bold text-[var(--text-primary)]">3 份</p></div>
        </div>

        <div className="grid grid-cols-[150px_1fr_1fr_120px] gap-x-4 border-t border-[var(--border-light)] px-4 py-3.5">
          <div className="min-w-0 pt-0.5"><div className="flex items-center gap-2"><ProviderLogo provider="antigravity" size={12} /><span className="text-[9px] font-bold text-[var(--text-primary)]">Antigravity</span></div><div className="mt-1.5 flex flex-wrap gap-1"><span className="rounded-[5px] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[7px] font-semibold text-[var(--text-secondary)]">Ultra</span><span className="rounded-[5px] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[7px] text-[var(--text-muted)]">Claude + Gemini</span><span className="font-mono-data text-[7px] text-[var(--text-muted)]">#7LKA</span></div></div>
          <div className="self-center text-[8px] text-[var(--text-muted)]">沿用 Antigravity 固定产品算法</div>
          <div className="self-center text-[8px] text-[var(--text-muted)]">不与订阅比例混算</div>
          <div className="min-w-0 pt-0.5"><p className="font-mono-data text-[12px] font-bold text-[var(--text-primary)]">1 份</p><p className="mt-1 text-[7px] text-[var(--text-muted)]">独立额度体系</p></div>
        </div>
      </section>

      <div className="grid grid-cols-[1.6fr_0.8fr] gap-3">
        <section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4">
          <div className="flex items-center justify-between"><div><h2 className="text-[11px] font-bold text-[var(--text-primary)]">调用趋势</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">按小时汇总输入、输出与缓存命中</p></div><div className="flex items-center gap-3 text-[8px] text-[var(--text-muted)]"><span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />总 Token</span><span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />缓存读</span></div></div>
          <div className="mt-3 h-[164px] overflow-hidden">
            <svg viewBox="0 0 620 164" className="h-full w-full" preserveAspectRatio="none" aria-label="调用趋势图">
              {[30, 70, 110, 150].map((y) => <line key={y} x1="0" x2="620" y1={y} y2={y} stroke="var(--border-light)" strokeWidth="1" />)}
              <path d="M0 138 C50 126 74 130 110 106 S176 96 218 111 S290 64 330 78 S388 42 428 59 S510 52 620 24" fill="none" stroke="var(--primary)" strokeWidth="2.5" />
              <path d="M0 148 C56 142 88 132 124 138 S196 114 240 124 S312 102 354 112 S440 86 482 98 S558 82 620 74" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            </svg>
          </div>
          <div className="flex justify-between font-mono-data text-[8px] text-[var(--text-muted)]"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>现在</span></div>
        </section>

        <section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4">
          <div className="flex items-center justify-between"><h2 className="text-[11px] font-bold text-[var(--text-primary)]">最近活动</h2><button className="text-[9px] text-[var(--text-muted)]"><MoreHorizontal size={15} /></button></div>
          <div className="mt-3 divide-y divide-[var(--border-light)]">
            {[
              ['claude-opus-4.5', '成功', '18.2K', '刚刚'],
              ['gpt-5.5-codex', '成功', '42.8K', '2 分钟'],
              ['claude-sonnet-4.5', '重试', '9.1K', '5 分钟'],
              ['gemini-3-pro', '成功', '27.4K', '8 分钟'],
            ].map(([model, status, tokens, time]) => (
              <div key={model} className="flex items-center gap-2 py-2.5"><span className={cn('h-1.5 w-1.5 rounded-full', status === '成功' ? 'bg-[var(--success)]' : 'bg-[var(--warning)]')} /><div className="min-w-0 flex-1"><div className="truncate font-mono-data text-[9px] text-[var(--text-primary)]">{model}</div><div className="mt-0.5 text-[8px] text-[var(--text-muted)]">{status} · {time}</div></div><span className="font-mono-data text-[9px] text-[var(--text-secondary)]">{tokens}</span></div>
            ))}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between px-4 py-3"><div><h2 className="text-[11px] font-bold text-[var(--text-primary)]">今日模型明细</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">输入、输出、缓存、Fast 与价值口径完整保留</p></div><button className="flex items-center gap-1 text-[9px] font-semibold text-[var(--text-secondary)]"><ListFilter size={12} />筛选</button></div>
        <div className="grid grid-cols-[1.55fr_.55fr_.78fr_.78fr_.78fr_.78fr_.82fr_.7fr_.75fr_.62fr] border-y border-[var(--border-light)] bg-[var(--bg-tertiary)]/60 px-4 py-2 text-[7px] font-semibold text-[var(--text-muted)]"><span>模型</span><span className="text-right">请求</span><span className="text-right">输入</span><span className="text-right">输出</span><span className="text-right">缓存读</span><span className="text-right">缓存写</span><span className="text-right">合计</span><span className="text-right">Fast</span><span className="text-right">API 价值</span><span className="text-right">占比</span></div>
        {[
          ['claude-opus-4.5', '43', '610K', '182K', '430K', '58K', '1.28M', '—', '$24.80', '52.4%'],
          ['gpt-5.5-codex', '38', '522K', '91K', '284K', '35K', '932K', '318K', '$13.42', '28.4%'],
          ['claude-sonnet-4.5', '29', '338K', '54K', '151K', '19K', '562K', '—', '$6.91', '14.6%'],
          ['gemini-3-pro', '18', '120K', '13K', '25K', '8K', '166K', '—', '$2.17', '4.6%'],
        ].map((row) => <div key={row[0]} className="grid grid-cols-[1.55fr_.55fr_.78fr_.78fr_.78fr_.78fr_.82fr_.7fr_.75fr_.62fr] px-4 py-2.5 text-[8px] text-[var(--text-secondary)] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-[var(--border-light)]"><span className="font-mono-data text-[var(--text-primary)]">{row[0]}</span>{row.slice(1).map((cell, index) => <span key={index} className={cn('text-right font-mono-data', index === 6 && cell !== '—' && 'text-[var(--primary-strong)]')}>{cell}</span>)}</div>)}
      </section>

      <div className="grid grid-cols-2 gap-3">
        <button type="button" className="flex items-center gap-3 rounded-[13px] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3 text-left hover:border-[var(--border)]"><span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--bg-tertiary)] text-[var(--primary-strong)]"><ShoppingBag size={16} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold text-[var(--text-primary)]">冰茶商店</p><p className="mt-0.5 truncate text-[8px] text-[var(--text-muted)]">购买通行证、充值与查看现有商品</p></div><ExternalLink size={12} className="text-[var(--primary-strong)]" /></button>
        <button type="button" className="flex items-center gap-3 rounded-[13px] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3 text-left hover:border-[var(--border)]"><span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--bg-tertiary)] text-[var(--primary-strong)]"><Zap size={16} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold text-[var(--text-primary)]">API 中转服务</p><p className="mt-0.5 truncate text-[8px] text-[var(--text-muted)]">按量调用、查看余额与管理 API Key</p></div><ExternalLink size={12} className="text-[var(--primary-strong)]" /></button>
      </div>

      <div className="flex items-center gap-2 px-1 pb-2 font-mono-data text-[8px] text-[var(--text-muted)]"><span>当前服务账号 #2187</span><span>·</span><span>租约正常</span><span>·</span><span>自动续租运行中</span></div>
    </div>
  )
}

type ProviderName = 'codex' | 'antigravity'

const LOCAL_TABS = ['账号', 'API 网关', '会话', '保活', '设置']

export function LocalProviderPreview({ provider }: { provider: ProviderName }) {
  const [tab, setTab] = useState('账号')
  const isCodex = provider === 'codex'
  const accounts = isCodex
    ? [
      ['primary@openai.com', 'Pro', '可用', 76, 62, '当前接管'],
      ['team@openai.com', 'Team', '可用', 91, 84, '备用'],
      ['backup@openai.com', 'Plus', '冷却', 18, 47, '备用'],
    ]
    : [
      ['ag-main@gmail.com', 'Ultra', '可用', 83, 70, 'IDE'],
      ['ag-backup@gmail.com', 'Premium', '可用', 65, 54, '独立版'],
      ['ag-cold@gmail.com', 'Pro', '需登录', 0, 0, '未使用'],
    ]

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">
      <PageHeader
        title={isCodex ? 'Codex 本地账号' : 'Antigravity 本地账号'}
        subtitle={isCodex ? '账号注入、会话迁移和 API 网关集中管理' : '按客户端管理本地自有号与官方登录态'}
        actions={<><InlineStatus>{accounts.filter((item) => item[2] === '可用').length} 个账号可用</InlineStatus><Button size="sm"><Plus size={13} />添加账号</Button></>}
      />

      <div className="flex items-center justify-between border-b border-[var(--border-light)]">
        <div className="flex gap-5">{LOCAL_TABS.map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={cn('relative pb-2.5 text-[10px] font-semibold', item === tab ? 'text-[var(--primary-strong)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>{item}</button>)}</div>
        <span className="pb-2.5 text-[8px] text-[var(--text-muted)]">所有数据仅保存在本机</span>
      </div>

      {tab === '账号' && (
        <>
          <section className="grid grid-cols-4 overflow-hidden rounded-[13px] border border-[var(--border-light)] bg-[var(--bg-card)] divide-x divide-[var(--border-light)]">
            {[
              ['账号总数', String(accounts.length), UserRound],
              ['当前接管', '1', ShieldCheck],
              ['今日请求', isCodex ? '84' : '47', Activity],
              ['需要处理', '1', AlertTriangle],
            ].map(([label, value, Icon]) => <div key={String(label)} className="flex items-center gap-3 px-4 py-3.5"><span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"><Icon size={14} /></span><div><p className="text-[8px] text-[var(--text-muted)]">{label as string}</p><p className="mt-0.5 font-mono-data text-[14px] font-semibold text-[var(--text-primary)]">{value as string}</p></div></div>)}
          </section>

          <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">
            <div className="flex items-center justify-between px-4 py-3"><div><h2 className="text-[11px] font-bold text-[var(--text-primary)]">账号池</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">接管时按优先级选择可用账号</p></div><div className="flex gap-2"><Button size="sm" variant="secondary"><RefreshCw size={12} />刷新全部</Button><Button size="sm" variant="secondary"><FileCode2 size={12} />批量导入</Button></div></div>
            <div className="grid grid-cols-[1.5fr_.55fr_.55fr_1fr_1fr_.65fr_32px] border-y border-[var(--border-light)] bg-[var(--bg-tertiary)]/60 px-4 py-2 text-[8px] font-semibold text-[var(--text-muted)]"><span>账号</span><span>套餐</span><span>状态</span><span>5h 余量</span><span>周余量</span><span>用途</span><span /></div>
            {accounts.map(([email, plan, status, hourly, weekly, usage]) => (
              <div key={String(email)} className="grid grid-cols-[1.5fr_.55fr_.55fr_1fr_1fr_.65fr_32px] items-center px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-[var(--border-light)]">
                <div className="flex min-w-0 items-center gap-2.5"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[var(--bg-tertiary)]"><ProviderLogo provider={provider} size={11} /></span><div className="min-w-0"><div className="truncate text-[10px] font-semibold text-[var(--text-primary)]">{email}</div><div className="mt-0.5 font-mono-data text-[8px] text-[var(--text-muted)]">id_{String(email).slice(0, 6)}</div></div></div>
                <span className="text-[9px] text-[var(--text-secondary)]">{plan}</span>
                <span className={cn('text-[9px] font-semibold', status === '可用' ? 'text-[var(--success-strong)]' : status === '冷却' ? 'text-[var(--warning-deep)]' : 'text-[var(--danger)]')}>{status}</span>
                <div className="pr-4"><div className="mb-1 flex justify-between font-mono-data text-[8px] text-[var(--text-muted)]"><span>{hourly}%</span><span>5h</span></div><UsageMeter value={Number(hourly)} tone={Number(hourly) > 50 ? 'good' : 'warning'} /></div>
                <div className="pr-4"><div className="mb-1 flex justify-between font-mono-data text-[8px] text-[var(--text-muted)]"><span>{weekly}%</span><span>7d</span></div><UsageMeter value={Number(weekly)} /></div>
                <span className="text-[8px] text-[var(--text-muted)]">{usage}</span>
                <button type="button" className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><MoreHorizontal size={14} /></button>
              </div>
            ))}
          </section>
        </>
      )}

      {tab === 'API 网关' && <GatewayPreview provider={provider} />}
      {tab === '会话' && <SessionsPreview />}
      {tab === '保活' && <WakeupPreview />}
      {tab === '设置' && <LocalSettingsPreview provider={provider} />}
    </div>
  )
}

function GatewayPreview({ provider }: { provider: ProviderName }) {
  return (
    <div className="grid grid-cols-[1.05fr_.95fr] gap-3">
      <section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4">
        <div className="flex items-start justify-between"><div className="flex items-center gap-2.5"><span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--success)]/10 text-[var(--success-strong)]"><Server size={17} /></span><div><h2 className="text-[11px] font-bold text-[var(--text-primary)]">本地 API 网关</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">OpenAI / Responses / Anthropic 兼容</p></div></div><InlineStatus>运行中</InlineStatus></div>
        <div className="mt-4 rounded-[10px] bg-[var(--bg-tertiary)] p-3"><div className="flex items-center justify-between"><span className="text-[9px] text-[var(--text-muted)]">Base URL</span><button className="text-[var(--text-muted)]"><Copy size={12} /></button></div><div className="mt-1.5 font-mono-data text-[11px] text-[var(--text-primary)]">http://127.0.0.1:8317/v1</div></div>
        <div className="mt-4 grid grid-cols-3 divide-x divide-[var(--border-light)]"><div><p className="text-[8px] text-[var(--text-muted)]">活跃账号</p><p className="mt-1 font-mono-data text-[14px] font-semibold">2</p></div><div className="pl-4"><p className="text-[8px] text-[var(--text-muted)]">今日请求</p><p className="mt-1 font-mono-data text-[14px] font-semibold">318</p></div><div className="pl-4"><p className="text-[8px] text-[var(--text-muted)]">平均延迟</p><p className="mt-1 font-mono-data text-[14px] font-semibold">842ms</p></div></div>
        <div className="mt-4 flex gap-2"><Button size="sm" variant="secondary"><RefreshCw size={12} />连通测试</Button><Button size="sm" variant="danger">停止网关</Button></div>
      </section>
      <section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center justify-between"><h2 className="text-[11px] font-bold text-[var(--text-primary)]">路由与访问</h2><Settings2 size={14} className="text-[var(--text-muted)]" /></div>
        <div className="mt-4 space-y-4">
          <div><p className="mb-2 text-[9px] font-semibold text-[var(--text-secondary)]">账号策略</p><Segmented items={['轮询', '优先', '公平分摊']} value="公平分摊" onChange={() => {}} /></div>
          <div className="flex items-center justify-between border-t border-[var(--border-light)] pt-3"><div><p className="text-[10px] font-semibold text-[var(--text-primary)]">仅本机访问</p><p className="mt-0.5 text-[8px] text-[var(--text-muted)]">局域网设备无法连接此网关</p></div><ShieldCheck size={17} className="text-[var(--success-strong)]" /></div>
          <div className="flex items-center justify-between border-t border-[var(--border-light)] pt-3"><div><p className="text-[10px] font-semibold text-[var(--text-primary)]">服务密钥</p><p className="mt-0.5 font-mono-data text-[8px] text-[var(--text-muted)]">bcai_sk_92••••8E1A</p></div><Button size="sm" variant="secondary"><KeyRound size={12} />管理</Button></div>
        </div>
      </section>
      <section className="col-span-2 overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between px-4 py-3"><div><h2 className="text-[11px] font-bold text-[var(--text-primary)]">最近请求</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">网关运行日志，自动刷新</p></div><button className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]"><Filter size={12} />筛选</button></div>
        {['POST /v1/responses · gpt-5.5-codex · 200 · 1.2s','POST /v1/chat/completions · gpt-5.5 · 200 · 840ms','POST /v1/messages · claude-opus-4.5 · 429 · 320ms'].map((line, index) => <div key={line} className="flex items-center gap-3 border-t border-[var(--border-light)] px-4 py-2.5"><span className={cn('font-mono-data text-[8px]', index === 2 ? 'text-[var(--danger)]' : 'text-[var(--success-strong)]')}>{index === 2 ? 'ERR' : 'OK'}</span><span className="min-w-0 flex-1 truncate font-mono-data text-[9px] text-[var(--text-secondary)]">{line}</span><span className="font-mono-data text-[8px] text-[var(--text-muted)]">{index + 1}m</span></div>)}
      </section>
    </div>
  )
}

function SessionsPreview() {
  return <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]"><div className="flex items-center justify-between px-4 py-3"><div><h2 className="text-[11px] font-bold">本地会话</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">迁移、归档或恢复 Codex 历史会话</p></div><div className="relative"><Search size={12} className="absolute left-2.5 top-2 text-[var(--text-muted)]" /><input placeholder="搜索会话" className="h-7 w-44 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] pl-8 pr-2 text-[9px] outline-none" /></div></div>{['GFA 客户端宿主防护重构','修复 Claude Desktop MITM 证书','Codex 会话导入与分组'].map((title, index) => <div key={title} className="flex items-center gap-3 border-t border-[var(--border-light)] px-4 py-3"><span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--bg-tertiary)]"><TerminalSquare size={14} /></span><div className="min-w-0 flex-1"><div className="truncate text-[10px] font-semibold text-[var(--text-primary)]">{title}</div><div className="mt-0.5 text-[8px] text-[var(--text-muted)]">{index + 2} 个 turn · 今天 {10 + index}:2{index}</div></div><Button size="sm" variant="ghost">打开</Button><button className="text-[var(--text-muted)]"><MoreHorizontal size={14} /></button></div>)}</section>
}

function WakeupPreview() {
  return <div className="grid grid-cols-[1.1fr_.9fr] gap-3"><section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4"><div className="flex items-center justify-between"><div><h2 className="text-[11px] font-bold">账号保活</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">定期刷新本地账号状态与额度</p></div><InlineStatus>计划运行中</InlineStatus></div><div className="mt-4 flex items-center gap-4 rounded-[10px] bg-[var(--bg-tertiary)] p-3"><Clock3 size={18} className="text-[var(--primary-strong)]" /><div className="flex-1"><p className="text-[9px] text-[var(--text-muted)]">下次执行</p><p className="mt-0.5 font-mono-data text-[16px] font-semibold">18:24</p></div><Button size="sm" variant="secondary">立即执行</Button></div></section><section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4"><h2 className="text-[11px] font-bold">执行策略</h2><div className="mt-4 space-y-3"><div className="flex items-center justify-between"><span className="text-[9px] text-[var(--text-secondary)]">刷新间隔</span><span className="font-mono-data text-[9px]">30 分钟</span></div><div className="flex items-center justify-between"><span className="text-[9px] text-[var(--text-secondary)]">失败重试</span><span className="font-mono-data text-[9px]">3 次</span></div><div className="flex items-center justify-between"><span className="text-[9px] text-[var(--text-secondary)]">低额度提醒</span><span className="font-mono-data text-[9px]">20%</span></div></div></section></div>
}

function LocalSettingsPreview({ provider }: { provider: ProviderName }) {
  return <section className="rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]"><div className="px-4 py-3"><h2 className="text-[11px] font-bold">{provider === 'codex' ? 'Codex' : 'Antigravity'} 行为设置</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">接管、启动和配置文件路径</p></div>{[['切换账号时自动启动客户端','接管完成后拉起官方客户端'],['切换时重启现有进程','确保新凭据立即生效'],['显示 API 服务入口','在本地账号页保留网关入口']].map(([title, note], index) => <div key={title} className="flex items-center gap-4 border-t border-[var(--border-light)] px-4 py-3"><div className="flex-1"><p className="text-[10px] font-semibold">{title}</p><p className="mt-0.5 text-[8px] text-[var(--text-muted)]">{note}</p></div><span className={cn('relative h-5 w-9 rounded-full', index !== 1 ? 'bg-[var(--primary)]' : 'bg-[var(--switch-off)]')}><i className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white', index !== 1 ? 'right-0.5' : 'left-0.5')} /></span></div>)}<div className="flex items-center gap-3 border-t border-[var(--border-light)] px-4 py-3"><FolderOpen size={15} className="text-[var(--text-muted)]" /><div className="flex-1"><p className="text-[10px] font-semibold">客户端路径</p><p className="mt-0.5 font-mono-data text-[8px] text-[var(--text-muted)]">/Applications/{provider === 'codex' ? 'Codex.app' : 'Antigravity.app'}</p></div><Button size="sm" variant="secondary">重新检测</Button></div></section>
}

export function SettingsPreview() {
  const sections = [
    ['通用', SlidersHorizontal],
    ['应用路径', FolderOpen],
    ['账户与安全', ShieldCheck],
    ['关于', BookOpen],
  ] as const
  const [section, setSection] = useState('通用')
  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
      <PageHeader title="设置" subtitle="客户端偏好、检测路径和账户操作" />
      <div className="grid grid-cols-[176px_1fr] gap-5">
        <nav className="space-y-1">{sections.map(([name, Icon]) => <button key={name} onClick={() => setSection(name)} className={cn('flex h-9 w-full items-center gap-2.5 rounded-[9px] px-3 text-[10px] font-semibold', section === name ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}><Icon size={14} />{name}<ChevronRight size={12} className="ml-auto opacity-60" /></button>)}</nav>
        <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">
          {section === '通用' && <GeneralSettings />}
          {section === '应用路径' && <PathSettings />}
          {section === '账户与安全' && <AccountSettings />}
          {section === '关于' && <AboutSettings />}
        </section>
      </div>
    </div>
  )
}

function SettingHeading({ title, note }: { title: string; note: string }) { return <div className="border-b border-[var(--border-light)] px-5 py-4"><h2 className="text-[12px] font-bold text-[var(--text-primary)]">{title}</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">{note}</p></div> }
function SettingRow({ icon: Icon, title, note, control }: { icon: typeof Globe2; title: string; note: string; control: ReactNode }) { return <div className="flex items-center gap-3 border-b border-[var(--border-light)] px-5 py-3.5 last:border-0"><span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"><Icon size={14} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold text-[var(--text-primary)]">{title}</p><p className="mt-0.5 text-[8px] text-[var(--text-muted)]">{note}</p></div>{control}</div> }
function GeneralSettings() { return <><SettingHeading title="通用" note="只保留需要长期调整的客户端偏好" /><SettingRow icon={Languages} title="界面语言" note="切换后立即刷新全部文案" control={<Segmented items={['简体中文','繁體中文','English']} value="简体中文" onChange={() => {}} />} /><SettingRow icon={Monitor} title="外观" note="跟随系统，也可固定浅色或深色" control={<Segmented items={['系统','浅色','深色']} value="系统" onChange={() => {}} />} /><SettingRow icon={Wifi} title="启动后自动连接" note="登录状态有效时自动启动本地代理" control={<span className="relative h-5 w-9 rounded-full bg-[var(--primary)]"><i className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-white" /></span>} /></> }
function PathSettings() { return <><SettingHeading title="应用路径" note="自动检测失败时可手动指定，保存后立即重新探测" />{[['Antigravity IDE','/Applications/Antigravity.app'],['Antigravity Hub','未检测到'],['Codex App','/Applications/Codex.app'],['Claude Desktop','/Applications/Claude.app']].map(([name,path]) => <div key={name} className="flex items-center gap-3 border-b border-[var(--border-light)] px-5 py-3.5 last:border-0"><ProviderLogo provider={name.includes('Codex') ? 'codex' : name.includes('Claude') ? 'anthropic' : 'antigravity'} size={12} /><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold">{name}</p><p className={cn('mt-0.5 truncate font-mono-data text-[8px]', path === '未检测到' ? 'text-[var(--warning-deep)]' : 'text-[var(--text-muted)]')}>{path}</p></div><Button size="sm" variant="secondary">浏览</Button></div>)}</> }
function AccountSettings() { return <><SettingHeading title="账户与安全" note="会员身份、余额、设备与退出操作" /><SettingRow icon={UserRound} title="当前账户" note="design@bcai.lol · 会员通行证" control={<Button size="sm" variant="secondary">管理订阅<ExternalLink size={11} /></Button>} /><SettingRow icon={Gift} title="分享赚返点" note="已邀请 7 人 · 好友下单返 10% 余额" control={<div className="flex items-center gap-3"><span className="font-mono-data text-[11px] font-semibold text-[var(--primary-strong)]">¥128.60</span><Button size="sm" variant="secondary">查看邀请</Button></div>} /><SettingRow icon={ShieldCheck} title="已授权设备" note="当前设备：MockBook Pro" control={<Button size="sm" variant="secondary">查看设备</Button>} /><SettingRow icon={KeyRound} title="会话安全" note="退出后本机凭据与租约立即清除" control={<Button size="sm" variant="danger">退出登录</Button>} /></> }
function AboutSettings() { return <><SettingHeading title="关于冰茶AI" note="版本、更新与支持渠道" /><SettingRow icon={Gauge} title="当前版本" note="BingchaAI Desktop 13.3.1" control={<InlineStatus>已是最新</InlineStatus>} /><SettingRow icon={BookOpen} title="更新内容" note="查看本版本修复与新增功能" control={<Button size="sm" variant="secondary">查看</Button>} /><SettingRow icon={ExternalLink} title="帮助与反馈" note="遇到问题时附上日志可以更快定位" control={<Button size="sm" variant="secondary">提交工单</Button>} /></> }

export function LogsPreview() {
  const [paused, setPaused] = useState(false)
  const [query, setQuery] = useState('')
  const logLines = [
    ['18:02:41.318', 'takeover', 'INFO', 'Claude Desktop 宿主防护配置已写入，时区 Asia/Singapore'],
    ['18:02:41.104', 'egress', 'INFO', '出口探测通过 proxy=***@103.18.xx.xx:8421'],
    ['18:02:40.912', 'mitm', 'INFO', '根证书信任校验通过，代理监听 127.0.0.1:48800'],
    ['18:01:58.442', 'quota', 'WARN', 'Codex 周额度低于 60%，剩余 54%'],
    ['18:01:42.071', 'lease', 'INFO', 'Anthropic 粘性租约续期成功 account=#2187'],
    ['18:00:10.882', 'gateway', 'ERROR', '请求返回 429，已切换备用账号并重试'],
    ['17:58:31.224', 'heartbeat', 'INFO', '订阅状态同步完成 products=anthropic,codex'],
  ]
  const filtered = useMemo(() => logLines.filter((line) => line.join(' ').toLowerCase().includes(query.toLowerCase())), [query])
  return (
    <div className="mx-auto flex h-full w-full max-w-[1080px] flex-col gap-4">
      <PageHeader title="运行日志" subtitle="本机代理、接管、租约和额度事件" actions={<><Button size="sm" variant="secondary" onClick={() => setPaused((value) => !value)}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? '继续' : '暂停'}</Button><Button size="sm" variant="secondary"><Trash2 size={12} />清空</Button></>} />
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-slate-800 bg-[#10131a] text-slate-200">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5"><div className="relative flex-1"><Search size={12} className="absolute left-2.5 top-2 text-slate-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选日志、模块或错误" className="h-7 w-full rounded-[7px] border border-white/10 bg-white/5 pl-8 pr-3 font-mono text-[9px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-orange-500/60" /></div><button className="flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[9px] text-slate-400 hover:bg-white/5"><Filter size={11} />全部模块</button><span className="flex items-center gap-1.5 px-2 text-[8px] text-slate-500"><i className={cn('h-1.5 w-1.5 rounded-full', paused ? 'bg-amber-400' : 'bg-emerald-400')} />{paused ? '已暂停' : '实时'}</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto py-2 font-mono text-[9px] leading-6">{filtered.map(([time,tag,level,msg]) => <div key={time} className="grid grid-cols-[86px_76px_48px_1fr] px-3 hover:bg-white/[.035]"><span className="text-slate-600">{time}</span><span className="text-slate-400">[{tag}]</span><span className={level === 'ERROR' ? 'text-red-400' : level === 'WARN' ? 'text-amber-400' : 'text-emerald-400'}>{level}</span><span className="text-slate-300">{msg}</span></div>)}</div>
        <div className="flex items-center justify-between border-t border-white/10 px-3 py-2 text-[8px] text-slate-600"><span>{filtered.length} 条可见 · desktop.log</span><button className="flex items-center gap-1 text-slate-400"><FolderOpen size={10} />打开日志目录</button></div>
      </section>
    </div>
  )
}

const FAQ_ITEMS = [
  ['接管后官方客户端为什么没有立即生效？','常驻客户端通常在启动时读取配置。冰茶会在接管完成后提示是否重启，若仍未生效，可先退出官方客户端再重新打开。','接管'],
  ['宿主环境防护会改动哪些系统设置？','时区会按策略临时对齐，WebRTC 与浏览器定位会被限制，DNS 缓存随接管清理。取消接管时按备份还原有状态的设置。','接管'],
  ['Windows 和 macOS 的授权流程有什么不同？','Windows 默认静默完成。macOS 修改系统时区与清理 DNS 时需要一次管理员授权，授权前会列出具体操作。','接管'],
  ['本地自有号和远程托管有什么区别？','远程托管使用通行证租用账号，本地自有号使用你已登录或导入的账号。两者的接管状态互斥。','账号'],
  ['如何导出日志给客服排查？','在运行日志页点击“打开日志目录”，将 desktop.log 与问题发生时间一起提交。日志中的代理密码和 Token 会自动脱敏。','排障'],
]

export function GuidePreview() {
  const [category, setCategory] = useState('全部')
  const [open, setOpen] = useState(0)
  const [query, setQuery] = useState('')
  const items = FAQ_ITEMS.filter((item) => (category === '全部' || item[2] === category) && item.join(' ').includes(query))
  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
      <PageHeader title="使用指南" subtitle="按当前客户端功能整理，优先回答接管和排障问题" />
      <div className="relative"><Search size={14} className="absolute left-3 top-3 text-[var(--text-muted)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索接管、账号、额度或报错" className="h-10 w-full rounded-[11px] border border-[var(--border)] bg-[var(--bg-card)] pl-10 pr-4 text-[10px] outline-none focus:border-[var(--primary)]" /></div>
      <div className="grid grid-cols-[160px_1fr] gap-5">
        <aside className="space-y-1">{['全部','接管','账号','额度','排障'].map((item) => <button key={item} onClick={() => setCategory(item)} className={cn('flex h-9 w-full items-center justify-between rounded-[9px] px-3 text-[10px] font-semibold', category === item ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>{item}<span className="font-mono-data text-[8px] opacity-60">{item === '全部' ? FAQ_ITEMS.length : FAQ_ITEMS.filter((row) => row[2] === item).length}</span></button>)}</aside>
        <section className="overflow-hidden rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-card)]">{items.map((item,index) => { const active = open === index; return <div key={item[0]} className="border-b border-[var(--border-light)] last:border-0"><button onClick={() => setOpen(active ? -1 : index)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left"><span className="grid h-7 w-7 place-items-center rounded-[8px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"><BookOpen size={13} /></span><span className="flex-1 text-[10px] font-semibold text-[var(--text-primary)]">{item[0]}</span><ChevronDown size={14} className={cn('text-[var(--text-muted)] transition-transform', active && 'rotate-180')} /></button>{active && <div className="px-14 pb-4 text-[9px] leading-6 text-[var(--text-secondary)]">{item[1]}</div>}</div> })}</section>
      </div>
    </div>
  )
}
