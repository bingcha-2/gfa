import { describe, expect, it } from 'vitest'

import { visibleDefaultQuotaWindows } from './LocalAccountsTab'

describe('visibleDefaultQuotaWindows', () => {
  it('hides a missing Codex 5h window and keeps the weekly quota', () => {
    expect(visibleDefaultQuotaWindows('codex', -1, 72)).toEqual([
      { label: '本周', percent: 72 },
    ])
  })

  it('does not change the legacy fallback for other providers', () => {
    expect(visibleDefaultQuotaWindows('antigravity', -1, 72)).toEqual([
      { label: '5 小时', percent: -1 },
      { label: '本周', percent: 72 },
    ])
  })
})
