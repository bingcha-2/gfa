import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePolling } from './usePolling'
afterEach(() => vi.useRealTimers())
it('does not restart an obsolete polling chain after toggling enabled', async () => {
 vi.useFakeTimers()
 let finish!: () => void
 const fn = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
 const { rerender, unmount } = renderHook(({ enabled }) => usePolling(fn, 1000, enabled), { initialProps: { enabled: true } })
 rerender({ enabled: false }); rerender({ enabled: true })
 await act(async () => { finish(); await Promise.resolve() })
 expect(fn).toHaveBeenCalledTimes(2)
 await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
 expect(fn).toHaveBeenCalledTimes(3)
 unmount()
 expect(vi.getTimerCount()).toBe(0)
})
