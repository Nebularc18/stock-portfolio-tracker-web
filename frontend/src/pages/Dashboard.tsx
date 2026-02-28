import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ResponsiveContainer, Tooltip, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts'
import { api, PortfolioSummary, Stock, UpcomingDividend } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'

function formatCurrency(value: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [upcomingDividends, setUpcomingDividends] = useState<UpcomingDividend[]>([])
  const [totalExpectedDividends, setTotalExpectedDividends] = useState(0)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [portfolioHistory, setPortfolioHistory] = useState<{ date: string; value: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { displayCurrency, timezone } = useSettings()

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [summaryData, stocksData, ratesData, historyData, upcomingDivsData] = await Promise.all([
        api.portfolio.summary(),
        api.stocks.list(),
        api.market.exchangeRates(),
        api.portfolio.history(90).catch(() => []),
        api.portfolio.upcomingDividends().catch(() => ({ dividends: [], total_expected: 0, display_currency: displayCurrency, unmapped_stocks: [] })),
      ])
      setSummary(summaryData)
      setStocks(stocksData)
      setExchangeRates(ratesData)
      setPortfolioHistory(historyData)
      setUpcomingDividends(upcomingDivsData.dividends)
      setTotalExpectedDividends(upcomingDivsData.total_expected)
      setError(null)
    } catch (err) {
      setError('Failed to load portfolio data')
    } finally {
      setLoading(false)
    }
  }, [displayCurrency])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const convertToCurrency = (amount: number, currency: string): number => {
    if (currency === displayCurrency) return amount
    const rate = exchangeRates[`${currency}_${displayCurrency}`]
    if (rate) return amount * rate
    const inverseRate = exchangeRates[`${displayCurrency}_${currency}`]
    if (inverseRate) return amount / inverseRate
    return amount
  }

  const dailyChangeConverted = stocks.reduce((total, stock) => {
    if (stock.current_price && stock.previous_close) {
      const change = (stock.current_price - stock.previous_close) * stock.quantity
      return total + convertToCurrency(change, stock.currency)
    }
    return total
  }, 0)

  const totalValueConverted = stocks.reduce((total, stock) => {
    const value = (stock.current_price || 0) * stock.quantity
    return total + convertToCurrency(value, stock.currency)
  }, 0)

  const lastUpdate = stocks.reduce((max: string | null, stock) => {
    if (!stock.last_updated) return max
    if (!max) return stock.last_updated
    return stock.last_updated > max ? stock.last_updated : max
  }, null)

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchData}>Retry</button>
      </div>
    )
  }

  const currency = summary?.display_currency || displayCurrency
  const gainLossClass = (summary?.total_gain_loss ?? 0) >= 0 ? 'positive' : 'negative'
  const dailyChangeClass = dailyChangeConverted >= 0 ? 'positive' : 'negative'

  const chartData = portfolioHistory.map(h => {
    const dateStr = h.date.includes('T') ? h.date.split('T')[0] : h.date
    const date = new Date(dateStr + 'T00:00:00Z')
    const convertedValue = convertToCurrency(h.value, 'SEK')
    return {
      date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      fullDate: date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      value: convertedValue
    }
  })

  const minValue = chartData.length > 0 ? Math.min(...chartData.map(h => h.value)) : 0
  const maxValue = chartData.length > 0 ? Math.max(...chartData.map(h => h.value)) : 0
  const valueRange = maxValue - minValue || 1
  const yMin = Math.max(0, minValue - valueRange * 0.1)
  const yMax = maxValue + valueRange * 0.1

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>Dashboard</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
          Last updated: {formatTimeInTimezone(lastUpdate, timezone)} · Auto-refresh every 10 min
        </p>
      </div>

      <div className="grid grid-4" style={{ marginBottom: '24px' }}>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>TOTAL VALUE ({currency})</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }}>
            {formatCurrency(totalValueConverted, currency)}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>DAILY CHANGE</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }} className={dailyChangeClass}>
            {formatCurrency(dailyChangeConverted, currency)}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>GAIN/LOSS</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }} className={gainLossClass}>
            {formatCurrency(summary?.total_gain_loss ?? 0, currency)}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>RETURN %</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }} className={gainLossClass}>
            {formatPercent(summary?.total_gain_loss_percent ?? 0)}
          </p>
        </div>
      </div>

      {portfolioHistory.length > 0 && (
        <div className="card" style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3>Portfolio Performance (90 days)</h3>
            <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <span>Low: {formatCurrency(minValue, currency)}</span>
              <span>High: {formatCurrency(maxValue, currency)}</span>
            </div>
          </div>
          <div style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis 
                  dataKey="date" 
                  stroke="#888" 
                  fontSize={11}
                  interval="preserveStartEnd"
                />
                <YAxis 
                  stroke="#888" 
                  fontSize={11}
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toFixed(0)}
                />
                <Tooltip 
                  formatter={(value: number) => [formatCurrency(value, currency), 'Portfolio Value']}
                  labelFormatter={(label, payload) => {
                    if (payload && payload[0]) {
                      return payload[0].payload.fullDate
                    }
                    return label
                  }}
                  contentStyle={{ 
                    background: '#2a2a2a', 
                    border: '1px solid #444', 
                    borderRadius: '8px', 
                    color: '#fff',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                  }}
                  itemStyle={{ color: '#fff' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="value" 
                  stroke="#6366f1" 
                  strokeWidth={2}
                  fillOpacity={1} 
                  fill="url(#colorValue)" 
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '16px' }}>Holdings ({summary?.stock_count ?? 0})</h3>
        
        {!summary?.stocks?.length ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
            No stocks in portfolio. Add stocks from the Stocks page.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Value ({currency})</th>
                <th>Gain/Loss</th>
                <th>Return %</th>
              </tr>
            </thead>
            <tbody>
              {summary?.stocks?.map((stock) => (
                <tr 
                  key={stock.ticker} 
                  onClick={() => navigate(`/stocks/${stock.ticker}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <Link 
                      to={`/stocks/${stock.ticker}`} 
                      style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {stock.ticker}
                    </Link>
                  </td>
                  <td>{stock.name || '-'}</td>
                  <td>{stock.quantity}</td>
                  <td>{formatCurrency(stock.current_price, stock.currency)}</td>
                  <td>{formatCurrency(stock.current_value, currency)}</td>
                  <td className={stock.gain_loss === null ? '' : (stock.gain_loss >= 0 ? 'positive' : 'negative')}>
                    {stock.gain_loss !== null ? formatCurrency(stock.gain_loss, currency) : '-'}
                  </td>
                  <td className={stock.gain_loss_percent === null ? '' : (stock.gain_loss_percent >= 0 ? 'positive' : 'negative')}>
                    {stock.gain_loss_percent !== null ? formatPercent(stock.gain_loss_percent) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
         )}
       </div>

      {upcomingDividends.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3>Upcoming Dividends</h3>
            <span style={{ color: 'var(--accent-green)', fontWeight: '600', fontSize: '18px' }}>
              {formatCurrency(totalExpectedDividends, currency)}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Ex-Date</th>
                <th>Per Share</th>
                <th>Total</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {upcomingDividends.slice(0, 5).map((div, i) => (
                <tr key={`${div.ticker}-${i}`}>
                  <td>
                    <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                      {div.ticker}
                    </Link>
                  </td>
                  <td>{formatDate(div.ex_date)}</td>
                  <td>{formatCurrency(div.amount_per_share, div.currency)}</td>
                  <td style={{ color: 'var(--accent-green)' }}>
                    {formatCurrency(div.total_converted !== null ? div.total_converted : div.total_amount, div.total_converted !== null ? currency : div.currency)}
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: '600',
                      background: div.source === 'avanza' ? 'var(--accent-green)' : (div.source === 'yahoo' ? 'var(--accent-blue)' : 'var(--text-secondary)'),
                      color: 'white'
                    }}>
                      {div.source === 'avanza' ? 'Avanza' : (div.source === 'yahoo' ? 'Yahoo' : 'Unknown')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {upcomingDividends.length > 5 && (
            <div style={{ textAlign: 'center', padding: '12px', borderTop: '1px solid var(--border-color)', marginTop: '12px' }}>
              <Link to="/dividends" style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontSize: '14px' }}>
                View all {upcomingDividends.length} upcoming dividends →
              </Link>
            </div>
          )}
        </div>
      )}
     </div>
   )
 }
