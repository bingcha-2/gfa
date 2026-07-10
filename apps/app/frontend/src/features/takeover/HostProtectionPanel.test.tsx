import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostProtectionPanel } from './HostProtectionPanel'

describe('HostProtectionPanel', () => {
  it('requires an explicit waiver before keeping the real timezone', () => {
    const onTakeover = vi.fn()
    render(<HostProtectionPanel mode="configure" platform="windows" onTakeover={onTakeover} />)

    fireEvent.click(screen.getByRole('button', { name: /不改/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认并接管/ }))

    expect(screen.getByRole('dialog', { name: '确认保留真实时区' })).toBeInTheDocument()
    expect(onTakeover).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '接受风险并继续' }))

    expect(onTakeover).toHaveBeenCalledWith(expect.objectContaining({ timezoneStrategy: 'unchanged', blockWebRTC: true, blockGeolocation: true }))
  })

  it('only exposes timezone controls and forces the remaining protection baseline', () => {
    const onTakeover = vi.fn()
    render(<HostProtectionPanel mode="configure" platform="windows" onTakeover={onTakeover} />)

    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('屏蔽 WebRTC')).toBeNull()
    expect(screen.queryByText('关闭浏览器定位')).toBeNull()
    expect(screen.queryByText('DNS 缓存清理')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /确认并接管/ }))
    expect(onTakeover).toHaveBeenCalledWith(expect.objectContaining({ blockWebRTC: true, blockGeolocation: true }))
  })

  it('explains macOS authorization before starting the takeover', () => {
    const onTakeover = vi.fn()
    render(<HostProtectionPanel mode="configure" platform="macos" onTakeover={onTakeover} />)

    fireEvent.click(screen.getByRole('button', { name: /确认并接管/ }))

    expect(screen.getByRole('dialog', { name: '需要一次管理员授权' })).toBeInTheDocument()
    expect(onTakeover).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /继续并唤起系统密码框/ }))
    expect(onTakeover).toHaveBeenCalledWith(expect.objectContaining({ timezoneStrategy: 'follow' }))
  })

  it('shows a verified restored state before returning to configuration', () => {
    const onContinue = vi.fn()
    render(<HostProtectionPanel mode="restored" platform="windows" originalTimezone="Asia/Shanghai" onContinue={onContinue} />)

    expect(screen.getByText('宿主环境已完整还原')).toBeInTheDocument()
    expect(screen.getByText(/本机没有遗留接管设置/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /返回接管配置/ }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('keeps individual stop controls for each active Claude target', () => {
    const onStopTarget = vi.fn()
    render(<HostProtectionPanel mode="active" platform="windows" runtimeStatus={{ targets: ['claude', 'claude_desktop'] }} onStopTarget={onStopTarget} />)

    fireEvent.click(screen.getByRole('button', { name: '仅停止 Claude Desktop' }))
    expect(onStopTarget).toHaveBeenCalledWith('claude_desktop')
    expect(screen.getByRole('button', { name: '仅停止 Claude Code' })).toBeInTheDocument()
  })
})
