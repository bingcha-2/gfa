import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiMocks, store } = vi.hoisted(() => ({
  apiMocks: {
    getDetectedPaths: vi.fn(),
    browseForPath: vi.fn(),
    checkForUpdate: vi.fn(),
    openURL: vi.fn(),
  },
  store: {
    state: {
      config: {
        accountCard: '',
        deviceId: 'device',
        proxyPort: 48800,
        idePath: '',
        hubPath: '',
        codexAppPath: '',
        claudeDesktopPath: '',
      },
      appVersion: '9.6.5',
      updateStatus: null,
    },
    saveConfig: vi.fn(),
    fetchIDEStatus: vi.fn(),
  },
}))

vi.mock('@/services/wails', () => ({
  getDetectedPaths: apiMocks.getDetectedPaths,
  browseForPath: apiMocks.browseForPath,
  checkForUpdate: apiMocks.checkForUpdate,
  openURL: apiMocks.openURL,
}))

vi.mock('@/stores/useAppStore', () => {
  const useAppStore = () => store.state
  useAppStore.getState = () => ({
    saveConfig: store.saveConfig,
    fetchIDEStatus: store.fetchIDEStatus,
  })
  return { useAppStore }
})

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
  useLocaleStore: (selector: (state: { locale: string; setLocale: () => void }) => unknown) =>
    selector({ locale: 'zh-CN', setLocale: vi.fn() }),
  SUPPORTED_LOCALES: [],
  LOCALE_NAMES: {},
}))

vi.mock('@/components/PromoSection', () => ({ PromoSection: () => null }))
vi.mock('@/components/GitHubIcon', () => ({ GitHubIcon: () => null }))
vi.mock('@/lib/changelog', () => ({ getChangelogRecord: () => null }))

import { SettingsPage } from './SettingsPage'

describe('SettingsPage install paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getDetectedPaths.mockResolvedValue({
      idePath: '',
      hubPath: '',
      codexAppPath: '',
      claudeDesktopPath: '',
    })
    store.saveConfig.mockResolvedValue(undefined)
    store.fetchIDEStatus.mockResolvedValue([])
  })

  it('allows typing and saving a Codex executable path', async () => {
    render(<SettingsPage />)

    await waitFor(() => expect(apiMocks.getDetectedPaths).toHaveBeenCalled())
    const codexInput = screen.getAllByRole('textbox')[2]
    expect(codexInput).not.toHaveAttribute('readonly')

    const path = String.raw`C:\Users\tester\AppData\Local\OpenAI\Codex\bin\hash\codex.exe`
    fireEvent.change(codexInput, { target: { value: path } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.savePaths' }))

    await waitFor(() => {
      expect(store.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ codexAppPath: path }))
    })
  })
})
