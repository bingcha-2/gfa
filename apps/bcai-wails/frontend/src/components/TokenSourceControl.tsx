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
import { useT, t as tr } from '@/i18n'
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
  const t = useT()
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
  //
  // ⚠ 关键:任何弹窗(showAlert/showConfirm)前都必须先 setBusy(null) 关掉 LoadingOverlay。
  // LoadingOverlay 的 z-index(z-overlay=70) 高于 Dialog(z-modal=60),不先关就会把弹窗整个
  // 盖住 —— 用户只看到转圈遮罩、看不到下面的提示/按钮。故每个分支都先关遮罩再弹。
  const runTakeover = async (target: string, inject: boolean): Promise<boolean> => {
    setBusy(target)
    setBusyLabel(inject ? t('takeover.injecting', { name: targetName(target) }) : t('takeover.stopping', { name: targetName(target) }))
    try {
      const msg = inject ? await api.injectSelected([target]) : await api.restoreSelected([target])

      // ── 根证书降级安装(CA_DEGRADED):接管已生效、推理正常,但证书降级到「当前用户」库,
      //    少数机器 Chromium 不信任 → 打开可能白屏。alert 提示用户白屏时的排查办法(关安全软件 /
      //    管理员运行后重新接管)。这是「软成功」,弹完仍等状态翻转、返回 true。
      if (msg && msg.includes('CA_DEGRADED:')) {
        setBusy(null) // 先关遮罩,否则弹窗被盖住
        const detail = msg.split('CA_DEGRADED:').pop()?.trim() || msg
        await showAlert(t('takeover.caDegradedTitle'), detail)
        await waitForInjected(target, inject)
        return true
      }
      // ── 根证书没装上(CA_FAILED):推理已走号池(正常),只是证书没信任、Max 不显示。
      //    不再自称「接管成功」。macOS 首选让用户【重新接管】——点了会再弹一次系统密码框,输入即
      //    当场装上证书并带 Max 重启(而不是把人丢进钥匙串自己摸索)。手动兜底步骤已在 detail 文案里。
      if (msg && msg.includes('CA_FAILED:')) {
        setBusy(null)
        const detail = msg.split('CA_FAILED:').pop()?.trim() || msg
        if (isMac) {
          const retry = await showConfirm(t('takeover.caFailedTitle'), detail, {
            confirmLabel: t('takeover.caRetakeBtn'),
            cancelLabel: t('common.later'),
          })
          if (retry) {
            return await runTakeover(target, true) // 递归重试:再弹密码框,装上则带 Max 重启
          }
        } else {
          await showAlert(t('takeover.caFailedTitle'), detail)
        }
        await waitForInjected(target, inject)
        return true
      }
      // ── Windows 商店版 Claude Desktop 无法接管:后端用 STORE_CLAUDE: 前缀标记 → 弹专门引导,
      //    「去下载独立安装器」按钮直接打开官网下载页,而不是泛化的「操作失败」死胡同。
      if (msg && msg.includes('STORE_CLAUDE:')) {
        setBusy(null)
        await fetchIDEStatus()
        const detail = msg.split('STORE_CLAUDE:').pop()?.replace(/\)\s*$/, '').trim() || msg
        const go = await showConfirm(t('takeover.storeClaudeTitle'), detail, { confirmLabel: t('takeover.storeClaudeBtn'), cancelLabel: t('common.later') })
        if (go) api.openURL('https://claude.ai/download')
        return false
      }
      // ── 失败(尤其 macOS 权限)直接走错误分支,不必等状态翻转。
      if (/失败|权限|permission|not permitted|denied/i.test(msg) && isMac) {
        setBusy(null)
        await fetchIDEStatus()
        await showAlert(t('takeover.permissionTitle'), t('takeover.permissionBody', { message: msg }))
        await api.openSystemPermissionSettings()
        return false
      }
      if (msg && msg.trim() && /失败/.test(msg)) {
        setBusy(null)
        await fetchIDEStatus()
        await showAlert(t('takeover.opFailed'), msg)
        return false
      }
      // 等真实状态翻转(loading 期间保持遮罩)。
      setBusyLabel(inject ? t('takeover.injectingWait', { name: targetName(target) }) : t('takeover.stoppingWait', { name: targetName(target) }))
      await waitForInjected(target, inject)
      return true
    } catch (err) {
      setBusy(null) // 先关遮罩再弹错误窗,否则被遮罩盖住
      await fetchIDEStatus()
      const raw = String(err)
      // 出口前置闸拦截:后端用 EGRESS_BLOCKED: 前缀标记「未通过出口检查、已拒绝接管」,
      // 弹专门的强提示(开 TUN 引导),而不是泛化的「操作失败」。
      if (raw.includes('EGRESS_BLOCKED:')) {
        const detail = raw.split('EGRESS_BLOCKED:').pop()?.trim() || raw
        await showAlert(t('takeover.egressBlockedTitle'), detail)
        return false
      }
      await showAlert(t('takeover.opFailed'), raw)
      return false
    } finally {
      setBusy(null)
    }
  }

  // 接管前校验账号卡;无卡则引导激活,不下发后端动作。
  const ensureCard = async (productLabel: string): Promise<boolean> => {
    if (hasCard) return true
    await showAlert(t('takeover.needCardTitle'), t('takeover.needCardBody', { product: productLabel }))
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
        t('takeover.desktopConfirmTitle'),
        t('takeover.desktopConfirmBody'),
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
    const { target, name, injected, detected = true, undetectedText = tr('takeover.notInstalled'), onToggle } = opts
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
            {!detected ? undetectedText : injected ? t('takeover.injected') : t('takeover.notInjected')}
          </div>
        </div>
        <Button
          size="sm"
          variant={injected ? 'secondary' : 'default'}
          disabled={!detected || busy === target}
          onClick={onToggle}
          className="shrink-0 cursor-pointer min-w-[68px]"
        >
          {busy === target ? '...' : injected ? t('takeover.stop') : t('takeover.takeover')}
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
      <CardHeader><CardTitle><Zap size={15} /> {t('takeover.title')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* 生态自适应网格:加生态 = 加块,横向铺开,不挤压 */}
        <div
          className="grid gap-3 items-start"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}
        >
          {/* ── Antigravity ── */}
          <Block title="Antigravity" provider="antigravity" note={t('takeover.agNote')}>
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
          <Block title="Codex" provider="codex" note={t('takeover.codexNote')}>
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
            note={t('takeover.claudeNote')}
            footnote={t('takeover.claudeFootnote')}
          >
            {takeoverRow({
              target: 'claude',
              name: 'Claude Code (CLI + VSCode)',
              injected: claudeInjected,
              detected: !!claudeApp?.detected,
              undetectedText: t('takeover.noClaudeDir'),
              onToggle: handleClaudeToggle,
            })}
          </Block>

          {/* ── Claude Desktop(Code/Cowork,MITM 接管;macOS/Windows 常显示,未装则灰显) ── */}
          {showClaudeDesktop && (
            <Block
              title={t('takeover.desktopTitle')}
              provider="anthropic"
              note={t('takeover.desktopNote')}
              footnote={
                claudeDesktopApp?.detected ? (
                  <>
                    <span className="text-[var(--text-secondary)]">{t('takeover.desktopFootDetected1')}</span>{t('takeover.desktopFootDetected2')}<span className="text-[var(--text-secondary)]">{t('takeover.desktopFootDetected3')}</span>{t('takeover.desktopFootDetected4')}
                  </>
                ) : (
                  <>{t('takeover.desktopFootUndetected1')}<span className="text-[var(--text-secondary)]">{t('takeover.desktopFootUndetected2')}</span>{t('takeover.desktopFootUndetected3')}</>
                )
              }
            >
              {takeoverRow({
                target: 'claude_desktop',
                name: 'Claude Desktop (Code/Cowork)',
                injected: claudeDesktopInjected,
                detected: !!claudeDesktopApp?.detected,
                undetectedText: t('takeover.notInstalledOrDetected'),
                onToggle: handleClaudeDesktopToggle,
              })}
            </Block>
          )}
        </div>

        {/* macOS 权限引导(整宽) */}
        {isMac && agApps.some((p) => p.id === 'antigravity_hub' && p.detected && !p.injected) && (
          <div className="flex items-center justify-between gap-2 rounded-[8px] border border-[var(--border-light)] px-3 py-2">
            <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              {t('takeover.hubPermission1')}<span className="text-[var(--text-secondary)] font-medium">{t('takeover.hubPermission2')}</span>{t('takeover.hubPermission3')}
            </div>
            <Button size="sm" variant="ghost" className="shrink-0 cursor-pointer text-[11px] h-6 px-2" onClick={() => api.openSystemPermissionSettings()}>
              {t('takeover.goAuthorize')}
            </Button>
          </div>
        )}

        {/* 本地代理状态(整宽页脚) */}
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px] bg-[var(--bg-tertiary)] border border-[var(--border-light)]">
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full', proxyRunning ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
            <span className="text-[12px] text-[var(--text-secondary)]">{t('takeover.localProxy')}</span>
            <span className="text-[10px] text-[var(--text-muted)]">{t('takeover.localProxyNote')}</span>
          </div>
          <span className="text-[12px] font-mono-data text-[var(--text-muted)] shrink-0">
            {proxyRunning ? t('takeover.proxyRunning', { port: proxyPort }) : t('takeover.proxyStopped')}
          </span>
        </div>
      </CardContent>
      <Modal {...modalProps} />
      <LoadingOverlay show={busy !== null} label={busyLabel} />
    </Card>
  )
}
