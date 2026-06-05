import { useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { usePoolStore } from '@/stores/usePoolStore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal, useModal } from '@/components/Modal'
import { LoadingOverlay } from '@/components/LoadingOverlay'
import * as api from '@/services/wails'
import { cn } from '@/lib/utils'
import { Zap, Cloud, HardDrive, KeyRound, Plus, X } from 'lucide-react'

/**
 * 「Token 来源与接管」统一控制。把"用什么 token"(来源)和"是否接管"(注入)合成
 * 一个动作 —— 接管某产品 == 用某来源接管它。按产品分两组,语义互不冲突:
 *
 *   Antigravity:号池来源(租号/本地)全局共享 → 顶部一个来源切换;
 *               IDE / Hub 各一个接管开关(接管哪个 app 独立控制)。
 *   Codex:     单 app,三态合一 [租号] [中转 API] [不接管];
 *               选「中转」展开卡密配置(渐进式披露)。
 *
 * 因为「中转」只在 Codex 组出现,不可能给不支持中转的 Antigravity 选到 ——
 * 从根上消除了"接管了不支持中转的产品"的问题。
 */

// 产品 id → 接管 target(后端 InjectSelected/RestoreSelected 用)。
function idToTarget(id: string): string {
  if (id === 'antigravity_ide') return 'ide'
  if (id === 'codex') return 'codex'
  if (id === 'claude_code') return 'claude'
  return 'hub'
}

export function TokenSourceControl() {
  const config = useAppStore((s) => s.config)
  const ideProducts = useAppStore((s) => s.ideProducts)
  const fetchConfig = useAppStore((s) => s.fetchConfig)
  const fetchIDEStatus = useAppStore((s) => s.fetchIDEStatus)
  const proxyRunning = useAppStore((s) => s.proxyRunning)
  const proxyPort = useAppStore((s) => s.proxyPort)
  const poolMode = usePoolStore((s) => s.mode)
  const setPoolMode = usePoolStore((s) => s.setMode)
  const { showAlert, modalProps } = useModal()

  const hasCard = !!config?.accountCard && config.accountCard.trim() !== ''
  const codexRelay = config?.codexMode === 'relay'

  const agApps = ideProducts.filter((p) => p.id.startsWith('antigravity'))
  const codexApp = ideProducts.find((p) => p.id === 'codex')
  const claudeApp = ideProducts.find((p) => p.id === 'claude_code')
  const isMac = /mac/i.test(navigator.platform)

  const [busy, setBusy] = useState<string | null>(null)
  const [busyLabel, setBusyLabel] = useState('')

  // 中转配置(草稿)。
  const [relayBase, setRelayBase] = useState('')
  const [relayKey, setRelayKey] = useState('')
  const [relayProtocol, setRelayProtocol] = useState('responses')
  // 模型映射:行式编辑(本地模型 → 中转模型),可增删改。
  const [modelMaps, setModelMaps] = useState<{ from: string; to: string }[]>([])
  const [forceRelayOpen, setForceRelayOpen] = useState(false)
  const [savingRelay, setSavingRelay] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .getCodexRelayConfig()
      .then((r) => {
        if (!alive) return
        setRelayBase(r.baseURL || '')
        setRelayKey(r.apiKey || '')
        setRelayProtocol(r.protocol || 'responses')
        setModelMaps(Object.entries(r.modelMap || {}).map(([from, to]) => ({ from, to })))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 行数组 → 后端期望的对象;忽略 from/to 任一为空的行。
  const buildModelMap = (): Record<string, string> => {
    const map: Record<string, string> = {}
    for (const { from, to } of modelMaps) {
      const k = from.trim()
      const v = to.trim()
      if (k && v) map[k] = v
    }
    return map
  }

  const updateMapRow = (idx: number, patch: Partial<{ from: string; to: string }>) =>
    setModelMaps((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addMapRow = () => setModelMaps((rows) => [...rows, { from: '', to: '' }])
  const removeMapRow = (idx: number) => setModelMaps((rows) => rows.filter((_, i) => i !== idx))

  // 常见 Codex 本地模型名,供下拉快选(也允许自定义输入)。
  const KNOWN_MODELS = ['gpt-5-codex', 'gpt-5', 'gpt-5.5', 'codex-mini-latest']

  // target → 展示名(loading 文案用)。
  const targetName = (target: string) =>
    target === 'codex' ? 'Codex'
      : target === 'claude' ? 'Claude Code'
      : target === 'ide' ? 'Antigravity IDE'
      : 'Antigravity Hub'

  // 轮询 IDE 状态,直到目标产品的 injected 翻到期望值(接管/还原后端是异步的:
  // 改文件 + 拉起/重启 app,getIDEStatus 可能短暂仍是旧值)。超时则返回当前值,
  // 不卡死 UI。
  const waitForInjected = async (target: string, want: boolean, timeoutMs = 8000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const products = await fetchIDEStatus()
      const p = products.find((x) => idToTarget(x.id) === target)
      if (p && p.injected === want) return true
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  }

  // 统一的接管/还原执行:含 macOS 权限引导。loading 持续到状态真正翻转。
  const runTakeover = async (target: string, inject: boolean): Promise<boolean> => {
    setBusy(target)
    setBusyLabel(`${inject ? '正在接管' : '正在停止接管'} ${targetName(target)}...`)
    try {
      const msg = inject ? await api.injectSelected([target]) : await api.restoreSelected([target])
      // 失败(尤其 macOS 权限)直接走错误分支,不必等状态翻转。
      if (/失败|权限|permission|not permitted|denied/i.test(msg) && isMac) {
        await fetchIDEStatus()
        await showAlert('需要系统权限', `${msg}\n\n请在「系统设置 → 隐私与安全性 → App 管理」中开启冰茶AI 的权限,然后重试。`)
        await api.openSystemPermissionSettings()
        return false
      }
      if (msg && msg.trim() && /失败/.test(msg)) {
        await fetchIDEStatus()
        await showAlert('操作失败', msg)
        return false
      }
      // 等真实状态翻转(loading 期间保持遮罩)。
      setBusyLabel(`${inject ? '正在接管' : '正在停止接管'} ${targetName(target)} · 等待生效...`)
      await waitForInjected(target, inject)
      return true
    } catch (err) {
      await fetchIDEStatus()
      await showAlert('操作失败', String(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  // ── Antigravity ──────────────────────────────────────────────
  const handleAGSource = async (mode: 'remote' | 'local') => {
    if (mode === poolMode) return
    if (mode === 'remote' && !hasCard) {
      await showAlert('请先激活账号卡', '租号模式需要账号卡,请在「账号卡配置」激活。')
      return
    }
    try {
      await setPoolMode(mode)
      // 来源是全局的,已接管的 app 自动改用新来源,无需重新注入。
    } catch (err) {
      await showAlert('切换失败', String(err))
    }
  }

  const handleAGToggle = async (product: { id: string; injected: boolean }) => {
    const target = idToTarget(product.id)
    if (!product.injected && poolMode === 'remote' && !hasCard) {
      await showAlert('请先激活账号卡', '当前 Antigravity 来源为租号,请先激活账号卡。')
      return
    }
    await runTakeover(target, !product.injected)
  }

  // ── Claude Code(CLI + VSCode 扩展,单一接管开关,仅租号)────────
  const claudeInjected = !!claudeApp?.injected
  const handleClaudeToggle = async () => {
    if (!claudeInjected && !hasCard) {
      await showAlert('请先激活账号卡', 'Claude Code 接管需要账号卡,请在「账号卡配置」激活。')
      return
    }
    await runTakeover('claude', !claudeInjected)
  }

  // ── Codex(三态) ────────────────────────────────────────────
  type CodexState = 'off' | 'rental' | 'relay'
  const codexInjected = !!codexApp?.injected
  const codexState: CodexState = !codexInjected ? 'off' : codexRelay ? 'relay' : 'rental'
  const relayOpen = codexState === 'relay' || forceRelayOpen

  const persistRelay = async (): Promise<boolean> => {
    if (!relayBase.trim() || !relayKey.trim()) {
      await showAlert('保存失败', '启用中转需要填写中转地址和卡密。')
      return false
    }
    await api.saveCodexRelayConfig('relay', relayBase.trim(), relayKey.trim(), relayProtocol, buildModelMap())
    await fetchConfig()
    return true
  }

  const handleCodexPick = async (next: CodexState) => {
    // 已是目标状态、且没有待处理的中转草稿面板 → 无需动作。
    // (forceRelayOpen 时即便 codexState 仍是 off,点其它态也要把草稿面板收起,
    //  所以不能在这里提前 return。)
    if (next === codexState && !forceRelayOpen) return

    if (next === 'off') {
      setForceRelayOpen(false)
      // 仅在确实已接管时才执行还原;只是关掉未保存的中转草稿则无需调用后端。
      if (codexInjected) await runTakeover('codex', false)
      return
    }

    if (next === 'rental') {
      setForceRelayOpen(false)
      if (!hasCard) {
        await showAlert('请先激活账号卡', 'Codex 租号模式需要账号卡,请先激活。')
        return
      }
      if (codexRelay) {
        await api.saveCodexRelayConfig('rental', relayBase.trim(), relayKey.trim(), relayProtocol, buildModelMap())
        await fetchConfig()
      }
      if (!codexInjected) await runTakeover('codex', true)
      return
    }

    // next === 'relay'
    if (!relayBase.trim() || !relayKey.trim()) {
      setForceRelayOpen(true) // 仅展开面板等用户补齐,不落库。
      return
    }
    setSavingRelay(true)
    try {
      if (!(await persistRelay())) return
      if (!codexInjected) await runTakeover('codex', true)
      setForceRelayOpen(false)
    } finally {
      setSavingRelay(false)
    }
  }

  const handleSaveRelay = async () => {
    setSavingRelay(true)
    try {
      if (!(await persistRelay())) return
      if (!codexInjected) await runTakeover('codex', true)
      setForceRelayOpen(false)
      await showAlert('已启用', 'Codex 已切换到中转(API 卡密)模式。')
    } finally {
      setSavingRelay(false)
    }
  }

  // 分段按钮渲染器。
  const seg = (active: boolean, onClick: () => void, content: ReactNode, disabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-[6px] text-[12px] font-semibold transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        active
          ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      )}
    >
      {content}
    </button>
  )

  return (
    <Card className="flex flex-col">
      <CardHeader><CardTitle><Zap size={15} /> Token 来源与接管</CardTitle></CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4">
        {/* ── Antigravity ── */}
        <div>
          <div className="text-[11px] font-semibold text-[var(--text-secondary)] mb-1.5">Antigravity</div>
          <div className="flex rounded-[8px] bg-[var(--bg-tertiary)] p-1">
            {seg(poolMode === 'remote', () => handleAGSource('remote'), <><Cloud size={13} /> 租号</>)}
            {seg(poolMode === 'local', () => handleAGSource('local'), <><HardDrive size={13} /> 本地号池</>)}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
            {poolMode === 'remote' ? '从远程服务器自动获取租号 Token' : '使用本地配置的账号池轮询 Token'}
          </div>

          {/* 每 app 接管开关 */}
          <div className="mt-2 flex flex-col gap-1.5">
            {agApps.map((p) => {
              const target = idToTarget(p.id)
              return (
                <div
                  key={p.id}
                  className={cn(
                    'flex items-center justify-between px-3 h-[44px] rounded-[8px] border',
                    p.detected ? 'border-[var(--border-light)]' : 'opacity-40 border-transparent',
                  )}
                >
                  <div>
                    <div className="text-[12px] text-[var(--text-primary)] font-medium">{p.name}</div>
                    <div className={cn('text-[10px]', p.injected ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
                      {!p.detected ? '未安装' : p.injected ? '✓ 已接管' : '未接管'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={p.injected ? 'danger' : 'default'}
                    disabled={!p.detected || busy === target}
                    onClick={() => handleAGToggle(p)}
                    className="shrink-0 cursor-pointer min-w-[68px]"
                  >
                    {busy === target ? '...' : p.injected ? '停止' : '接管'}
                  </Button>
                </div>
              )
            })}
          </div>
        </div>

        <div className="border-t border-[var(--border-light)]" />

        {/* ── Codex(三态) ── */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">Codex</span>
            {!codexApp?.detected && <span className="text-[10px] text-[var(--text-muted)]">未安装</span>}
          </div>
          <div className="flex rounded-[8px] bg-[var(--bg-tertiary)] p-1">
            {seg(codexState === 'rental' && !forceRelayOpen, () => handleCodexPick('rental'), <><Cloud size={13} /> 租号</>, !codexApp?.detected || busy === 'codex')}
            {seg(relayOpen, () => handleCodexPick('relay'), <><KeyRound size={13} /> 中转 API</>, !codexApp?.detected || busy === 'codex')}
            {seg(codexState === 'off' && !forceRelayOpen, () => handleCodexPick('off'), busy === 'codex' ? '...' : '不接管', !codexApp?.detected || busy === 'codex')}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
            {relayOpen ? '用你的卡密直连第三方中转站(仅 Codex)' : codexState === 'rental' ? '从远程服务器租用 ChatGPT 账号' : 'Codex 不经本地代理,使用其原生登录'}
          </div>

          {/* 中转配置(渐进式披露) */}
          {relayOpen && (
            <div className="mt-3 flex flex-col gap-3 rounded-[8px] border border-[var(--border-light)] bg-[var(--bg-card)] p-3">
              <div>
                <div className="text-[11px] text-[var(--text-muted)] mb-1">中转协议</div>
                <div className="flex gap-2">
                  {[
                    { v: 'responses', label: 'Codex /responses' },
                    { v: 'chat', label: '通用 /chat' },
                  ].map(({ v, label }) => (
                    <button
                      key={v}
                      onClick={() => setRelayProtocol(v)}
                      className={cn(
                        'flex-1 py-1.5 rounded-[6px] text-[12px] font-semibold border transition-colors duration-200 cursor-pointer',
                        relayProtocol === v
                          ? 'border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/5'
                          : 'border-[var(--border-light)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-1 leading-relaxed">
                  {relayProtocol === 'chat'
                    ? '中转只支持 /v1/chat/completions(大多数中转站)。客户端自动转码。'
                    : '中转兼容 Codex /responses 协议。原样透传,最稳。'}
                </p>
              </div>

              <div>
                <div className="text-[11px] text-[var(--text-muted)] mb-1">
                  中转地址(自动追加 {relayProtocol === 'chat' ? '/chat/completions' : '/responses'})
                </div>
                <Input value={relayBase} onChange={(e) => setRelayBase(e.target.value)} placeholder="例: https://your-relay.com/v1" />
              </div>

              <div>
                <div className="text-[11px] text-[var(--text-muted)] mb-1">卡密 / API Key</div>
                <Input type="password" value={relayKey} onChange={(e) => setRelayKey(e.target.value)} placeholder="sk-..." />
              </div>

              <div>
                <div className="text-[11px] text-[var(--text-muted)] mb-1">模型映射(可选:把本地模型名映射到中转站的模型)</div>
                {modelMaps.length === 0 && (
                  <div className="text-[10px] text-[var(--text-muted)] mb-1.5 leading-relaxed">
                    不配置则按原模型名透传。中转站若无 gpt-5.5 等模型,需在此映射到它支持的模型。
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  {modelMaps.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      {/* 本地模型:可选常用项或自定义输入 */}
                      <input
                        list={`codex-local-models-${idx}`}
                        value={row.from}
                        onChange={(e) => updateMapRow(idx, { from: e.target.value })}
                        placeholder="本地模型"
                        className="flex-1 min-w-0 h-8 rounded-md border border-[var(--border-light)] bg-transparent px-2 text-[12px] font-mono"
                      />
                      <datalist id={`codex-local-models-${idx}`}>
                        {KNOWN_MODELS.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      <span className="text-[var(--text-muted)] text-[12px] shrink-0">→</span>
                      <Input
                        value={row.to}
                        onChange={(e) => updateMapRow(idx, { to: e.target.value })}
                        placeholder="中转模型名"
                        className="flex-1 min-w-0 h-8 text-[12px] font-mono"
                      />
                      <button
                        onClick={() => removeMapRow(idx)}
                        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-tertiary)] transition-colors duration-200 cursor-pointer"
                        title="删除此映射"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addMapRow}
                  className="mt-1.5 flex items-center gap-1 text-[12px] text-[var(--primary)] hover:opacity-80 transition-opacity cursor-pointer"
                >
                  <Plus size={13} /> 添加映射
                </button>
              </div>

              <Button onClick={handleSaveRelay} disabled={savingRelay} className="w-full cursor-pointer">
                {savingRelay ? '保存中...' : codexState === 'relay' ? '更新中转配置' : '启用中转并接管'}
              </Button>
            </div>
          )}
        </div>

        <div className="border-t border-[var(--border-light)]" />

        {/* ── Claude Code(CLI + VSCode 扩展) ── */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">Anthropic</span>
            {!claudeApp?.detected && <span className="text-[10px] text-[var(--text-muted)]">未检测到</span>}
          </div>
          <div
            className={cn(
              'flex items-center justify-between px-3 h-[44px] rounded-[8px] border',
              claudeApp?.detected ? 'border-[var(--border-light)]' : 'opacity-40 border-transparent',
            )}
          >
            <div>
              <div className="text-[12px] text-[var(--text-primary)] font-medium">Claude Code (CLI + VSCode)</div>
              <div className={cn('text-[10px]', claudeInjected ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
                {!claudeApp?.detected ? '未检测到 ~/.claude' : claudeInjected ? '✓ 已接管' : '未接管'}
              </div>
            </div>
            <Button
              size="sm"
              variant={claudeInjected ? 'danger' : 'default'}
              disabled={!claudeApp?.detected || busy === 'claude'}
              onClick={handleClaudeToggle}
              className="shrink-0 cursor-pointer min-w-[68px]"
            >
              {busy === 'claude' ? '...' : claudeInjected ? '停止' : '接管'}
            </Button>
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            从远程服务器租用 Claude 订阅号;接管写入 ~/.claude/settings.json。CLI 下次启动生效,VSCode 扩展需 Reload Window。
          </div>
        </div>

        {/* macOS 权限引导 */}
        {isMac && agApps.some((p) => p.id === 'antigravity_hub' && p.detected && !p.injected) && (
          <div className="flex items-start justify-between gap-2 px-1">
            <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              接管 Hub 需修改应用文件,需授予 <span className="text-[var(--text-secondary)] font-medium">App 管理</span> 权限。
            </div>
            <Button size="sm" variant="ghost" className="shrink-0 cursor-pointer text-[11px] h-6 px-2" onClick={() => api.openSystemPermissionSettings()}>
              去授权
            </Button>
          </div>
        )}

        {/* 本地代理状态 */}
        <div className="mt-auto pt-1">
          <div className="flex items-center justify-between px-3 py-2 rounded-[8px] bg-[var(--bg-tertiary)] border border-[var(--border-light)]">
            <div className="flex items-center gap-2">
              <span className={cn('w-2 h-2 rounded-full', proxyRunning ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
              <span className="text-[12px] text-[var(--text-secondary)]">本地代理</span>
            </div>
            <span className="text-[12px] font-mono-data text-[var(--text-muted)]">
              {proxyRunning ? `运行中 · 127.0.0.1:${proxyPort}` : '未运行'}
            </span>
          </div>
          <div className="mt-2 text-[10px] text-[var(--text-muted)] leading-relaxed px-1">
            接管后对应 app 的请求经本地代理自动注入令牌;选「停止 / 不接管」即恢复原状。
          </div>
        </div>
      </CardContent>
      <Modal {...modalProps} />
      <LoadingOverlay show={busy !== null} label={busyLabel} />
    </Card>
  )
}
