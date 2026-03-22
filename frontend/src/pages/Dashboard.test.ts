import { beforeEach, describe, expect, it } from 'vitest'
import {
  DASHBOARD_CACHE_VERSION,
  DASHBOARD_DATA_CACHE_STORAGE_KEY,
  DASHBOARD_HISTORY_RANGE_STORAGE_KEY,
  downsampleChartData,
  getDashboardDataCacheKey,
  getDashboardHistoryCacheKey,
  getStoredHistoryRange,
  readDashboardDataCache,
  readDashboardHistoryCache,
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

  it('returns null for invalid dashboard data cache payloads', () => {
    const cacheKey = getDashboardDataCacheKey(7)
    sessionStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION,
      cachedAt: Date.now(),
      totalRemainingDividends: 1,
      summary: { total_value: 'bad' },
      upcomingDividends: [],
    }))

    expect(readDashboardDataCache(7)).toBeNull()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it('returns null for wrong cache versions', () => {
    const cacheKey = getDashboardDataCacheKey(7)
    sessionStorage.setItem(cacheKey, JSON.stringify({
      ...createValidDashboardDataCache(),
      version: DASHBOARD_CACHE_VERSION + 1,
    }))

    expect(readDashboardDataCache(7)).toBeNull()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it('reads a valid dashboard data cache payload', () => {
    sessionStorage.setItem(`${DASHBOARD_DATA_CACHE_STORAGE_KEY}:7`, JSON.stringify(createValidDashboardDataCache()))

    expect(readDashboardDataCache(7)?.summary.total_value).toBe(100)
  })

  it('rejects non-finite numeric dashboard cache values', () => {
    const cacheKey = getDashboardDataCacheKey(7)
    sessionStorage.setItem(cacheKey, JSON.stringify({
      ...createValidDashboardDataCache(),
      totalRemainingDividends: Number.POSITIVE_INFINITY,
    }))

    expect(readDashboardDataCache(7)).toBeNull()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it('rejects invalid history cache entries', () => {
    const cacheKey = getDashboardHistoryCacheKey('1M', 7)
    sessionStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION,
      cachedAt: Date.now(),
      history: [{ date: '2026-03-22', value: 'bad' }],
    }))

    expect(readDashboardHistoryCache('1M', 7)).toBeNull()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it('rejects wrong history cache versions', () => {
    const cacheKey = getDashboardHistoryCacheKey('1M', 7)
    sessionStorage.setItem(cacheKey, JSON.stringify({
      version: DASHBOARD_CACHE_VERSION + 1,
      cachedAt: Date.now(),
      history: [{ date: '2026-03-22', value: 100 }],
    }))

    expect(readDashboardHistoryCache('1M', 7)).toBeNull()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it('returns the first point when downsampling to one point', () => {
    expect(downsampleChartData([
      { date: '2026-03-20', value: 1 },
      { date: '2026-03-21', value: 2 },
      { date: '2026-03-22', value: 3 },
    ], 1)).toEqual([{ date: '2026-03-20', value: 1 }])
  })
})
