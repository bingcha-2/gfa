import { useState, type ReactNode } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal, useModal } from '@/components/Modal'
import { LoadingOverlay } from '@/components/LoadingOverlay'
import { ProviderLogo } from '@/components/ProviderLogo'
import * as api from '@/services/wails'
import { cn } from '@/lib/utils'
import { isMacPlatform, isWindowsPlatform } from '@/lib/platform'
import { Zap } from 'lucide-react'

/**
 * 「接管」统一控制。号源固定为「官方透传」(从远程服务器自动获取 Token),
 * 不再向用户暴露来源选择 —— 每个产品只有一个「接管 / 停止」开关:
 *
 *   Antigravity:IDE / Hub 各一个开关。
 *   Codex:      单一开关。中转(relay)能力仍由后端保留,但不在此处暴露 UI ——
 *               若后端已配置为中转模式,接管时按中转生效,否则按官方透传。
 *   Anthropic:  Claude Code(CLI + VSCode)开关;macOS/Windows 上额外的 Claude Desktop 开关。
 *
 * 本地号池已下线,故无来源切换。
 */

// 产品 id → 接管 target(后端 InjectSelected/RestoreSelected 用)。
function idToTarget(id: string): string {
  if (id === 'antigravity_ide') return 'ide'
  if (id === 'codex') return 'codex'
  if (id === 'claude_code') return 'claude'
  if (id === 'claude_desktop') return 'claude_desktop'
  return 'hub'
}

export function TokenSourceControl() {
  const config = useAppStore((s) => s.config)
  const ideProducts = useAppStore((s) => s.ideProducts)
  const fetchIDEStatus = useAppStore((s) => s.fetchIDEStatus)
  const proxyRunning = useAppStore((s) => s.proxyRunning)
  const proxyPort = useAppStore((s) => s.proxyPort)
  const { showAlert, showConfirm, modalProps } = useModal()

  const hasCard = !!config?.accountCard && config.accountCard.trim() !== ''

  const agApps = ideProducts.filter((p) => p.id.startsWith('antigravity'))
  const codexApp = ideProducts.find((p) => p.id === 'codex')
  const claudeApp = ideProducts.find((p) => p.id === 'claude_code')
  const claudeDesktopApp = ideProducts.find((p) => p.id === 'claude_desktop')
  const isMac = isMacPlatform()
  // Claude 桌面端只在 macOS / Windows 存在(无官方 Linux 版)。在这两个平台上「常显示」
  // 接管块——未检测到则灰显「未安装」,而不是整块隐藏。隐藏才是反馈里「Claude 开着才冒出来」
  // 死循环的源头(详见后端 detectClaudeDesktopPathAuto 注释)。
  const showClaudeDesktop = isMac || isWindowsPlatform()

  const [busy, setBusy] = useState<string | null>(null)
  const [busyLabel, setBusyLabel] = useState('')

  // target → 展示名(loading 文案用)。
  const targetName = (target: string) =>
    target === 'codex' ? 'Codex'
      : target === 'claude' ? 'Claude Code'
      : target === 'claude_desktop' ? 'Claude Desktop'
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

  // 接管前校验账号卡;无卡则引导激活,不下发后端动作。
  const ensureCard = async (productLabel: string): Promise<boolean> => {
    if (hasCard) return true
    await showAlert('请先激活账号卡', `${productLabel} 接管需要账号卡,请在「账号卡配置」激活。`)
    return false
  }

  // ── Antigravity ──────────────────────────────────────────────
  const handleAGToggle = async (product: { id: string; injected: boolean }) => {
    const target = idToTarget(product.id)
    if (!product.injected && !(await ensureCard('Antigravity'))) return
    await runTakeover(target, !product.injected)
  }

  // ── Codex(单开关;中转能力由后端保留,不在 UI 暴露) ──────────
  const codexInjected = !!codexApp?.injected
  const handleCodexToggle = async () => {
    if (!codexInjected && !(await ensureCard('Codex'))) return
    await runTakeover('codex', !codexInjected)
  }

  // ── Claude Code(CLI + VSCode 扩展) ──────────────────────────
  const claudeInjected = !!claudeApp?.injected
  const handleClaudeToggle = async () => {
    if (!claudeInjected && !(await ensureCard('Claude Code'))) return
    await runTakeover('claude', !claudeInjected)
  }

  // ── Claude Desktop(Code/Cowork,MITM 接管;会重启 Claude.app,中断 Cowork 会话)──
  const claudeDesktopInjected = !!claudeDesktopApp?.injected
  const handleClaudeDesktopToggle = async () => {
    if (!claudeDesktopInjected) {
      if (!(await ensureCard('Claude Desktop'))) return
      const ok = await showConfirm(
        '接管 Claude Desktop',
        '接管会重启 Claude 桌面端 —— 这会中断当前正在运行的 Cowork 会话(聊天不受影响)。是否继续?',
      )
      if (!ok) return
    }
    await runTakeover('claude_desktop', !claudeDesktopInjected)
  }

  // 统一的「产品行」:名称 + 接管状态 + 接管/停止按钮。
  const takeoverRow = (opts: {
    target: string
    name: ReactNode
    injected: boolean
    detected?: boolean
    undetectedText?: string
    onToggle: () => void
  }) => {
    const { target, name, injected, detected = true, undetectedText = '未安装', onToggle } = opts
    return (
      <div
        className={cn(
          'flex items-center justify-between h-[40px]',
          !detected && 'opacity-40',
        )}
      >
        <div>
          <div className="text-[12px] text-[var(--text-primary)] font-medium">{name}</div>
          <div className={cn('text-[10px]', injected ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
            {!detected ? undetectedText : injected ? '✓ 已接管' : '未接管'}
          </div>
        </div>
        <Button
          size="sm"
          variant={injected ? 'secondary' : 'default'}
          disabled={!detected || busy === target}
          onClick={onToggle}
          className="shrink-0 cursor-pointer min-w-[68px]"
        >
          {busy === target ? '...' : injected ? '停止' : '接管'}
        </Button>
      </div>
    )
  }

  // 生态分组块:头(生态名 + 官方透传说明)+ 产品行 + 可选脚注。
  // 块在 CardContent 里按 auto-fit 自适应分列 —— 加一个生态 = 加一个块,而非一味变长。
  const Block = ({ title, provider, note, children, footnote }: {
    title: string; provider?: string; note?: string; children: ReactNode; footnote?: ReactNode
  }) => (
    <div className="rounded-[12px] border border-[var(--border-light)] p-3.5 flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1.5">
        {provider && <ProviderLogo provider={provider} />}
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[var(--text-primary)] leading-tight">{title}</div>
          {note && <div className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-tight">{note}</div>}
        </div>
      </div>
      <div className="flex flex-col divide-y divide-[var(--border-light)]">{children}</div>
      {footnote && <div className="text-[10px] text-[var(--text-muted)] leading-relaxed mt-2 pt-2 border-t border-[var(--border-light)]">{footnote}</div>}
    </div>
  )

  return (
    <Card>
      <CardHeader><CardTitle><Zap size={15} /> 接管</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* 生态自适应网格:加生态 = 加块,横向铺开,不挤压 */}
        <div
          className="grid gap-3 items-start"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}
        >
          {/* ── Antigravity ── */}
          <Block title="Antigravity" provider="antigravity" note="官方透传 · 从远程服务器自动获取 Token">
            {agApps.map((p) => (
              <div key={p.id}>
                {takeoverRow({
                  target: idToTarget(p.id),
                  name: p.name,
                  injected: p.injected,
                  detected: p.detected,
                  onToggle: () => handleAGToggle(p),
                })}
              </div>
            ))}
          </Block>

          {/* ── Codex ── */}
          <Block title="Codex" provider="codex" note="官方透传 · 从远程服务器租用 ChatGPT 账号">
            {takeoverRow({
              target: 'codex',
              name: 'Codex',
              injected: codexInjected,
              detected: !!codexApp?.detected,
              onToggle: handleCodexToggle,
            })}
          </Block>

          {/* ── Anthropic · Claude Code(CLI + VSCode 扩展) ── */}
          <Block
            title="Anthropic"
            provider="anthropic"
            note="官方透传 · 从远程租用 Claude 订阅"
            footnote="接管写入 ~/.claude/settings.json。CLI 下次启动生效,VSCode 扩展需 Reload Window。"
          >
            {takeoverRow({
              target: 'claude',
              name: 'Claude Code (CLI + VSCode)',
              injected: claudeInjected,
              detected: !!claudeApp?.detected,
              undetectedText: '未检测到 ~/.claude',
              onToggle: handleClaudeToggle,
            })}
          </Block>

          {/* ── Claude Desktop(Code/Cowork,MITM 接管;macOS/Windows 常显示,未装则灰显) ── */}
          {showClaudeDesktop && (
            <Block
              title="Anthropic · 桌面端"
              provider="anthropic"
              note="官方透传 · Code/Cowork 走号池,免费号即可"
              footnote={
                claudeDesktopApp?.detected ? (
                  <>
                    <span className="text-[var(--text-secondary)]">⚠ 请先接管,再登录 Claude</span>(顺序反了授权抓不到)。接管会重启 Claude(中断 Cowork,聊天不受影响)。<span className="text-[var(--text-secondary)]">Claude 更新或自行重启后需重新点接管</span>(代理随重启失效)。
                  </>
                ) : (
                  <>未检测到 Claude 桌面端。若已安装但未识别,可在<span className="text-[var(--text-secondary)]">「设置 → 安装路径」</span>手动指定 Claude 程序路径(无需先打开 Claude)。</>
                )
              }
            >
              {takeoverRow({
                target: 'claude_desktop',
                name: 'Claude Desktop (Code/Cowork)',
                injected: claudeDesktopInjected,
                detected: !!claudeDesktopApp?.detected,
                undetectedText: '未安装 / 未检测到',
                onToggle: handleClaudeDesktopToggle,
              })}
            </Block>
          )}
        </div>

        {/* macOS 权限引导(整宽) */}
        {isMac && agApps.some((p) => p.id === 'antigravity_hub' && p.detected && !p.injected) && (
          <div className="flex items-center justify-between gap-2 rounded-[8px] border border-[var(--border-light)] px-3 py-2">
            <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              接管 Hub 需修改应用文件,需授予 <span className="text-[var(--text-secondary)] font-medium">App 管理</span> 权限。
            </div>
            <Button size="sm" variant="ghost" className="shrink-0 cursor-pointer text-[11px] h-6 px-2" onClick={() => api.openSystemPermissionSettings()}>
              去授权
            </Button>
          </div>
        )}

        {/* 本地代理状态(整宽页脚) */}
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px] bg-[var(--bg-tertiary)] border border-[var(--border-light)]">
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full', proxyRunning ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
            <span className="text-[12px] text-[var(--text-secondary)]">本地代理</span>
            <span className="text-[10px] text-[var(--text-muted)]">· 接管后请求经此自动注入令牌,「停止」即恢复原状</span>
          </div>
          <span className="text-[12px] font-mono-data text-[var(--text-muted)] shrink-0">
            {proxyRunning ? `运行中 · 127.0.0.1:${proxyPort}` : '未运行'}
          </span>
        </div>
      </CardContent>
      <Modal {...modalProps} />
      <LoadingOverlay show={busy !== null} label={busyLabel} />
    </Card>
  )
}
