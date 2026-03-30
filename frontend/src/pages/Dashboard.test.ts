import { beforeEach, describe, expect, it } from 'vitest'
import {
  DASHBOARD_CACHE_VERSION,
  DASHBOARD_DATA_CACHE_STORAGE_KEY,
  DASHBOARD_HISTORY_RANGE_STORAGE_KEY,
  downsampleChartData,
  extendFrozenDayChartDataToNow,
  getDashboardDataCacheKey,
  getDashboardHistoryCacheKey,
  getStoredHistoryRange,
  isHistoryPointInCurrentDay,
  readDashboardDataCache,
  readDashboardHistoryCache,
  shouldAutoRefreshDashboard,
} from './Dashboard'

function createValidDashboardDataCache() {
  return {
    version: DASHBOARD_CACHE_VERSION,
    cachedAt: Date.now(),
    totalRemainingDividends: 1,
    summary: {
      total_value: 100,
      total_value_partial: false,
      total_cost: 90,
      total_cost_partial: false,
      total_gain_loss: 10,
      total_gain_loss_partial: false,
      total_gain_loss_percent: 11.11,
      daily_change: 1,
      daily_change_partial: false,
      dividend_yield: 2,
      dividend_yield_partial: false,
      last_updated: '2026-03-22T00:00:00Z',
      display_currency: 'SEK',
      stocks: [],
      stock_count: 0,
      auto_refresh_active: true,
    },
    upcomingDividends: [],
  }
}

describe('dashboard storage helpers', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('prefers the user-specific history range over the legacy value', () => {
    localStorage.setItem(DASHBOARD_HISTORY_RANGE_STORAGE_KEY, '1W')
    localStorage.setItem(`${DASHBOARD_HISTORY_RANGE_STORAGE_KEY}:7`, '1Y')

    expect(getStoredHistoryRange(7)).toBe('1Y')
  })

  it('falls back to the legacy history range when no user-specific value exists', () => {
    localStorage.setItem(DASHBOARD_HISTORY_RANGE_STORAGE_KEY, 'YTD')

    expect(getStoredHistoryRange(7)).toBe('YTD')
  })

  it('falls back to the legacy history range when the user-specific value is invalid', () => {
    localStorage.setItem(DASHBOARD_HISTORY_RANGE_STORAGE_KEY, '1W')
    localStorage.setItem(`${DASHBOARD_HISTORY_RANGE_STORAGE_KEY}:7`, 'BAD_RANGE')

    expect(getStoredHistoryRange(7)).toBe('1W')
  })

  it('uses the legacy history range when userId is null or undefined', () => {
    localStorage.setItem(DASHBOARD_HISTORY_RANGE_STORAGE_KEY, 'YTD')

    expect(getStoredHistoryRange(null)).toBe('YTD')
    expect(getStoredHistoryRange(undefined)).toBe('YTD')
  })

  it('returns the default history range when storage is empty', () => {
    expect(getStoredHistoryRange(null)).toBe('1M')
    expect(getStoredHistoryRange(undefined)).toBe('1M')
  })

  it('returns null for invalid dashboard data cache payloads', () => {
    const cacheKey = getDashboardDataCacheKey(7)
    localStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION,
      cachedAt: Date.now(),
      totalRemainingDividends: 1,
      summary: { total_value: 'bad' },
      upcomingDividends: [],
    }))

    expect(readDashboardDataCache(7)).toBeNull()
    expect(localStorage.getItem(cacheKey)).toBeNull()
  })

  it('returns null for wrong cache versions', () => {
    const cacheKey = getDashboardDataCacheKey(7)
    localStorage.setItem(cacheKey, JSON.stringify({
      ...createValidDashboardDataCache(),
      version: DASHBOARD_CACHE_VERSION + 1,
    }))

    expect(readDashboardDataCache(7)).toBeNull()
    expect(localStorage.getItem(cacheKey)).toBeNull()
  })

  it('reads a valid dashboard data cache payload', () => {
    localStorage.setItem(`${DASHBOARD_DATA_CACHE_STORAGE_KEY}:7`, JSON.stringify(createValidDashboardDataCache()))

    expect(readDashboardDataCache(7)?.summary.total_value).toBe(100)
  })

  it('rejects non-finite numeric dashboard cache values', () => {
    const cacheKey = getDashboardDataCacheKey(7)
    localStorage.setItem(cacheKey, JSON.stringify({
      ...createValidDashboardDataCache(),
      totalRemainingDividends: Number.POSITIVE_INFINITY,
    }))

    expect(readDashboardDataCache(7)).toBeNull()
    expect(localStorage.getItem(cacheKey)).toBeNull()
  })

  it('rejects invalid history cache entries', () => {
    const cacheKey = getDashboardHistoryCacheKey('1M', 7)
    localStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION,
      cachedAt: Date.now(),
      history: [{ date: '2026-03-22', value: 'bad' }],
    }))

    expect(readDashboardHistoryCache('1M', 7)).toBeNull()
    expect(localStorage.getItem(cacheKey)).toBeNull()
  })

  it('rejects wrong history cache versions', () => {
    const cacheKey = getDashboardHistoryCacheKey('1M', 7)
    localStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION + 1,
      cachedAt: Date.now(),
      history: [{ date: '2026-03-22', value: 100 }],
    }))

    expect(readDashboardHistoryCache('1M', 7)).toBeNull()
    expect(localStorage.getItem(cacheKey)).toBeNull()
  })

  it('reads a valid history cache payload', () => {
    const cacheKey = getDashboardHistoryCacheKey('1M', 7)
    localStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION,
      cachedAt: Date.now(),
      history: [
        { date: '2026-03-21', value: 95 },
        { date: '2026-03-22', value: 100 },
      ],
    }))

    expect(readDashboardHistoryCache('1M', 7)).toEqual({
      cachedAt: expect.any(Number),
      history: [
        { date: '2026-03-21', value: 95 },
        { date: '2026-03-22', value: 100 },
      ],
    })
  })

  it('returns the first point when downsampling to one point', () => {
    expect(downsampleChartData([
      { date: '2026-03-20', value: 1 },
      { date: '2026-03-21', value: 2 },
      { date: '2026-03-22', value: 3 },
    ], 1)).toEqual([{ date: '2026-03-20', value: 1 }])
  })

  it('returns the original array when no downsampling is needed', () => {
    const data = [
      { date: '2026-03-20', value: 1 },
      { date: '2026-03-21', value: 2 },
    ]

    expect(downsampleChartData(data, 2)).toBe(data)
  })

  it('returns an empty array when downsampling empty input', () => {
    expect(downsampleChartData([], 5)).toEqual([])
  })

  it('downsamples by keeping the first, last, and evenly sampled middle points', () => {
    expect(downsampleChartData([
      { date: '2026-03-20', value: 10 },
      { date: '2026-03-21', value: 20 },
      { date: '2026-03-22', value: 30 },
      { date: '2026-03-23', value: 40 },
      { date: '2026-03-24', value: 50 },
    ], 3)).toEqual([
      { date: '2026-03-20', value: 10 },
      { date: '2026-03-22', value: 30 },
      { date: '2026-03-24', value: 50 },
    ])
  })

  it('treats 1D history as the current calendar day in the selected timezone', () => {
    const now = new Date('2026-03-26T08:00:00Z')

    expect(isHistoryPointInCurrentDay('2026-03-25T23:30:00Z', 'Europe/Stockholm', now)).toBe(true)
    expect(isHistoryPointInCurrentDay('2026-03-25T22:30:00Z', 'Europe/Stockholm', now)).toBe(false)
  })

  it('extends frozen 1D chart data with a flat point at the current time', () => {
    expect(extendFrozenDayChartDataToNow([
      { date: '2026-03-26T15:30:00Z', value: 100 },
      { date: '2026-03-26T16:30:00Z', value: 125 },
    ], true, new Date('2026-03-26T18:00:00Z'))).toEqual([
      { date: '2026-03-26T15:30:00Z', value: 100 },
      { date: '2026-03-26T16:30:00Z', value: 125 },
      { date: '2026-03-26T18:00:00.000Z', value: 125 },
    ])
  })

  it('does not extend chart data when live refresh should remain active', () => {
    const data = [
      { date: '2026-03-26T15:30:00Z', value: 100 },
      { date: '2026-03-26T16:30:00Z', value: 125 },
    ]

    expect(extendFrozenDayChartDataToNow(data, false, new Date('2026-03-26T18:00:00Z'))).toBe(data)
  })

  it('uses the backend-provided auto-refresh flag when active', () => {
    expect(shouldAutoRefreshDashboard({ auto_refresh_active: true })).toBe(true)
  })

  it('uses the backend-provided auto-refresh flag when inactive', () => {
    expect(shouldAutoRefreshDashboard({ auto_refresh_active: false })).toBe(false)
  })

  it('defaults to active when summary data is unavailable', () => {
    expect(shouldAutoRefreshDashboard(null)).toBe(true)
  })
})
