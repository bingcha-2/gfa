import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    injectSelected: vi.fn(),
    restoreSelected: vi.fn(),
    openSystemPermissionSettings: vi.fn(),
    openURL: vi.fn(),
    detectCompetingClaudeConfig: vi.fn().mockResolvedValue([]),
    sanitizeCompetingClaudeConfig: vi.fn(),
  },
}))
vi.mock('@/services/wails', () => ({
  injectSelected: apiMocks.injectSelected,
  restoreSelected: apiMocks.restoreSelected,
  openSystemPermissionSettings: apiMocks.openSystemPermissionSettings,
  openURL: apiMocks.openURL,
  detectCompetingClaudeConfig: apiMocks.detectCompetingClaudeConfig,
  sanitizeCompetingClaudeConfig: apiMocks.sanitizeCompetingClaudeConfig,
}))

const { store } = vi.hoisted(() => ({
  store: {
    state: {
      config: { userToken: 'tok-xyz' },
      fetchIDEStatus: () => [] as Array<Record<string, unknown>>,
    },
  },
}))
vi.mock('@/stores/useAppStore', () => ({
  useAppStore: (selector: (s: typeof store.state) => unknown) => selector(store.state),
}))

import { Modal } from '@/components/Modal'
import { useRemoteTakeover } from './useRemoteTakeover'

// 只渲染引擎 + 它的弹窗:分支逻辑按 target 分岔,用最小宿主逐个 target 覆盖,
// 不必把整个接管中心页(及其宿主防护面板)拖进来。
function Harness({ target, inject = true }: { target: string; inject?: boolean }) {
  const tk = useRemoteTakeover()
  return (
    <>
      <button type="button" onClick={() => void tk.runTakeover(target, inject)}>go</button>
      <Modal {...tk.modalProps} />
      <span data-testid="busy-label">{tk.busyLabel}</span>
    </>
  )
}

function setPlatform(p: string) {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true })
}

// openSystemPermissionSettings 是在 showAlert 之后 await 的,弹窗不点掉它永远不会被调 ——
// 不先关窗就断言 not.toHaveBeenCalled 会无条件通过。所有相关断言都必须先走完这一步。
async function dismissDialog() {
  fireEvent.click(await screen.findByRole('button', { name: '我知道了' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

// 后端 InjectSelected 的实际线格式:"<产品>: 接管失败 (<err>)"。
const FILE_PERM_HINT = '~/.claude 的属主是 root,当前用户没有写权限,接管无法写入配置。\n\n请在终端执行:\n\n    sudo chown -R "$(whoami)" "/Users/ink/.claude"'
const filePermMsg = (name: string) => `${name}: 接管失败 (FILE_PERM:${FILE_PERM_HINT})`

describe('useRemoteTakeover — 接管失败的分派', () => {
  afterEach(() => vi.clearAllMocks())

  // ── FILE_PERM:文件属主/权限位问题,与 macOS 隐私权限无关 ──

  it('Claude Code 报 FILE_PERM:原样展示后端诊断,不去开「App 管理」', async () => {
    setPlatform('MacIntel')
    apiMocks.injectSelected.mockResolvedValueOnce(filePermMsg('Claude Code'))
    render(<Harness target="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('需要修复文件权限')
    // 关键:必须把可执行的修复命令原样给到用户。
    expect(dialog).toHaveTextContent('sudo chown -R "$(whoami)" "/Users/ink/.claude"')
    expect(dialog).toHaveTextContent('属主是 root')
    // 这是本次修复的核心:文件权限问题绝不能再把人引去开 App 管理。
    await dismissDialog()
    expect(apiMocks.openSystemPermissionSettings).not.toHaveBeenCalled()
  })

  it('FILE_PERM 的指引不被外层括号截断(与后端 %v 包装的往返契约)', async () => {
    setPlatform('MacIntel')
    apiMocks.injectSelected.mockResolvedValueOnce(filePermMsg('Claude Code'))
    render(<Harness target="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    const dialog = await screen.findByRole('dialog')
    // 后端原文以 .claude" 收尾;包装用的右括号要被剥掉,原文本身一个字符都不能少。
    expect(dialog.textContent).toContain(FILE_PERM_HINT.split('\n').pop())
    expect(dialog.textContent).not.toContain('.claude")')
  })

  it('还原时报 FILE_PERM 走同一分支', async () => {
    setPlatform('MacIntel')
    apiMocks.restoreSelected.mockResolvedValueOnce(`Claude Code: 恢复失败 (FILE_PERM:${FILE_PERM_HINT})`)
    render(<Harness target="claude" inject={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    expect(await screen.findByRole('dialog')).toHaveTextContent('需要修复文件权限')
    await dismissDialog()
    expect(apiMocks.openSystemPermissionSettings).not.toHaveBeenCalled()
  })

  // ── 「App 管理」引导只留给真正改应用包的目标 ──

  it('Claude Code 普通失败:不引导去开「App 管理」,原样展示错误', async () => {
    setPlatform('MacIntel')
    apiMocks.injectSelected.mockResolvedValueOnce('Claude Code: 接管失败 (序列化 settings.json 失败)')
    render(<Harness target="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('序列化 settings.json 失败')
    expect(dialog).not.toHaveTextContent('App 管理')
    await dismissDialog()
    expect(apiMocks.openSystemPermissionSettings).not.toHaveBeenCalled()
  })

  it('Codex 普通失败:同样不引导去开「App 管理」(只写 ~/.codex/config.toml)', async () => {
    setPlatform('MacIntel')
    apiMocks.injectSelected.mockResolvedValueOnce('Codex: 接管失败 (写入 config.toml 失败)')
    render(<Harness target="codex" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    await screen.findByRole('dialog')
    await dismissDialog()
    expect(apiMocks.openSystemPermissionSettings).not.toHaveBeenCalled()
  })

  // 回归护栏:Hub 打 asar 补丁,是真的需要 App 管理,这条引导不能被一并删掉。
  it('Antigravity Hub 失败:仍然引导去开「App 管理」', async () => {
    setPlatform('MacIntel')
    apiMocks.injectSelected.mockResolvedValueOnce('Antigravity Hub: 接管失败 (permission denied)')
    render(<Harness target="hub" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('App 管理')
    await dismissDialog()
    await waitFor(() => expect(apiMocks.openSystemPermissionSettings).toHaveBeenCalled())
  })

  it('Windows 上任何目标都不提「App 管理」', async () => {
    setPlatform('Win32')
    apiMocks.injectSelected.mockResolvedValueOnce('Antigravity Hub: 接管失败 (permission denied)')
    render(<Harness target="hub" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    await screen.findByRole('dialog')
    await dismissDialog()
    expect(apiMocks.openSystemPermissionSettings).not.toHaveBeenCalled()
  })

  // ── busyLabel:弹窗期间遮罩已关,label 不能还挂着「正在接管…」 ──

  it('弹窗打开时 busyLabel 已清空,遮罩不会残留「正在接管…」文案', async () => {
    setPlatform('MacIntel')
    apiMocks.injectSelected.mockResolvedValueOnce(filePermMsg('Claude Code'))
    render(<Harness target="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    await screen.findByRole('dialog')
    expect(screen.getByTestId('busy-label')).toBeEmptyDOMElement()
  })
})
