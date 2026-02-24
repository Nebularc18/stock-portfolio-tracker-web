import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts'
import { api, PortfolioSummary, Dividend, Stock } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'

const COLORS = ['#6366f1', '#ec4899', '#ef4444', '#f97316', '#22c55e', '#3b82f6', '#a855f7', '#f43f5e']

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

interface Distribution {
  by_sector: Record<string, number>
  by_currency: Record<string, number>
  by_stock: Record<string, number>
}

export default function Dashboard() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [distribution, setDistribution] = useState<Distribution | null>(null)
  const [dividendsByStock, setDividendsByStock] = useState<Record<string, Dividend[]>>({})
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [portfolioHistory, setPortfolioHistory] = useState<{ date: string; value: number }[]>([])
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { displayCurrency, timezone } = useSettings()

  const fetchData = async () => {
    try {
      setLoading(true)
      const [summaryData, distributionData, stocksData, ratesData, historyData] = await Promise.all([
        api.portfolio.summary(),
        api.portfolio.distribution(),
        api.stocks.list(),
        api.market.exchangeRates(),
        api.portfolio.history(90).catch(() => []),
      ])
      setSummary(summaryData)
      setDistribution(distributionData)
      setStocks(stocksData)
      setExchangeRates(ratesData)
      setPortfolioHistory(historyData.reverse())
      setLastUpdate(new Date())
      
      if (summaryData.stocks?.length) {
        const divPromises = summaryData.stocks.map(async (s) => {
          try {
            const divs = await api.stocks.dividends(s.ticker, 1)
            return { ticker: s.ticker, dividends: divs.filter(d => d.date.startsWith(new Date().getFullYear().toString())) }
          } catch {
            return { ticker: s.ticker, dividends: [] }
          }
        })
        const divResults = await Promise.all(divPromises)
        const divMap: Record<string, Dividend[]> = {}
        divResults.forEach(r => { if (r.dividends.length) divMap[r.ticker] = r.dividends })
        setDividendsByStock(divMap)
      }
      
      setError(null)
    } catch (err) {
      setError('Failed to load portfolio data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

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

  const sectorData = distribution?.by_sector 
    ? Object.entries(distribution.by_sector).map(([name, value]) => ({ name, value }))
    : []
  
  const stockData = distribution?.by_stock
    ? Object.entries(distribution.by_stock).map(([name, value]) => ({ name, value }))
    : []

  const totalDividends = Object.values(dividendsByStock).flat().reduce((sum, d) => sum + d.amount, 0)

  const renderPieLabel = ({ name, percent }: { name: string; percent: number }) => {
    if (percent < 0.05) return null
    return `${name} (${(percent * 100).toFixed(0)}%)`
  }

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

      {portfolioHistory.length > 1 && (
        <div className="card" style={{ marginBottom: '24px' }}>
          <h3 style={{ marginBottom: '16px' }}>Portfolio Value (90 days)</h3>
          <div style={{ height: 250 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={portfolioHistory.map(h => ({
                date: new Date(h.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                value: h.value
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="date" stroke="#888" fontSize={12} />
                <YAxis stroke="#888" fontSize={12} tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                <Tooltip 
                  formatter={(value: number) => formatCurrency(value, currency)}
                  contentStyle={{ background: '#2a2a2a', border: '1px solid #444', borderRadius: '8px', color: '#fff' }}
                />
                <Line type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {(sectorData.length > 0 || stockData.length > 0) && (
        <div className="grid grid-2" style={{ marginBottom: '24px' }}>
          {stockData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>Portfolio Distribution</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stockData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {stockData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, currency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          
          {sectorData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>Sector Distribution</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sectorData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {sectorData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, currency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
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
                  onClick={() => window.location.href = `/stocks/${stock.ticker}`}
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
                  <td className={stock.gain_loss && stock.gain_loss >= 0 ? 'positive' : 'negative'}>
                    {stock.gain_loss !== null ? formatCurrency(stock.gain_loss, currency) : '-'}
                  </td>
                  <td className={stock.gain_loss_percent && stock.gain_loss_percent >= 0 ? 'positive' : 'negative'}>
                    {stock.gain_loss_percent !== null ? formatPercent(stock.gain_loss_percent) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
         )}
       </div>

      {Object.keys(dividendsByStock).length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: '8px' }}>Dividends {new Date().getFullYear()}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '16px' }}>
            Total: <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>{formatCurrency(totalDividends)}</span>
          </p>
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(dividendsByStock).map(([ticker, dividends]) => 
                dividends.map((div, i) => (
                  <tr key={`${ticker}-${i}`}>
                    <td>
                      <Link to={`/stocks/${ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                        {ticker}
                      </Link>
                    </td>
                    <td>{div.date}</td>
                    <td style={{ color: 'var(--accent-green)' }}>{formatCurrency(div.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
     </div>
   )
  }
