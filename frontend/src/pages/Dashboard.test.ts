import { beforeEach, describe, expect, it } from 'vitest'
import {
  DASHBOARD_AUTO_REFRESH_INTERVAL_MS,
  DASHBOARD_CACHE_VERSION,
  DASHBOARD_DATA_CACHE_STORAGE_KEY,
  DASHBOARD_HISTORY_RANGE_STORAGE_KEY,
  compressChartDataTime,
  downsampleChartData,
  freezeDayChartDataAtLastPoint,
  getDashboardDataCacheKey,
  getDashboardHistoryCacheKey,
  getDashboardRefreshBucketMs,
  getLatestDashboardHistoryTimeMs,
  getNextDashboardRefreshDelayMs,
  getPreviousCloseBaselineValue,
  getStoredHistoryRange,
  isHistoryPointInCurrentDay,
  prependDailyBaselinePoint,
  readDashboardDataCache,
  readDashboardHistoryCache,
  shouldAutoRefreshDashboard,
  shouldRetryDashboardRefresh,
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
      daily_change_percent: 1.01,
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

  it('leaves frozen 1D chart data bounded to actual data points', () => {
    expect(freezeDayChartDataAtLastPoint([
      { date: '2026-03-26T15:30:00Z', value: 100 },
      { date: '2026-03-26T16:30:00Z', value: 125 },
    ], true)).toEqual([
      { date: '2026-03-26T15:30:00Z', value: 100 },
      { date: '2026-03-26T16:30:00Z', value: 125 },
    ])
  })

  it('compresses chart x-values to remove closed-market gaps', () => {
    expect(compressChartDataTime([
      { date: '2026-04-20T07:00:00Z', value: 110, xValue: Date.parse('2026-04-20T07:00:00Z') },
      { date: '2026-04-17T19:50:00Z', value: 100, xValue: Date.parse('2026-04-17T19:50:00Z') },
    ])).toEqual([
      { date: '2026-04-17T19:50:00Z', value: 100, xValue: 0 },
      { date: '2026-04-20T07:00:00Z', value: 110, xValue: 1 },
    ])
  })

  it('does not extend chart data when live refresh should remain active', () => {
    const data = [
      { date: '2026-03-26T15:30:00Z', value: 100 },
      { date: '2026-03-26T16:30:00Z', value: 125 },
    ]

    expect(freezeDayChartDataAtLastPoint(data, false)).toBe(data)
  })

  it('derives the previous-close baseline from total value and daily change', () => {
    expect(getPreviousCloseBaselineValue({
      total_value: 200_630.98,
      daily_change: -3.03,
      daily_change_partial: false,
    })).toBeCloseTo(200_634.01)
  })

  it('does not derive a previous-close baseline from partial daily change data', () => {
    expect(getPreviousCloseBaselineValue({
      total_value: 200_630.98,
      daily_change: -3.03,
      daily_change_partial: true,
    })).toBeNull()
  })

  it('prepends the previous-close baseline to 1D chart data', () => {
    expect(prependDailyBaselinePoint([
      { date: '2026-04-13T07:00:00Z', value: 198_511.41 },
      { date: '2026-04-13T18:30:00Z', value: 200_630.98 },
    ], 200_634.01, '1D')).toEqual([
      {
        date: '2026-04-13T06:59:59.000Z',
        value: 200_634.01,
        isBaseline: true,
        displayDate: '2026-04-13T07:00:00Z',
      },
      { date: '2026-04-13T07:00:00Z', value: 198_511.41 },
      { date: '2026-04-13T18:30:00Z', value: 200_630.98 },
    ])
  })

  it('leaves non-1D chart data unchanged when applying the daily baseline', () => {
    const data = [
      { date: '2026-04-12T18:30:00Z', value: 199_000 },
      { date: '2026-04-13T18:30:00Z', value: 200_630.98 },
    ]

    expect(prependDailyBaselinePoint(data, 200_634.01, '1W')).toBe(data)
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

  it('keeps dashboard graph refresh aligned to the 10-minute stock refresh cadence', () => {
    expect(DASHBOARD_AUTO_REFRESH_INTERVAL_MS).toBe(10 * 60 * 1000)
    expect(getNextDashboardRefreshDelayMs(Date.parse('2026-03-26T08:01:00Z'))).toBe(9 * 60 * 1000 + 5_000)
    expect(getNextDashboardRefreshDelayMs(Date.parse('2026-03-26T08:10:00Z'))).toBe(5_000)
  })

  it('maps dashboard auto-refresh checks to the current 10-minute bucket', () => {
    expect(getDashboardRefreshBucketMs(Date.parse('2026-03-26T08:19:30Z'))).toBe(Date.parse('2026-03-26T08:10:00Z'))
    expect(getDashboardRefreshBucketMs(Date.parse('2026-03-26T08:20:00Z'))).toBe(Date.parse('2026-03-26T08:20:00Z'))
  })

  it('retries dashboard auto-refresh until the current scheduler bucket is present', () => {
    const now = Date.parse('2026-03-26T08:20:05Z')

    expect(shouldRetryDashboardRefresh([
      { date: '2026-03-26T08:10:00Z', value: 100 },
    ], now)).toBe(true)

    expect(shouldRetryDashboardRefresh([
      { date: '2026-03-26T08:10:00Z', value: 100 },
      { date: '2026-03-26T08:20:00Z', value: 101 },
    ], now)).toBe(false)
  })

  it('retries dashboard auto-refresh when history is empty', () => {
    expect(shouldRetryDashboardRefresh([], Date.parse('2026-03-26T08:20:05Z'))).toBe(true)
  })

  it('finds the latest dashboard history timestamp', () => {
    expect(getLatestDashboardHistoryTimeMs([
      { date: '2026-03-26T08:20:00Z', value: 101 },
      { date: 'not-a-date', value: 0 },
      { date: '2026-03-26T08:10:00Z', value: 100 },
    ])).toBe(Date.parse('2026-03-26T08:20:00Z'))
  })

  it('ignores dashboard history entries with non-string dates', () => {
    expect(getLatestDashboardHistoryTimeMs([
      { date: 123, value: 999 },
      { value: 200 },
      null,
      { date: '2026-03-26T08:20:00Z', value: 101 },
    ])).toBe(Date.parse('2026-03-26T08:20:00Z'))
  })
})
