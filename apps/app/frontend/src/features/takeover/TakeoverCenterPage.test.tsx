import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { state, api } = vi.hoisted(() => ({
 state: { account: null as null | { subscriptions: { status: string; expiresAt: string; products: string[] }[] }, config: { userToken: 'session', codexTakeoverAuthMode: '' }, ideProducts: [] as Array<{ id: string; detected: boolean; injected: boolean }>, fetchIDEStatus: vi.fn(), fetchConfig: vi.fn() },
 api: { hostClaudeGateway: vi.fn(), injectSelected: vi.fn(), injectCodexWithMode: vi.fn(), restoreSelected: vi.fn(), openSystemPermissionSettings: vi.fn() },
}))
vi.mock('@/stores/useAppStore', () => ({ useAppStore: (selector: (s: typeof state) => unknown) => selector(state) }))
vi.mock('@/services/wails', () => api)
import { TakeoverCenterPage } from './TakeoverCenterPage'

beforeEach(() => {
 vi.clearAllMocks()
 state.account = null
 Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
 state.config.userToken = 'session'
 state.config.codexTakeoverAuthMode = ''
 api.injectCodexWithMode.mockImplementation(async () => { state.ideProducts[2].injected = true; return '已接管' })
 state.ideProducts = ['claude_code', 'claude_desktop', 'codex', 'antigravity_ide', 'antigravity_hub'].map(id => ({ id, detected: true, injected: false }))
 state.fetchIDEStatus.mockImplementation(async () => state.ideProducts)
 api.hostClaudeGateway.mockImplementation(async () => { state.ideProducts[0].injected = true; return '已托管' })
 api.injectSelected.mockImplementation(async (targets: string[]) => { if (targets.includes('claude_desktop')) state.ideProducts[1].injected = true; return '已接管' })
 api.restoreSelected.mockImplementation(async () => { state.ideProducts.forEach(p => { p.injected = false }); return '已恢复' })
})

describe('Codex takeover modes', () => {
 it('defaults to account mode and confirms restart before applying', async () => {
  render(<TakeoverCenterPage />)
  expect(screen.getByLabelText('接管方式')).toHaveValue('account')
  fireEvent.click(button('Codex', '接管'))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('请先保存当前工作')
  expect(api.injectCodexWithMode).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '应用并重启' }))
  await waitFor(() => expect(api.injectCodexWithMode).toHaveBeenCalledWith('account'))
  await waitFor(() => expect(state.fetchConfig).toHaveBeenCalled())
 })
 it('allows cancelling a mode switch without modifying the running client', async () => {
  state.ideProducts[2].injected = true
  render(<TakeoverCenterPage />)
  fireEvent.change(screen.getByLabelText('接管方式'), { target: { value: 'api' } })
  fireEvent.click(button('Codex', '应用并重启'))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('Work 浏览器等账号功能可能不可用')
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(api.injectCodexWithMode).not.toHaveBeenCalled()
  expect(screen.getByText('当前接管方式：保留账号功能（默认）')).toBeInTheDocument()
 })
 it('switches an active client to API mode and remembers the applied mode', async () => {
  state.ideProducts[2].injected = true
  render(<TakeoverCenterPage />)
  fireEvent.change(screen.getByLabelText('接管方式'), { target: { value: 'api' } })
  fireEvent.click(button('Codex', '应用并重启'))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '应用并重启' }))
  await waitFor(() => expect(api.injectCodexWithMode).toHaveBeenCalledWith('api'))
  expect(await screen.findByText('当前接管方式：独立 API 模式')).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Codex' })).queryByRole('button', { name: '应用并重启' })).toBeNull()
 })
 it('retains the previous mode when the backend rejects a switch', async () => {
  state.ideProducts[2].injected = true
  state.config.codexTakeoverAuthMode = 'api'
  api.injectCodexWithMode.mockRejectedValueOnce(new Error('现有凭据无法读取'))
  render(<TakeoverCenterPage />)
  fireEvent.change(screen.getByLabelText('接管方式'), { target: { value: 'account' } })
  fireEvent.click(button('Codex', '应用并重启'))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '应用并重启' }))
  expect(await screen.findByText(/现有凭据无法读取/)).toBeInTheDocument()
  expect(screen.getByText('当前接管方式：独立 API 模式')).toBeInTheDocument()
  expect(state.fetchConfig).not.toHaveBeenCalled()
 })
})
const button = (name: string, action: string) => within(screen.getByRole('region', { name })).getByRole('button', { name: action })

describe('remote-only takeover', () => {
 it('has no self-owned account, sandbox or host-environment controls', () => {
  render(<TakeoverCenterPage />)
  expect(screen.getAllByRole('region')).toHaveLength(5)
  expect(screen.queryByText(/本地自有号|沙箱|时区|宿主防护/)).toBeNull()
 })
 it('Claude Code activates the server gateway', async () => {
  render(<TakeoverCenterPage />);fireEvent.click(button('Claude Code','接管'))
  await waitFor(() => expect(api.hostClaudeGateway).toHaveBeenCalledOnce())
  expect(api.injectSelected).not.toHaveBeenCalled()
 })
 it('does not fall back to legacy leasing when gateway quota is not assigned', async () => {
  api.hostClaudeGateway.mockRejectedValueOnce(new Error('尚未为你开通'))
  render(<TakeoverCenterPage />);fireEvent.click(button('Claude Code','接管'))
  expect(await screen.findByText(/尚未为你开通/)).toBeInTheDocument()
  expect(api.injectSelected).not.toHaveBeenCalled()
 })
 it('Desktop confirms restart then activates directly', async () => {
  render(<TakeoverCenterPage />);fireEvent.click(button('Claude Desktop','接管'))
  expect(api.injectSelected).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button',{name:'确认'}))
  await waitFor(() => expect(api.injectSelected).toHaveBeenCalledWith(['claude_desktop']))
 })
 it('restores a managed client even if it is no longer detected', async () => {
  state.ideProducts[0] = { id:'claude_code',detected:false,injected:true }
  render(<TakeoverCenterPage />);fireEvent.click(button('Claude Code','停止'))
  await waitFor(() => expect(api.restoreSelected).toHaveBeenCalledWith(['claude']))
 })
 it('requires login and disables missing clients', async () => {
  state.config.userToken='';state.ideProducts[2].detected=false
  render(<TakeoverCenterPage />)
  expect(button('Codex','接管')).toBeDisabled()
  fireEvent.click(button('Claude Code','接管'))
  expect(await screen.findByText('需要登录账号')).toBeInTheDocument()
  expect(api.hostClaudeGateway).not.toHaveBeenCalled()
 })
 it('does not show Desktop on Linux', () => {
  Object.defineProperty(navigator, 'platform', { value: 'Linux', configurable: true })
  render(<TakeoverCenterPage />)
  expect(screen.queryByRole('region',{name:'Claude Desktop'})).toBeNull()
 })
})

it('keeps Codex on the mother pool and requires a Codex subscription', () => {
 state.account = { subscriptions: [{ status: 'ACTIVE', expiresAt: '', products: ['anthropic'] }] }
 render(<TakeoverCenterPage />)
 expect(button('Codex','接管')).toBeDisabled()
 expect(within(screen.getByRole('region', { name: 'Codex' })).getByText('未订阅此产品')).toBeInTheDocument()
 expect(screen.queryByText(/母号池|网关计费/)).toBeNull()
 expect(button('Claude Code','接管')).not.toBeDisabled()
})
