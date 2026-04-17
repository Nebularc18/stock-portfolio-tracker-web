import { describe, expect, it } from 'vitest'
import { buildDividendComparisonEvents } from './Analytics'
import { DividendsByTicker, Stock, UpcomingDividend } from '../services/api'

function createStock(overrides: Partial<Stock> = {}): Stock {
  return {
    id: 1,
    ticker: 'ABC.ST',
    name: 'ABC',
    quantity: 10,
    currency: 'SEK',
    sector: null,
    logo: null,
    purchase_price: null,
    purchase_date: null,
    position_entries: [],
    current_price: null,
    previous_close: null,
    dividend_yield: null,
    dividend_per_share: null,
    last_updated: null,
    manual_dividends: [],
    ...overrides,
  }
}

function createUpcomingDividend(overrides: Partial<UpcomingDividend> = {}): UpcomingDividend {
  return {
    ticker: 'ABC.ST',
    name: 'ABC',
    quantity: 10,
    ex_date: '2026-04-10',
    payment_date: '2026-04-18',
    status: 'upcoming',
    dividend_type: null,
    amount_per_share: 5,
    total_amount: 50,
    currency: 'SEK',
    total_converted: 50,
    display_currency: 'SEK',
    source: 'avanza',
    ...overrides,
  }
}

describe('buildDividendComparisonEvents', () => {
  it('uses portfolio current-year dividends instead of historical current-year rows', () => {
    const stocks = [createStock()]
    const dividendsByTicker: DividendsByTicker = {
      'ABC.ST': [
        { date: '2026-03-20', amount: 1, currency: 'SEK', payment_date: '2026-03-28' },
        { date: '2025-08-20', amount: 2, currency: 'SEK', payment_date: '2025-08-28' },
      ],
    }

    const events = buildDividendComparisonEvents(
      stocks,
      dividendsByTicker,
      [
        createUpcomingDividend({ ex_date: '2026-04-10', payment_date: '2026-04-18', total_converted: 50 }),
        createUpcomingDividend({ ex_date: '2026-08-10', payment_date: '2026-08-18', total_converted: 75 }),
      ],
      'SEK',
      {},
      2026,
    )

    expect(events).toEqual([
      { year: 2025, monthIndex: 7, value: 20 },
      { year: 2026, monthIndex: 3, value: 50 },
      { year: 2026, monthIndex: 7, value: 75 },
    ])
  })

  it('falls back to historical current-year dividends when portfolio current-year data is unavailable', () => {
    const stocks = [createStock()]
    const dividendsByTicker: DividendsByTicker = {
      'ABC.ST': [
        { date: '2026-03-20', amount: 1, currency: 'SEK', payment_date: '2026-03-28' },
      ],
    }

    const events = buildDividendComparisonEvents(
      stocks,
      dividendsByTicker,
      null,
      'SEK',
      {},
      2026,
    )

    expect(events).toEqual([
      { year: 2026, monthIndex: 2, value: 10 },
    ])
  })
})
