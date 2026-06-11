import { describe, expect, it } from 'vitest'

import { selectFreshTransient } from './toast-select'

const n = (level: string, dedupKey: string) => ({ level, dedupKey, message: dedupKey })

describe('selectFreshTransient', () => {
  it('returns transient notifications not yet shown, and remembers them', () => {
    const { fresh, nextShown } = selectFreshTransient(
      [n('transient', 'a'), n('block', 'b'), n('transient', 'c')],
      new Set<string>(),
    )
    expect(fresh.map((f) => f.dedupKey)).toEqual(['a', 'c']) // block excluded
    expect(nextShown.has('a') && nextShown.has('c')).toBe(true)
  })

  it('does not re-emit a notification already shown while it persists', () => {
    const { fresh } = selectFreshTransient([n('transient', 'a')], new Set(['a']))
    expect(fresh).toEqual([])
  })

  it('forgets a shown key once its notification clears, so it can toast again later', () => {
    // 'a' was shown but is gone now → dropped from shown
    const { nextShown } = selectFreshTransient([n('transient', 'b')], new Set(['a']))
    expect(nextShown.has('a')).toBe(false)
    // a fresh 'a' later would toast again
    const second = selectFreshTransient([n('transient', 'a')], nextShown)
    expect(second.fresh.map((f) => f.dedupKey)).toEqual(['a'])
  })
})
