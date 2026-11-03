import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { useModal } from '@/components/Modal'
import * as api from '@/services/wails'
import { isMacPlatform } from '@/lib/platform'
import { useT } from '@/i18n'

/**
 * useRemoteTakeover —— 远程托管接管引擎(从原 TokenSourceControl 抽出,逐字保留所有分支)。
 *
 * 接管中心的 Claude / Codex / Antigravity「远程托管」卡共用这套执行逻辑:注入/还原 +
 * macOS 权限引导、Desktop 原生 3P 配置、出口前置闸(EGRESS_BLOCKED)、操作失败兜底。
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


// 只写家目录配置的接管目标:Claude Code → ~/.claude/settings.json,Codex → ~/.codex/config.toml。
// 家目录下的隐藏目录不归 macOS TCC 管,它们接管失败【一定】与「App 管理」这类隐私权限无关
// (实际成因通常是目录被 root 占了),引导用户去开权限只会让人白折腾。其余目标(Hub 打 asar 补丁、
// IDE / Desktop 要动已安装的应用)才可能真的缺 App 管理,保留原引导。
const HOME_CONFIG_TARGETS = new Set(['claude', 'codex', 'claude_desktop'])

export function useRemoteTakeover() {
  const t = useT()
  const config = useAppStore((s) => s.config)
  const fetchIDEStatus = useAppStore((s) => s.fetchIDEStatus)
  const { showAlert, showConfirm, modalProps } = useModal()

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
  const runTakeover = async (target: string, inject: boolean, retried = false): Promise<boolean> => {
    setBusy(target)
    setBusyLabel(inject ? t('takeover.injecting', { name: targetName(target) }) : t('takeover.stopping', { name: targetName(target) }))
    try {
      let msg: string
      if (inject && target === 'claude') {
        msg = await api.hostClaudeGateway()
      } else {
        msg = inject ? await api.injectSelected([target]) : await api.restoreSelected([target])
      }

      if (msg?.startsWith('DESKTOP_CLEANUP_REQUIRED:')) {
        setBusy(null)
        await showAlert('旧配置清理', msg.slice('DESKTOP_CLEANUP_REQUIRED:'.length))
      }
      if (msg?.startsWith('DESKTOP_RESTART_REQUIRED:')) {
        setBusy(null)
        await showAlert('请重启 Claude Desktop', msg.slice('DESKTOP_RESTART_REQUIRED:'.length))
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
      if (inject && target === 'codex' && msg?.includes('CODEX_ACCOUNT_REQUIRED:')) {
        setBusy(null)
        await showAlert(t('takeover.codexAccountTitle'), t('takeover.codexAccountBody'))
      }
      return true
    } catch (err) {
      setBusy(null) // 先关遮罩再弹错误窗,否则被遮罩盖住
      await fetchIDEStatus()
      const raw = String(err)
      // 其它工具(如 opclaude)留下的 Policies\Claude 网关策略会覆盖本软件配置:
      // 让用户确认后由后端备份并清理,然后自动重试一次(retried 防止循环)。
      if (inject && target === 'claude_desktop' && !retried && raw.includes('POLICY_CONFLICT:')) {
        const detail = raw.split('POLICY_CONFLICT:').pop()?.trim() || raw
        if (await showConfirm(t('takeover.policyConflictTitle'), t('takeover.policyConflictBody', { detail }))) {
          setBusy(target)
          setBusyLabel(t('takeover.injecting', { name: targetName(target) }))
          try {
            await api.clearDesktopPolicyConflict()
          } catch (clearErr) {
            setBusy(null)
            await showAlert(t('takeover.opFailed'), String(clearErr))
            return false
          }
          return runTakeover(target, inject, true)
        }
        return false
      }
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
    hasCard, runTakeover, ensureCard, confirmDesktopTakeover, modalProps,
  }
}
