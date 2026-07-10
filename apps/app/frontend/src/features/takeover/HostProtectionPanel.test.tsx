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

  it('shows the live system timezone alongside the takeover target when active', () => {
    render(
      <HostProtectionPanel
        mode="active"
        platform="windows"
        runtimeStatus={{ appliedTimezone: 'America/Chicago', currentSystemTimezone: 'America/Chicago', timezoneMatch: 'aligned' }}
      />,
    )
    expect(screen.getByText('接管目标')).toBeInTheDocument()
    expect(screen.getByText('系统当前')).toBeInTheDocument()
    expect(screen.getByText('已核实一致')).toBeInTheDocument()
  })

  it('surfaces a drift warning when the live system timezone diverges from the target', () => {
    render(
      <HostProtectionPanel
        mode="active"
        platform="macos"
        runtimeStatus={{ appliedTimezone: 'America/Chicago', currentSystemTimezone: 'Asia/Shanghai', timezoneMatch: 'drift' }}
      />,
    )
    expect(screen.getByText('不一致')).toBeInTheDocument()
    expect(screen.getByText(/时区对齐可能未生效或被外部改动/)).toBeInTheDocument()
  })

  it('shows machine-level real-browser coverage when active', () => {
    render(
      <HostProtectionPanel
        mode="active"
        platform="macos"
        runtimeStatus={{ appliedTimezone: 'Asia/Singapore', currentSystemTimezone: 'Asia/Singapore', timezoneMatch: 'aligned', protectedBrowsers: 'chrome×2 edge×1' }}
      />,
    )
    expect(screen.getByText('真实浏览器')).toBeInTheDocument()
    expect(screen.getByText('chrome×2 edge×1')).toBeInTheDocument()
    expect(screen.getByText('已防护')).toBeInTheDocument()
  })

  it('requires a Linux authorization step (pkexec) before changing the timezone', () => {
    const onTakeover = vi.fn()
    render(<HostProtectionPanel mode="configure" platform="linux" onTakeover={onTakeover} />)

    fireEvent.click(screen.getByRole('button', { name: /确认并接管/ }))
    expect(onTakeover).not.toHaveBeenCalled() // 弹授权,不直接接管
    expect(screen.getByText(/Linux 需要授权/)).toBeInTheDocument()
  })

  it('explains the Windows timezone collapse without treating it as an error', () => {
    render(
      <HostProtectionPanel
        mode="active"
        platform="windows"
        runtimeStatus={{ appliedTimezone: 'America/Winnipeg', currentSystemTimezone: 'America/Chicago', timezoneMatch: 'collapsed' }}
      />,
    )
    expect(screen.getByText('系统档 · Windows')).toBeInTheDocument()
    expect(screen.getByText(/保持城市级精度/)).toBeInTheDocument()
  })
})
