import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Power, Copy, Check, Loader2, Globe, Lock, Plug, Route, Wifi, KeyRound,
  RotateCw, Trash2, ListFilter, Plug2, AlertTriangle, SlidersHorizontal,
} from 'lucide-react'
import {
  type LocalGatewayStatus, type ProviderLocalApi,
  type RoutingStrategy, type GatewayAccessScope, type GatewayKey,
  type GatewayLogEntry, type GatewayLogFilter, type GatewayConnTestResult,
  type GatewayOpsConfig,
  getRoutingStrategy, setRoutingStrategy,
  getGatewayAccessScope, setGatewayAccessScope,
  listGatewayKeys, createGatewayKey, deleteGatewayKey, rotateGatewayKey,
  queryGatewayLogs, clearGatewayStats, gatewayConnTest,
  getGatewayOpsConfig, saveGatewayTimeouts, saveGatewayUpstreamProxy,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 反代 tab —— 本地网关(CLIProxyAPI)作为 OpenAI 兼容 API 服务的运营面板。
 *
 * 在「运行态/启停/端口/base URL/最近请求」基础上,接 Wave E 的运营绑定:
 *  - 路由策略(段控:轮询/优先/公平分摊)— get/setRoutingStrategy
 *  - 局域网访问(开关:仅本机 ⇄ 局域网,开局域网给安全提示)— get/setGatewayAccessScope
 *  - 网关 API Key(列表:名称/掩码值/复制/轮换/删除 + 新建)— list/create/delete/rotateGatewayKey
 *  - 请求日志(可过滤:模型/账号/仅失败 + 加载更多 + 清空)— queryGatewayLogs/clearGatewayStats
 *  - 连通测试(ok/状态/延迟)— gatewayConnTest
 *
 * 视觉沿用 GFA token(琥珀单色、克制分区、对比 ≥4.5:1)。只用已封装的 localApi 函数,
 * 不让 window.go.* 散落到组件。
 */

const STRATEGIES: [RoutingStrategy, string, string][] = [
  ['round-robin', '轮询', '在池号间均匀轮转'],
  ['priority', '优先', '优先号先用,用尽再降级'],
  ['fair', '公平分摊', '剩余额度高者优先'],
  ['quota-low-first', '低额优先', '先用尽剩余少的号,再换下一个'],
  ['plan-high-first', '高档优先', '高档套餐(team/pro)先用'],
  ['plan-low-first', '低档优先', '低档套餐先用,省着高档号'],
]

const LOG_PAGE_SIZE = 20

/** 掩码 key 值:保留前 8 与后 4,中间打码;短值则全打码。 */
function maskKey(value: string): string {
  if (!value) return '—'
  if (value.length <= 12) return value.slice(0, 3) + '••••'
  return `${value.slice(0, 8)}••••${value.slice(-4)}`
}

export function LocalGatewayTab({ api }: { api: ProviderLocalApi }) {
  const [gw, setGw] = useState<LocalGatewayStatus>({ running: false, addr: '', port: 0 })
  const [accounts, setAccounts] = useState(0)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [portBusy, setPortBusy] = useState(false)
  const [busy, setBusy] = useState(false)

  // ── 运营态 ──
  const [strategy, setStrategy] = useState<RoutingStrategy | null>(null)
  const [strategyBusy, setStrategyBusy] = useState(false)
  const [scope, setScope] = useState<GatewayAccessScope | null>(null)
  const [scopeBusy, setScopeBusy] = useState(false)
  const [keys, setKeys] = useState<GatewayKey[]>([])
  const [keysLoaded, setKeysLoaded] = useState(false)
  const [keyBusy, setKeyBusy] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  // 运维配置(超时 / 上游代理)。
  const [opsCfg, setOpsCfg] = useState<GatewayOpsConfig | null>(null)
  const [proxyDraft, setProxyDraft] = useState('')
  const [opsBusy, setOpsBusy] = useState('')

  const onSaveProxy = async () => {
    setOpsBusy('proxy')
    try { setOpsCfg(await saveGatewayUpstreamProxy(proxyDraft.trim())) } catch (e) { setErr(String(e)) } finally { setOpsBusy('') }
  }
  const onSaveTimeout = async (patch: Partial<GatewayOpsConfig['timeouts']>) => {
    if (!opsCfg) return
    setOpsBusy('timeout')
    try { setOpsCfg(await saveGatewayTimeouts({ ...opsCfg.timeouts, ...patch })) } catch (e) { setErr(String(e)) } finally { setOpsBusy('') }
  }
  const [copiedKeyId, setCopiedKeyId] = useState('')

  // ── 请求日志 ──
  const [logs, setLogs] = useState<GatewayLogEntry[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [logsLoaded, setLogsLoaded] = useState(false)
  const [logBusy, setLogBusy] = useState(false)
  const [fModel, setFModel] = useState('')
  const [fFailedOnly, setFFailedOnly] = useState(false)

  // ── 连通测试 ──
  const [connBusy, setConnBusy] = useState(false)
  const [conn, setConn] = useState<GatewayConnTestResult | null>(null)

  const buildFilter = useCallback((): GatewayLogFilter | undefined => {
    const f: GatewayLogFilter = {}
    if (fModel.trim()) f.model = fModel.trim()
    if (fFailedOnly) f.failedOnly = true
    return Object.keys(f).length ? f : undefined
  }, [fModel, fFailedOnly])

  const loadLogs = useCallback(async (append: boolean) => {
    setLogBusy(true)
    try {
      const offset = append ? logs.length : 0
      const page = await queryGatewayLogs(offset, LOG_PAGE_SIZE, buildFilter())
      const entries = page.entries || []
      setLogs((prev) => (append ? [...prev, ...entries] : entries))
      setLogTotal(page.total)
      setLogsLoaded(true)
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLogBusy(false)
    }
  }, [logs.length, buildFilter])

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.gatewayStatus()
      setGw(status)
      setPortInput((prev) => (prev === '' && status.port > 0 ? String(status.port) : prev))
      const list = await api.listAccounts()
      setAccounts((list || []).length)
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }, [api])

  // 一次性拉运营配置(策略/范围/key/运维配置);轮询只刷运行态,避免打扰输入。
  const loadOps = useCallback(async () => {
    try {
      const [st, sc, ks, ops] = await Promise.all([getRoutingStrategy(), getGatewayAccessScope(), listGatewayKeys(), getGatewayOpsConfig()])
      setStrategy(st)
      setScope(sc)
      setKeys(ks || [])
      setKeysLoaded(true)
      setOpsCfg(ops)
      setProxyDraft(ops.upstreamProxyUrl)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    void loadOps()
    void loadLogs(false)
    const id = setInterval(() => { void refreshStatus() }, 4000)
    return () => clearInterval(id)
    // loadLogs 仅首次;过滤变化由 onChange 显式触发,故此处忽略其依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshStatus, loadOps])

  // 过滤变化 → 重查(首屏后)。
  const filtersReady = useRef(false)
  useEffect(() => {
    if (!filtersReady.current) { filtersReady.current = true; return }
    void loadLogs(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fModel, fFailedOnly])

  const onToggle = async () => {
    setBusy(true)
    setErr('')
    try {
      if (gw.running) await api.gatewayStop()
      else await api.gatewayStart()
      await refreshStatus()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const baseUrl = gw.addr ? `http://${gw.addr}/v1` : ''
  const onCopy = async () => {
    if (!baseUrl) return
    try {
      await navigator.clipboard.writeText(baseUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 忽略:剪贴板不可用时不阻断 */ }
  }

  const onApplyPort = async () => {
    const port = Number(portInput)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setErr('端口需为 1–65535 的整数')
      return
    }
    if (port === gw.port) return
    setPortBusy(true)
    setErr('')
    try {
      const status = await api.setGatewayPort(port)
      setGw(status)
      setPortInput(status.port > 0 ? String(status.port) : portInput)
      await refreshStatus()
    } catch (e) {
      setErr(String(e))
    } finally {
      setPortBusy(false)
    }
  }

  const portDirty = portInput !== '' && Number(portInput) !== gw.port

  const onPickStrategy = async (next: RoutingStrategy) => {
    if (next === strategy) return
    setStrategyBusy(true)
    setErr('')
    try {
      await setRoutingStrategy(next)
      setStrategy(next)
    } catch (e) {
      setErr(String(e))
    } finally {
      setStrategyBusy(false)
    }
  }

  const onToggleScope = async () => {
    const next: GatewayAccessScope = scope === 'lan' ? 'local' : 'lan'
    setScopeBusy(true)
    setErr('')
    try {
      await setGatewayAccessScope(next)
      setScope(next)
      await refreshStatus()
    } catch (e) {
      setErr(String(e))
    } finally {
      setScopeBusy(false)
    }
  }

  const onCreateKey = async () => {
    const name = newKeyName.trim()
    if (!name) return
    setKeyBusy('create')
    setErr('')
    try {
      await createGatewayKey(name)
      setNewKeyName('')
      setKeys(await listGatewayKeys())
    } catch (e) {
      setErr(String(e))
    } finally {
      setKeyBusy(null)
    }
  }

  const onRotateKey = async (id: string) => {
    setKeyBusy(`rot-${id}`)
    setErr('')
    try {
      await rotateGatewayKey(id)
      setKeys(await listGatewayKeys())
    } catch (e) {
      setErr(String(e))
    } finally {
      setKeyBusy(null)
    }
  }

  const onDeleteKey = async (id: string) => {
    setKeyBusy(`del-${id}`)
    setErr('')
    try {
      await deleteGatewayKey(id)
      setKeys(await listGatewayKeys())
    } catch (e) {
      setErr(String(e))
    } finally {
      setKeyBusy(null)
    }
  }

  const onCopyKey = async (k: GatewayKey) => {
    try {
      await navigator.clipboard.writeText(k.value)
      setCopiedKeyId(k.id)
      setTimeout(() => setCopiedKeyId(''), 1500)
    } catch { /* 忽略 */ }
  }

  const onClearLogs = async () => {
    setLogBusy(true)
    setErr('')
    try {
      await clearGatewayStats()
      await loadLogs(false)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLogBusy(false)
    }
  }

  const onConnTest = async () => {
    setConnBusy(true)
    setErr('')
    try {
      setConn(await gatewayConnTest())
    } catch (e) {
      setErr(String(e))
    } finally {
      setConnBusy(false)
    }
  }

  const lanOn = scope === 'lan'
  const hasMore = logs.length < logTotal

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      {/* 使用风险提示:反代是本机唯一真正「代理转发」的用法(把自有号池对外开 API 网关)。
          克制不渲染封号;接管中心的本地自有号是注入直连、不经此网关,故那边不提示。 */}
      <div className="rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[12px] text-[var(--text-secondary)] flex items-start gap-2">
        <AlertTriangle size={14} className="text-[var(--warning)] mt-0.5 shrink-0" />
        <span>
          <span className="font-semibold text-[var(--warning)]">使用风险提示</span> —— 反代会把你的自有号组成号池,对外提供 OpenAI 兼容 API、由本机网关代理转发。这属官方未明确背书的用法,后续政策、规则或可用性是否变化仍存在不确定性。继续使用即表示你已知悉相关情况,并愿意自行承担可能产生的风险。
        </span>
      </div>

      {/* 运行态 + 启停 + 连通测试 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-[10px] bg-[var(--bg-tertiary)] flex items-center justify-center">
            <Globe size={18} className="text-[var(--text-secondary)]" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
              本地反代
              <span className="inline-flex items-center gap-1 text-[10px] text-[var(--success)] font-normal"><Lock size={10} /> 仅自有号</span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5 inline-flex items-center gap-1.5">
              <span className={cn('w-1.5 h-1.5 rounded-full', gw.running ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
              {gw.running ? `运行中 · ${gw.addr}` : '未运行'} · {accounts} 个号在服务
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onConnTest}
            disabled={connBusy || !gw.running}
            title={gw.running ? '' : '网关未运行'}
            className="cursor-pointer text-[12px] font-semibold px-2.5 h-[34px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {connBusy ? <Loader2 size={14} className="animate-spin" /> : <Plug2 size={14} />}
            连通测试
          </button>
          <button
            onClick={onToggle}
            disabled={busy}
            className={cn(
              'cursor-pointer text-[12px] font-semibold px-3 h-[34px] rounded-[8px] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed',
              gw.running
                ? 'border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                : 'bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)]',
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {gw.running ? '停止' : '启动'}
          </button>
        </div>
      </div>

      {/* 连通测试结果 */}
      {conn && (
        <div
          className={cn(
            'rounded-[10px] border px-3 py-2 text-[12px] flex items-center gap-2',
            conn.ok
              ? 'border-[var(--success)] bg-[var(--success)]/10 text-[var(--text-secondary)]'
              : 'border-[var(--danger)] bg-[var(--danger)]/5 text-[var(--danger)]',
          )}
        >
          {conn.ok ? <Check size={14} className="text-[var(--success)]" /> : <AlertTriangle size={14} className="text-[var(--danger)]" />}
          {conn.ok ? (
            <span>连通正常 · HTTP <span className="font-mono-data text-[var(--text-primary)]">{conn.status}</span> · 延迟 <span className="font-mono-data text-[var(--text-primary)] tabular-nums">{conn.latencyMs}</span> ms</span>
          ) : (
            <span className="break-all">连通失败{conn.status ? ` · HTTP ${conn.status}` : ''}{conn.err ? ` · ${conn.err}` : ''}</span>
          )}
        </div>
      )}

      {/* 路由策略 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide mb-2 inline-flex items-center gap-1.5">
          <Route size={12} /> 路由策略(在池号怎么选)
        </div>
        <div className="flex flex-wrap gap-0.5 rounded-[10px] bg-[var(--bg-tertiary)] p-0.5">
          {STRATEGIES.map(([id, label]) => {
            const active = strategy === id
            return (
              <button
                key={id}
                onClick={() => void onPickStrategy(id)}
                disabled={strategyBusy}
                aria-pressed={active}
                className={cn(
                  'cursor-pointer text-[12px] font-semibold px-3 h-[30px] rounded-[8px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  active ? 'bg-[var(--bg-card)] text-[var(--primary-strong)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-2">
          {strategy ? STRATEGIES.find(([id]) => id === strategy)?.[2] : '加载中…'}
        </div>
      </div>

      {/* 运维配置(超时 / 上游代理) */}
      {opsCfg && (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
          <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide inline-flex items-center gap-1.5"><SlidersHorizontal size={12} /> 运维配置</div>
          <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            出口上游代理
            <input
              aria-label="出口上游代理"
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
              placeholder="http://127.0.0.1:7890(空=直连)"
              className="flex-1 rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[30px] text-[12px] font-mono-data text-[var(--text-primary)]"
            />
            <button onClick={() => void onSaveProxy()} disabled={opsBusy === 'proxy'} className="text-[12px] font-semibold px-3 h-[30px] rounded-[7px] border border-[var(--primary)] text-[var(--primary-strong)] hover:bg-[var(--primary-light)] disabled:opacity-50">保存</button>
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            {([
              ['流保活(秒)', 'streamKeepaliveSeconds'],
              ['流引导重试(次)', 'streamBootstrapRetries'],
              ['最大重试号数', 'maxRetryCredentials'],
              ['重试间隔(秒)', 'maxRetryIntervalSeconds'],
            ] as const).map(([label, key]) => (
              <label key={key} className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                {label}
                <input
                  type="number" min={0}
                  aria-label={label}
                  defaultValue={opsCfg.timeouts[key]}
                  onBlur={(e) => { const v = Number(e.target.value); if (v !== opsCfg.timeouts[key]) void onSaveTimeout({ [key]: v }) }}
                  disabled={opsBusy === 'timeout'}
                  className="w-[80px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[28px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums disabled:opacity-50"
                />
              </label>
            ))}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">超时/上游代理已持久化;运行时套用到内嵌网关为后续(需 SDK 支持)。</div>
        </div>
      )}

      {/* 局域网访问 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
              {lanOn ? <Wifi size={14} /> : <Lock size={14} />} 局域网访问
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {scope === null ? '加载中…' : lanOn ? '已开放:局域网设备可连(0.0.0.0)' : '仅本机:只有这台电脑可连(127.0.0.1)'}
            </div>
          </div>
          <button
            onClick={onToggleScope}
            disabled={scopeBusy || scope === null}
            role="switch"
            aria-checked={lanOn}
            aria-label="局域网访问"
            className={cn('cursor-pointer w-[42px] h-[24px] rounded-full relative transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0', lanOn ? 'bg-[var(--primary)]' : 'bg-[#cbd2dc]')}
          >
            <span className={cn('absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all', lanOn ? 'right-[3px]' : 'left-[3px]')} />
          </button>
        </div>
        {lanOn && (
          <div className="rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--text-secondary)] flex items-start gap-2">
            <AlertTriangle size={13} className="text-[var(--warning)] mt-0.5 shrink-0" />
            <span>已开放局域网:同一网络下的<span className="font-semibold text-[var(--warning)]">局域网内任何设备</span>都能用上面的地址调用你的自有号。务必配好下面的访问 key,别在不可信网络开放。</span>
          </div>
        )}
      </div>

      {/* 端口设置 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide mb-2 inline-flex items-center gap-1.5">
          <Plug size={12} /> 反代端口(共享网关 · codex/antigravity 同口)
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && portDirty && !portBusy) void onApplyPort() }}
            placeholder="8317"
            disabled={portBusy}
            className="w-[120px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--primary)] disabled:opacity-50"
          />
          <button
            onClick={onApplyPort}
            disabled={portBusy || !portDirty}
            className="cursor-pointer text-[12px] font-semibold px-3 h-[34px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {portBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            应用并重启
          </button>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-1.5">改端口会重启网关;若端口被占用,系统会回退到下一个空闲端口。</div>
      </div>

      {/* base URL */}
      {gw.running && baseUrl && (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide mb-2">OpenAI 兼容地址(填进任意客户端的 Base URL)</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2 text-[12px] font-mono-data text-[var(--text-primary)]">{baseUrl}</code>
            <button
              onClick={onCopy}
              className="cursor-pointer text-[12px] font-semibold px-2.5 h-[34px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 shrink-0"
            >
              {copied ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      )}

      {/* 网关 API Key */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
        <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide inline-flex items-center gap-1.5">
          <KeyRound size={12} /> 网关访问 Key(客户端 Authorization 用)
        </div>
        {/* 新建 */}
        <div className="flex items-center gap-2">
          <input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && newKeyName.trim() && keyBusy !== 'create') void onCreateKey() }}
            placeholder="给 key 起个名,如「团队」「我的 IDE」"
            aria-label="新 key 名称"
            className="flex-1 min-w-0 rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 h-[34px] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
          />
          <button
            onClick={onCreateKey}
            disabled={keyBusy === 'create' || !newKeyName.trim()}
            className="cursor-pointer text-[12px] font-semibold px-3 h-[34px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {keyBusy === 'create' ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            新建 key
          </button>
        </div>
        {/* 列表 */}
        {!keysLoaded ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
        ) : keys.length === 0 ? (
          <div className="rounded-[8px] bg-[var(--bg-tertiary)] py-6 text-center text-[12px] text-[var(--text-muted)]">还没有访问 key。开放局域网前建议先建一个。</div>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--border-light)]">
            {keys.map((k) => {
              const rotating = keyBusy === `rot-${k.id}`
              const deleting = keyBusy === `del-${k.id}`
              return (
                <div key={k.id} className="grid grid-cols-[1fr_auto] gap-3 items-center py-2.5">
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate">{k.name}</div>
                    <div className="text-[11px] font-mono-data text-[var(--text-muted)] truncate">{maskKey(k.value)}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => void onCopyKey(k)}
                      title="复制完整 key"
                      aria-label="复制 key"
                      className="cursor-pointer w-[30px] h-[30px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center justify-center"
                    >
                      {copiedKeyId === k.id ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
                    </button>
                    <button
                      onClick={() => void onRotateKey(k.id)}
                      disabled={rotating || deleting}
                      title="重置 key 值"
                      aria-label="轮换 key"
                      className="cursor-pointer w-[30px] h-[30px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {rotating ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
                    </button>
                    <button
                      onClick={() => void onDeleteKey(k.id)}
                      disabled={rotating || deleting}
                      title="删除 key"
                      aria-label="删除 key"
                      className="cursor-pointer w-[30px] h-[30px] rounded-[8px] border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/5 inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="text-[11px] text-[var(--text-muted)]">改 key 会重启网关生效;客户端用 <code className="font-mono-data">Authorization: Bearer &lt;key&gt;</code> 调用。</div>
      </div>

      {/* 请求日志(可过滤 + 加载更多 + 清空) */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide inline-flex items-center gap-1.5">
            <ListFilter size={12} /> 请求日志 · {logTotal}
          </span>
          <div className="flex items-center gap-2.5 flex-wrap">
            <input
              value={fModel}
              onChange={(e) => setFModel(e.target.value)}
              placeholder="按模型筛选"
              aria-label="按模型筛选"
              className="w-[130px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] px-2.5 h-[28px] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
            />
            <label className="cursor-pointer text-[11px] text-[var(--text-secondary)] inline-flex items-center gap-1.5 select-none">
              <input
                type="checkbox"
                checked={fFailedOnly}
                onChange={(e) => setFFailedOnly(e.target.checked)}
                aria-label="仅失败"
                className="cursor-pointer accent-[var(--primary)]"
              />
              仅失败
            </label>
            <button
              onClick={onClearLogs}
              disabled={logBusy || logTotal === 0}
              className="cursor-pointer text-[11px] font-semibold px-2.5 h-[28px] rounded-[8px] border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/5 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={12} /> 清空日志
            </button>
          </div>
        </div>
        {!logsLoaded ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
        ) : logs.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">
            {fModel || fFailedOnly ? '没有命中筛选的请求。' : '还没有请求,接管后经反代的调用会显示在这里。'}
          </div>
        ) : (
          <>
            <div className="divide-y divide-[var(--border-light)]">
              {logs.map((r, i) => (
                <div key={`${r.atMs}-${i}`} className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 items-center px-4 py-2 text-[12px]">
                  <span className="font-mono-data text-[var(--text-muted)] text-[11px]">{r.atMs ? new Date(r.atMs).toLocaleTimeString() : '—'}</span>
                  <span className="font-mono-data text-[var(--text-primary)] truncate">{r.model || '—'}</span>
                  <span className="text-[11px] text-[var(--text-secondary)] truncate max-w-[140px]">{r.email || r.authId || '—'}</span>
                  <span className={cn('text-[11px]', r.failed ? 'text-[var(--danger)]' : 'text-[var(--success)]')}>{r.failed ? '失败' : '成功'}</span>
                  <span className="text-[11px] font-mono-data text-[var(--text-muted)] tabular-nums w-[64px] text-right">{r.latencyMs}ms</span>
                </div>
              ))}
            </div>
            {hasMore && (
              <div className="px-4 py-2.5 border-t border-[var(--border-light)] text-center">
                <button
                  onClick={() => void loadLogs(true)}
                  disabled={logBusy}
                  className="cursor-pointer text-[12px] font-semibold text-[var(--primary-strong)] hover:text-[var(--primary)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {logBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                  加载更多({logs.length}/{logTotal})
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
