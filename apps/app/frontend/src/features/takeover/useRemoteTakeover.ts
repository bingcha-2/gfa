import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useModal } from '@/components/Modal'
import { useCompetingRelayGate } from '@/components/CompetingRelayDialog'
import * as api from '@/services/wails'
import { isMacPlatform } from '@/lib/platform'
import { useT } from '@/i18n'

/**
 * useRemoteTakeover —— 远程托管接管引擎(从原 TokenSourceControl 抽出,逐字保留所有分支)。
 *
 * 接管中心的 Claude / Codex / Antigravity「远程托管」卡共用这套执行逻辑:注入/还原 +
 * macOS 权限引导、CA 降级(CA_DEGRADED)、CA 未装(CA_FAILED,mac 可重试)、Windows
 * 商店版 Claude(STORE_CLAUDE)、出口前置闸(EGRESS_BLOCKED)、操作失败兜底。
 *
 * 返回执行器 + busy 态 + 需在宿主里渲染的 modalProps;loading 遮罩由宿主据 busy 渲染。
 */

// 产品 id → 接管 target(后端 InjectSelected/RestoreSelected 用)。
function idToTarget(id: string): string {
  if (id === 'antigravity_ide') return 'ide'
  if (id === 'codex') return 'codex'
  if (id === 'claude_code') return 'claude'
  if (id === 'claude_desktop') return 'claude_desktop'
  return 'hub'
}

const CLAUDE_STANDALONE_WIN_DOWNLOAD_URL = 'https://claude.ai/api/desktop/win32/x64/exe/latest/redirect'

// 只写家目录配置的接管目标:Claude Code → ~/.claude/settings.json,Codex → ~/.codex/config.toml。
// 家目录下的隐藏目录不归 macOS TCC 管,它们接管失败【一定】与「App 管理」这类隐私权限无关
// (实际成因通常是目录被 root 占了),引导用户去开权限只会让人白折腾。其余目标(Hub 打 asar 补丁、
// IDE / Desktop 要动已安装的应用)才可能真的缺 App 管理,保留原引导。
const HOME_CONFIG_TARGETS = new Set(['claude', 'codex'])

export function useRemoteTakeover() {
  const t = useT()
  const config = useAppStore((s) => s.config)
  const fetchIDEStatus = useAppStore((s) => s.fetchIDEStatus)
  const { showAlert, showConfirm, modalProps } = useModal()
  const { confirmSanitize, dialogProps: relayDialogProps } = useCompetingRelayGate()

  const hasCard = !!config?.userToken && config.userToken.trim() !== ''
  const isMac = isMacPlatform()

  const [busy, setBusy] = useState<string | null>(null)
  const [busyLabel, setBusyLabel] = useState('')

  // target → 展示名(loading 文案用)。
  const targetName = (target: string) =>
    target === 'codex' ? 'Codex'
      : target === 'claude' ? 'Claude Code'
        : target === 'claude_desktop' ? 'Claude Desktop'
          : target === 'ide' ? 'Antigravity IDE'
            : 'Antigravity Hub'

  // 轮询 IDE 状态,直到目标产品的 injected 翻到期望值(接管/还原后端是异步的)。超时即返回。
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
  // 每个弹窗分支都先 setBusy(null) 再弹 —— 等用户读弹窗时本就不该继续转圈。这【不再】是
  // 正确性要求:LoadingOverlay 的 z 已经低于 Dialog,漏关也只是多转个圈,不会盖住弹窗
  // (盖住弹窗曾是真事故,见 LoadingOverlay 的注释)。
  const runTakeover = async (target: string, inject: boolean): Promise<boolean> => {
    setBusy(target)
    setBusyLabel(inject ? t('takeover.injecting', { name: targetName(target) }) : t('takeover.stopping', { name: targetName(target) }))
    try {
      const msg = inject ? await api.injectSelected([target]) : await api.restoreSelected([target])

      // ── 根证书降级安装(CA_DEGRADED):接管已生效、推理正常,但证书降级到「当前用户」库,
      //    少数机器 Chromium 不信任 → 打开可能白屏。这是「软成功」,弹完仍等状态翻转、返回 true。
      if (msg && msg.includes('CA_DEGRADED:')) {
        setBusy(null) // 先关遮罩,否则弹窗被盖住
        const detail = msg.split('CA_DEGRADED:').pop()?.trim() || msg
        await showAlert(t('takeover.caDegradedTitle'), detail)
        await waitForInjected(target, inject)
        return true
      }
      // ── 根证书没装上(CA_FAILED):推理已走号池(正常),只是证书没信任、Max 不显示。
      //    macOS 首选让用户【重新接管】——点了会再弹一次系统密码框,输入即当场装上证书并带 Max 重启。
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
      // ── Windows 商店版 Claude Desktop 无法接管:STORE_CLAUDE 前缀 → 弹专门引导,确认即打开官方独立版下载。
      if (msg && msg.includes('STORE_CLAUDE:')) {
        setBusy(null)
        await fetchIDEStatus()
        const detail = msg.split('STORE_CLAUDE:').pop()?.replace(/\)\s*$/, '').trim() || msg
        const go = await showConfirm(t('takeover.storeClaudeTitle'), detail, { confirmLabel: t('takeover.storeClaudeBtn'), cancelLabel: t('common.later') })
        if (go) {
          api.openURL(CLAUDE_STANDALONE_WIN_DOWNLOAD_URL)
        }
        return false
      }
      // ── 文件属主/权限位问题(FILE_PERM):后端已诊断出是谁占着目录、该怎么修,原样透出即可。
      //    这与系统隐私权限无关,绝不能引导去开「App 管理」——用户照着做也修不好。
      if (msg && msg.includes('FILE_PERM:')) {
        setBusy(null)
        await fetchIDEStatus()
        const detail = msg.split('FILE_PERM:').pop()?.replace(/\)\s*$/, '').trim() || msg
        await showAlert(t('takeover.filePermTitle'), detail)
        return false
      }
      // ── 失败(尤其 macOS 权限)直接走错误分支,不必等状态翻转。
      //    「App 管理」引导只对会改应用包的目标成立,见 HOME_CONFIG_TARGETS。
      if (/失败|权限|permission|not permitted|denied/i.test(msg) && isMac && !HOME_CONFIG_TARGETS.has(target)) {
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
      // 出口前置闸拦截:EGRESS_BLOCKED 前缀 → 专门强提示(开 TUN 引导),而不是泛化「操作失败」。
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

  // 接管前的第三方中转预检:检测 → 弹「封号免责」窗 → 按用户选择清理/跳过/取消。
  // 返回是否继续接管(cancel=false;clean/skip=true)。检测或清理失败都不阻断接管。
  const preflightSanitize = async (target: string): Promise<boolean> => {
    let conflicts: api.ClaudeConfigConflict[] = []
    try {
      conflicts = await api.detectCompetingClaudeConfig()
    } catch {
      return true // 检测失败不阻断接管
    }
    if (!conflicts || conflicts.length === 0) return true

    const decision = await confirmSanitize(conflicts)
    if (decision === 'cancel') return false
    if (decision === 'clean') {
      setBusy(target)
      setBusyLabel(t('takeover.sanitize.cleaning'))
      try {
        const rep = await api.sanitizeCompetingClaudeConfig([]) // [] = 清理全部检出
        setBusy(null)
        if ((rep.skipped?.length ?? 0) > 0) {
          await showAlert(t('takeover.sanitize.doneTitle'), t('takeover.sanitize.skippedBody', { skipped: rep.skipped.length }))
        }
      } catch (e) {
        setBusy(null)
        await showAlert(t('takeover.opFailed'), String(e))
      }
    }
    return true // clean 或 skip 都继续接管
  }

  // 接管前校验账号卡;无卡则引导激活,不下发后端动作。
  const ensureCard = async (productLabel: string): Promise<boolean> => {
    if (hasCard) return true
    await showAlert(t('takeover.needCardTitle'), t('takeover.needCardBody', { product: productLabel }))
    return false
  }

  // Claude Desktop 接管前的二次确认(会重启 Claude.app,中断 Cowork 会话)。
  const confirmDesktopTakeover = (): Promise<boolean> =>
    showConfirm(t('takeover.desktopConfirmTitle'), t('takeover.desktopConfirmBody'))

  return {
    busy,
    // 不忙时一律给空 label:setBusy(null) 不会清 busyLabel,而宿主的遮罩还有 hostBusy 这个
    // 独立开关 —— 直接透出 busyLabel 会让遮罩在弹窗期间挂着「正在接管 X…」的旧文案。
    busyLabel: busy !== null ? busyLabel : '',
    hasCard, runTakeover, ensureCard, confirmDesktopTakeover, preflightSanitize, modalProps, relayDialogProps,
  }
}
