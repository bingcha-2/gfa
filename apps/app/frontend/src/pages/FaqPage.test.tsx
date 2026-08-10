import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    getFaqData: vi.fn(),
    openURL: vi.fn(),
  },
}))

vi.mock('@/services/wails', () => ({
  getFaqData: apiMocks.getFaqData,
  openURL: apiMocks.openURL,
  PORTAL_URLS: {
    home: 'https://my.bcai.lol/account',
    support: 'https://my.bcai.lol/account/support',
  },
  SITE_URLS: {
    faq: 'https://bcai.lol/faq',
  },
}))

import { FaqPage } from './FaqPage'

describe('FaqPage support entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    apiMocks.getFaqData.mockResolvedValue({ items: [], settings: {} })
  })

  it('opens the standalone account support page from the guide banner', async () => {
    render(<FaqPage />)

    const cta = screen.getByRole('button', { name: /立即咨询|support/i })
    fireEvent.click(cta)

    await waitFor(() => {
      expect(apiMocks.openURL).toHaveBeenCalledWith('https://my.bcai.lol/account/support')
    })
  })

  it('shows the configured human support name and WeChat id', async () => {
    apiMocks.getFaqData.mockResolvedValue({
      items: [],
      settings: { contact_name: 'Mr. 淦', contact_wechat: '18339526286' },
    })

    render(<FaqPage />)

    expect(await screen.findByText('Mr. 淦')).toBeInTheDocument()
    expect(screen.getByText(/18339526286/)).toBeInTheDocument()
  })

  it('discards the legacy cache so the previous contact is never rendered', async () => {
    localStorage.setItem('bcai_faq_cache', JSON.stringify({
      items: [],
      settings: { contact_name: '阿厌', contact_wechat: 'myapple233' },
      ts: Date.now(),
    }))

    render(<FaqPage />)

    await waitFor(() => expect(apiMocks.getFaqData).toHaveBeenCalled())
    expect(localStorage.getItem('bcai_faq_cache')).toBeNull()
    expect(screen.queryByText('阿厌')).not.toBeInTheDocument()
    expect(screen.queryByText(/myapple233/)).not.toBeInTheDocument()
  })
})
