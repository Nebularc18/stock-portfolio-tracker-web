import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api, Stock } from '../services/api'
import { getLocaleForLanguage, t } from '../i18n'
import { useSettings } from '../SettingsContext'

function formatCurrency(value: number | null, locale: string, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number | null, locale: string): string {
  if (value === null) return '-'
  const absValue = Math.abs(value) / 100
  const formatted = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(absValue)
  return value >= 0 ? `+${formatted}` : `-${formatted}`
}

function sanitizeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""'
  const str = String(value)
  const escaped = str.replace(/"/g, '""')
  const quoted = `"${escaped}"`
  if (/^[\u0000-\u001F\s]*[=+\-@]/.test(str)) {
    return `"\t${escaped}"`
  }
  return quoted
}

type SortField = 'ticker' | 'name' | 'value' | 'cost' | 'gain' | 'gainPercent' | 'dailyChange' | 'dailyChangePercent'
type SortOrder = 'asc' | 'desc'

interface PerformanceData {
  ticker: string
  name: string | null
  quantity: number
  currency: string
  purchasePrice: number | null
  currentPrice: number | null
  previousClose: number | null
  value: number
  cost: number
  gain: number
  gainPercent: number
  dailyChange: number | null
  dailyChangePercent: number | null
  valueSEK: number
  costSEK: number
  gainSEK: number
  dailyChangeSEK: number | null
}

export default function Performance() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(true)
  const [sortField, setSortField] = useState<SortField>('gainPercent')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const [stocksData, ratesData] = await Promise.all([
          api.stocks.list(),
          api.market.exchangeRates(),
        ])
        setStocks(stocksData)
        setExchangeRates(ratesData)
      } catch (err) {
        console.error('Failed to load data:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const convertToSEK = (amount: number, currency: string): number => {
    if (currency === 'SEK') return amount
    const rate = exchangeRates[`${currency}_SEK`]
    if (rate != null) return amount * rate
    return amount
  }

  const performanceData: PerformanceData[] = stocks.map(stock => {
    const value = (stock.current_price || 0) * stock.quantity
    const cost = (stock.purchase_price || 0) * stock.quantity
    const gain = value - cost
    const gainPercent = cost > 0 ? (gain / cost) * 100 : 0
    const dailyChange = stock.current_price != null && stock.previous_close != null
      ? (stock.current_price - stock.previous_close) * stock.quantity
      : null
    const dailyChangePercent = stock.current_price != null && stock.previous_close != null && stock.previous_close !== 0
      ? ((stock.current_price - stock.previous_close) / stock.previous_close) * 100
      : null

    return {
      ticker: stock.ticker,
      name: stock.name,
      quantity: stock.quantity,
      currency: stock.currency,
      purchasePrice: stock.purchase_price,
      currentPrice: stock.current_price,
      previousClose: stock.previous_close,
      value,
      cost,
      gain,
      gainPercent,
      dailyChange,
      dailyChangePercent,
      valueSEK: convertToSEK(value, stock.currency),
      costSEK: convertToSEK(cost, stock.currency),
      gainSEK: convertToSEK(gain, stock.currency),
      dailyChangeSEK: dailyChange != null ? convertToSEK(dailyChange, stock.currency) : null,
    }
  })

  const sortedData = [...performanceData].sort((a, b) => {
    let aVal: number | string = 0
    let bVal: number | string = 0

    switch (sortField) {
      case 'ticker':
        aVal = a.ticker
        bVal = b.ticker
        break
      case 'name':
        aVal = a.name || ''
        bVal = b.name || ''
        break
      case 'value':
        aVal = a.valueSEK
        bVal = b.valueSEK
        break
      case 'cost':
        aVal = a.costSEK
        bVal = b.costSEK
        break
      case 'gain':
        aVal = a.gainSEK
        bVal = b.gainSEK
        break
      case 'gainPercent':
        aVal = a.gainPercent
        bVal = b.gainPercent
        break
      case 'dailyChange':
        aVal = a.dailyChangeSEK || 0
        bVal = b.dailyChangeSEK || 0
        break
      case 'dailyChangePercent':
        aVal = a.dailyChangePercent || 0
        bVal = b.dailyChangePercent || 0
        break
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    return sortOrder === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
  })

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortOrder('desc')
    }
  }

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <th 
      onClick={() => handleSort(field)} 
      style={{ cursor: 'pointer', userSelect: 'none' }}
    >
      {label} {sortField === field ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  const bestPerformers = [...performanceData].sort((a, b) => b.gainPercent - a.gainPercent).slice(0, 3)
  const worstPerformers = [...performanceData].sort((a, b) => a.gainPercent - b.gainPercent).slice(0, 3)

  const totalValue = performanceData.reduce((sum, s) => sum + s.valueSEK, 0)
  const totalCost = performanceData.reduce((sum, s) => sum + s.costSEK, 0)
  const totalGain = totalValue - totalCost
  const totalGainPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : 0
  const totalDailyChange = performanceData.reduce((sum, s) => sum + (s.dailyChangeSEK || 0), 0)

  const exportToCSV = () => {
    const headers = ['Ticker', 'Name', 'Quantity', 'Currency', 'Purchase Price', 'Current Price', 'Value', 'Cost', 'Gain', 'Gain %', 'Daily Change', 'Daily Change %']
    const rows = sortedData.map(s => [
      sanitizeCsvCell(s.ticker),
      sanitizeCsvCell(s.name),
      sanitizeCsvCell(s.quantity),
      sanitizeCsvCell(s.currency),
      sanitizeCsvCell(s.purchasePrice?.toFixed(2)),
      sanitizeCsvCell(s.currentPrice?.toFixed(2)),
      sanitizeCsvCell(s.value.toFixed(2)),
      sanitizeCsvCell(s.cost.toFixed(2)),
      sanitizeCsvCell(s.gain.toFixed(2)),
      sanitizeCsvCell(s.gainPercent.toFixed(2) + '%'),
      sanitizeCsvCell(s.dailyChange?.toFixed(2)),
      sanitizeCsvCell(s.dailyChangePercent != null ? s.dailyChangePercent.toFixed(2) + '%' : ''),
    ])
    
    const csvContent = [headers.map(sanitizeCsvCell).join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `portfolio_performance_${new Date().toISOString().split('T')[0]}.csv`
    link.click()
    URL.revokeObjectURL(url)
    link.remove()
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'common.loading')}</div>
  }

  if (stocks.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'performance.noStocks')}</p>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'performance.title')}</h2>
        <button className="btn btn-secondary" onClick={exportToCSV}>
          {t(language, 'performance.exportCsv')}
        </button>
      </div>

      <div className="grid grid-4" style={{ marginBottom: '24px' }}>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'performance.totalValue')}</p>
          <p style={{ fontSize: '24px', fontWeight: '600' }}>
            {formatCurrency(totalValue, locale, 'SEK')}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'performance.totalCost')}</p>
          <p style={{ fontSize: '24px', fontWeight: '600' }}>
            {formatCurrency(totalCost, locale, 'SEK')}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'performance.totalGainLoss')}</p>
          <p style={{ fontSize: '24px', fontWeight: '600' }} className={totalGain >= 0 ? 'positive' : 'negative'}>
            {formatCurrency(totalGain, locale, 'SEK')}
          </p>
          <p style={{ fontSize: '14px' }} className={totalGainPercent >= 0 ? 'positive' : 'negative'}>
            {formatPercent(totalGainPercent, locale)}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'performance.dailyChange')}</p>
          <p style={{ fontSize: '24px', fontWeight: '600' }} className={totalDailyChange >= 0 ? 'positive' : 'negative'}>
            {formatCurrency(totalDailyChange, locale, 'SEK')}
          </p>
        </div>
      </div>

      {(bestPerformers.length > 0 || worstPerformers.length > 0) && (
        <div className="grid grid-2" style={{ marginBottom: '24px' }}>
          {bestPerformers.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px', color: 'var(--accent-green)' }}>{t(language, 'performance.bestPerformers')}</h3>
              {bestPerformers.map((stock) => (
                <div key={stock.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                  <div>
                    <Link to={`/stocks/${stock.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                      {stock.ticker}
                    </Link>
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '8px', fontSize: '12px' }}>
                      {stock.name}
                    </span>
                  </div>
                  <span className="positive">{formatPercent(stock.gainPercent, locale)}</span>
                </div>
              ))}
            </div>
          )}
          {worstPerformers.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px', color: 'var(--accent-red)' }}>{t(language, 'performance.worstPerformers')}</h3>
              {worstPerformers.map((stock) => (
                <div key={stock.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                  <div>
                    <Link to={`/stocks/${stock.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                      {stock.ticker}
                    </Link>
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '8px', fontSize: '12px' }}>
                      {stock.name}
                    </span>
                  </div>
                  <span className="negative">{formatPercent(stock.gainPercent, locale)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'performance.holdingsPerformance')}</h3>
        <table>
          <thead>
            <tr>
              <SortHeader field="ticker" label={t(language, 'performance.ticker')} />
              <SortHeader field="name" label={t(language, 'performance.name')} />
              <th>{t(language, 'performance.qty')}</th>
              <th>{t(language, 'performance.currency')}</th>
              <SortHeader field="cost" label={t(language, 'performance.costSek')} />
              <SortHeader field="value" label={t(language, 'performance.valueSek')} />
              <SortHeader field="gain" label={t(language, 'performance.gainLoss')} />
              <SortHeader field="gainPercent" label={t(language, 'performance.returnPercent')} />
              <SortHeader field="dailyChange" label={t(language, 'performance.dailySek')} />
              <SortHeader field="dailyChangePercent" label={t(language, 'performance.dailyPercent')} />
            </tr>
          </thead>
          <tbody>
            {sortedData.map((stock) => (
              <tr key={stock.ticker}>
                <td>
                  <Link to={`/stocks/${stock.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                    {stock.ticker}
                  </Link>
                </td>
                <td>{stock.name || '-'}</td>
                <td>{stock.quantity}</td>
                <td>{stock.currency}</td>
                <td>{formatCurrency(stock.costSEK, locale, 'SEK')}</td>
                <td>{formatCurrency(stock.valueSEK, locale, 'SEK')}</td>
                <td className={stock.gain >= 0 ? 'positive' : 'negative'}>
                  {formatCurrency(stock.gainSEK, locale, 'SEK')}
                </td>
                <td className={stock.gainPercent >= 0 ? 'positive' : 'negative'}>
                  {formatPercent(stock.gainPercent, locale)}
                </td>
                <td className={stock.dailyChangeSEK != null ? (stock.dailyChangeSEK >= 0 ? 'positive' : 'negative') : ''}>
                  {stock.dailyChangeSEK !== null ? formatCurrency(stock.dailyChangeSEK, locale, 'SEK') : '-'}
                </td>
                <td className={stock.dailyChangePercent != null ? (stock.dailyChangePercent >= 0 ? 'positive' : 'negative') : ''}>
                  {formatPercent(stock.dailyChangePercent, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
