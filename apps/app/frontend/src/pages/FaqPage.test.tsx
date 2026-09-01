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
})
