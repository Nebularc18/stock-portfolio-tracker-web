import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_STORAGE_KEY,
  __resetPortfolioRequestCachesForTests,
  api,
  getRequestUserCacheScope,
} from './api'

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createJsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createSummaryPayload() {
  return {
    total_value: 100,
    total_value_partial: false,
    total_cost: 90,
    total_cost_partial: false,
    total_gain_loss: 10,
    total_gain_loss_partial: false,
    total_gain_loss_percent: 11.11,
    daily_change: 1,
    daily_change_percent: 1.01,
    daily_change_partial: false,
    dividend_yield: 2,
    dividend_yield_partial: false,
    last_updated: '2026-03-22T00:00:00Z',
    display_currency: 'SEK',
    stocks: [],
    stock_count: 0,
    auto_refresh_active: true,
  }
}

describe('getRequestUserCacheScope', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    __resetPortfolioRequestCachesForTests()
  })

  it('maps null to guest', () => {
    expect(getRequestUserCacheScope(null)).toBe('guest')
  })

  it('uses explicit numeric ids including 0', () => {
    expect(getRequestUserCacheScope(42)).toBe('42')
    expect(getRequestUserCacheScope(0)).toBe('0')
  })

  it('falls back to the stored auth user when userId is undefined', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      id: 13,
      username: 'demo',
      is_guest: false,
      token: 'token',
    }))

    expect(getRequestUserCacheScope(undefined)).toBe('13')
  })

  it('returns guest when userId is undefined and auth storage is empty', () => {
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(getRequestUserCacheScope(undefined)).toBe('guest')
  })
})

describe('portfolio request caching', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    __resetPortfolioRequestCachesForTests()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deduplicates summary requests by user id when no signal is provided', async () => {
    const deferred = createDeferred<Response>()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(deferred.promise)

    const first = api.portfolio.summary(7)
    const second = api.portfolio.summary(7)

    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    deferred.resolve(createJsonResponse(createSummaryPayload()))
    await Promise.all([first, second])
  })

  it('bypasses summary deduplication when a signal is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse(createSummaryPayload()))
      .mockResolvedValueOnce(createJsonResponse(createSummaryPayload()))

    const first = api.portfolio.summary(7, { signal: new AbortController().signal })
    const second = api.portfolio.summary(7, { signal: new AbortController().signal })

    expect(first).not.toBe(second)
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates history by the full user+query key and keeps users isolated', async () => {
    const deferredOne = createDeferred<Response>()
    const deferredTwo = createDeferred<Response>()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(deferredOne.promise)
      .mockReturnValueOnce(deferredTwo.promise)

    const first = api.portfolio.history({ range: '1m' }, 7)
    const second = api.portfolio.history({ range: '1m' }, 7)
    const third = api.portfolio.history({ range: '1m' }, 8)

    expect(first).toBe(second)
    expect(third).not.toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    deferredOne.resolve(createJsonResponse([{ date: '2026-03-22', value: 100 }]))
    deferredTwo.resolve(createJsonResponse([{ date: '2026-03-22', value: 200 }]))
    await Promise.all([first, second, third])
  })

  it('supports numeric history options and reuses the resolved value cache', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse([{ date: '2026-03-22', value: 100 }]))

    const first = await api.portfolio.history(30, 7)
    const second = await api.portfolio.history(30, 7)

    expect(first).toEqual([{ date: '2026-03-22', value: 100 }])
    expect(second).toEqual([{ date: '2026-03-22', value: 100 }])
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/portfolio/history?days=30',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bypasses history deduplication when a signal is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse([{ date: '2026-03-22', value: 100 }]))
      .mockResolvedValueOnce(createJsonResponse([{ date: '2026-03-22', value: 100 }]))

    const first = api.portfolio.history({ range: '1m' }, 7, { signal: new AbortController().signal })
    const second = api.portfolio.history({ range: '1m' }, 7, { signal: new AbortController().signal })

    expect(first).not.toBe(second)
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates upcoming dividend requests by user id', async () => {
    const deferred = createDeferred<Response>()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(deferred.promise)

    const first = api.portfolio.upcomingDividends(5)
    const second = api.portfolio.upcomingDividends(5)

    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    deferred.resolve(createJsonResponse({
      dividends: [],
      total_expected: 0,
      total_received: 0,
      total_remaining: 0,
      totals_partial: false,
      dividends_partial: false,
      skipped_dividend_count: 0,
      skipped_dividend_ids: [],
      display_currency: 'SEK',
      unmapped_stocks: [],
    }))
    await Promise.all([first, second])
  })

  it('reuses the resolved summary value cache after resolution', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse(createSummaryPayload()))

    await api.portfolio.summary(7)
    await api.portfolio.summary(7)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bypasses upcoming dividend deduplication when a signal is provided', async () => {
    const payload = {
      dividends: [],
      total_expected: 0,
      total_received: 0,
      total_remaining: 0,
      totals_partial: false,
      dividends_partial: false,
      skipped_dividend_count: 0,
      skipped_dividend_ids: [],
      display_currency: 'SEK',
      unmapped_stocks: [],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(createJsonResponse(payload))
      .mockResolvedValueOnce(createJsonResponse(payload))

    const first = api.portfolio.upcomingDividends(5, { signal: new AbortController().signal })
    const second = api.portfolio.upcomingDividends(5, { signal: new AbortController().signal })

    expect(first).not.toBe(second)
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
