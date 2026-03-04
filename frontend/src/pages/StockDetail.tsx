import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, Stock, Dividend, StockUpcomingDividend, UpcomingDividend, AnalystData, ManualDividend, CompanyProfile, FinancialMetrics, VerificationResult, MarketstackUsage } from '../services/api'
import CompanyProfileComponent from '../components/CompanyProfile'
import FinancialMetricsComponent from '../components/FinancialMetrics'
import PeerCompanies from '../components/PeerCompanies'
import YfinanceAnalystPanel from '../components/YfinanceAnalystPanel'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'

function formatCurrency(value: number | null, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  const [year, month, day] = dateStr.split('-').map(Number)
  if (!year || !month || !day) return dateStr
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function formatDisplayName(name: string | null, ticker: string): string {
  if (!name) return ticker
  return name
    .replace(/\s+\(The\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function estimateDividendsPerYear(dividends: Dividend[]): number {
  const countsByYear = new Map<number, number>()

  for (const div of dividends) {
    const payoutDate = div.payment_date || div.date
    if (!payoutDate) continue
    const year = Number(payoutDate.slice(0, 4))
    if (!Number.isFinite(year)) continue
    countsByYear.set(year, (countsByYear.get(year) || 0) + 1)
  }

  const recentCounts = Array.from(countsByYear.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([, count]) => count)
    .filter((count) => count > 0)

  if (recentCounts.length === 0) return 1

  const frequencyMap = new Map<number, number>()
  for (const count of recentCounts) {
    frequencyMap.set(count, (frequencyMap.get(count) || 0) + 1)
  }

  const [mostCommon] = Array.from(frequencyMap.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return b[0] - a[0]
  })

  const estimated = mostCommon?.[0] ?? recentCounts[0]
  return Math.max(1, Math.min(12, estimated))
}

export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>()
  const navigate = useNavigate()
  const [stock, setStock] = useState<Stock | null>(null)
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [yearDividends, setYearDividends] = useState<UpcomingDividend[]>([])
  const [yearReceived, setYearReceived] = useState(0)
  const [yearRemaining, setYearRemaining] = useState(0)
  const [analystData, setAnalystData] = useState<AnalystData | null>(null)
  const [suppressedDividends, setSuppressedDividends] = useState<ManualDividend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'profile' | 'dividends' | 'analyst'>('overview')
  const [showEditModal, setShowEditModal] = useState(false)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [showDividendModal, setShowDividendModal] = useState(false)
  const [editingDividend, setEditingDividend] = useState<ManualDividend | null>(null)
  const [divDate, setDivDate] = useState('')
  const [divAmount, setDivAmount] = useState('')
  const [divNote, setDivNote] = useState('')
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null)
  const [financialMetrics, setFinancialMetrics] = useState<FinancialMetrics | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [finnhubLoading, setFinnhubLoading] = useState(false)
  const [analystDataLoading, setAnalystDataLoading] = useState(false)
  const [analystDataLoaded, setAnalystDataLoaded] = useState(false)
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [verificationLoading, setVerificationLoading] = useState(false)
  const [marketstackStatus, setMarketstackStatus] = useState<MarketstackUsage | null>(null)
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const { timezone } = useSettings()

  useEffect(() => {
    if (!ticker) return
    
    setVerificationResult(null)
    setMarketstackStatus(null)
    
    const fetchData = async () => {
      try {
        setLoading(true)
        const [stockData, divData, stockUpcomingData, suppressedData, ratesData] = await Promise.all([
          api.stocks.get(ticker),
          api.stocks.dividends(ticker),
          api.stocks.upcomingDividends(ticker).catch(() => []),
          api.stocks.getSuppressedDividends(ticker).catch(() => []),
          api.market.exchangeRates().catch(() => ({})),
        ])

        const safeRates = ratesData as Record<string, number | null>

        const convertToSEKValue = (amount: number | null, currency: string): number | null => {
          if (amount === null) return null
          if (currency === 'SEK') return amount
          const direct = safeRates[`${currency}_SEK`]
          if (direct) return amount * direct
          const inverse = safeRates[`SEK_${currency}`]
          if (inverse) return amount / inverse
          return null
        }

        const currentYear = new Date().getFullYear()
        const today = new Date().toISOString().slice(0, 10)

        const historicalYearDividends: UpcomingDividend[] = divData
          .filter((div: Dividend) => {
            const payoutDate = div.payment_date || div.date
            return payoutDate?.startsWith(`${currentYear}-`)
          })
          .map((div: Dividend) => {
            const amountPerShare = div.amount ?? 0
            const totalAmount = amountPerShare * stockData.quantity
            const divCurrency = div.currency || stockData.currency
            const totalConverted = convertToSEKValue(totalAmount, divCurrency)
            const payoutDate = div.payment_date || div.date

            return {
              ticker: stockData.ticker,
              name: stockData.name,
              quantity: stockData.quantity,
              ex_date: div.date,
              payment_date: div.payment_date,
              payout_date: payoutDate,
              status: payoutDate < today ? 'paid' : 'upcoming',
              dividend_type: null,
              amount_per_share: amountPerShare,
              total_amount: totalAmount,
              currency: divCurrency,
              total_converted: totalConverted,
              display_currency: 'SEK',
              source: div.source || 'yahoo'
            }
          })

        const upcomingYearDividends: UpcomingDividend[] = stockUpcomingData
          .filter((div: StockUpcomingDividend) => {
            const payoutDate = div.payment_date || div.ex_date
            return payoutDate?.startsWith(`${currentYear}-`)
          })
          .map((div: StockUpcomingDividend) => {
            const amountPerShare = div.amount ?? 0
            const totalAmount = amountPerShare * stockData.quantity
            const divCurrency = div.currency || stockData.currency
            const totalConverted = convertToSEKValue(totalAmount, divCurrency)
            const payoutDate = div.payment_date || div.ex_date

            return {
              ticker: stockData.ticker,
              name: stockData.name,
              quantity: stockData.quantity,
              ex_date: div.ex_date,
              payment_date: div.payment_date,
              payout_date: payoutDate,
              status: payoutDate < today ? 'paid' : 'upcoming',
              dividend_type: div.dividend_type,
              amount_per_share: amountPerShare,
              total_amount: totalAmount,
              currency: divCurrency,
              total_converted: totalConverted,
              display_currency: 'SEK',
              source: div.source || 'yahoo'
            }
          })

        const mergedYearDividends = [...historicalYearDividends, ...upcomingYearDividends]
        const dedupedMap = new Map<string, UpcomingDividend>()
        for (const div of mergedYearDividends) {
          const key = [
            div.ex_date,
            div.payment_date || '',
            div.amount_per_share,
            div.currency,
            div.dividend_type || '',
            div.source || ''
          ].join('|')
          dedupedMap.set(key, div)
        }

        const effectiveYearDividends = Array.from(dedupedMap.values()).sort((a, b) => {
          const aDate = a.payout_date || a.payment_date || a.ex_date
          const bDate = b.payout_date || b.payment_date || b.ex_date
          return aDate.localeCompare(bDate)
        })
        setStock(stockData)
        setDividends(divData)
        setYearDividends(effectiveYearDividends)
        setYearReceived(
          effectiveYearDividends.reduce((sum: number, div: UpcomingDividend) => (
            div.status === 'paid' && div.total_converted !== null ? sum + div.total_converted : sum
          ), 0)
        )
        setYearRemaining(
          effectiveYearDividends.reduce((sum: number, div: UpcomingDividend) => (
            div.status === 'upcoming' && div.total_converted !== null ? sum + div.total_converted : sum
          ), 0)
        )
        setSuppressedDividends(suppressedData)
        setExchangeRates(ratesData)
        setError(null)
      } catch (err: any) {
        setError(err.message || 'Failed to load stock data')
      } finally {
        setLoading(false)
      }
    }
    
    const fetchFinnhubData = async () => {
      try {
        setFinnhubLoading(true)
        const [profile, metrics, peersData] = await Promise.all([
          api.finnhub.profile(ticker).catch(() => null),
          api.finnhub.metrics(ticker).catch(() => null),
          api.finnhub.peers(ticker).catch(() => []),
        ])
        setCompanyProfile(profile)
        setFinancialMetrics(metrics)
        setPeers(peersData)
      } catch (err) {
        console.error('Failed to load Finnhub data', err)
      } finally {
        setFinnhubLoading(false)
      }
    }
    
    fetchData()
    fetchFinnhubData()
  }, [ticker])

  useEffect(() => {
    if (!ticker || analystDataLoaded || activeTab !== 'analyst') return

    const fetchAnalystData = async () => {
      try {
        setAnalystDataLoading(true)
        const analystInfo = await api.stocks.analyst(ticker).catch(() => null)
        setAnalystData(analystInfo)
        setAnalystDataLoaded(true)
      } catch (err) {
        console.error('Failed to load analyst data', err)
      } finally {
        setAnalystDataLoading(false)
      }
    }

    fetchAnalystData()
  }, [ticker, activeTab, analystDataLoaded])

  useEffect(() => {
    if (activeTab !== 'dividends') return
    api.marketstack.status().then(setMarketstackStatus).catch(() => null)
  }, [activeTab, ticker])

  const handleVerifyDividends = async () => {
    if (!ticker) return
    try {
      setVerificationLoading(true)
      const result = await api.marketstack.verify(ticker)
      setVerificationResult(result)
      setMarketstackStatus(result.usage)
    } catch (err: any) {
      console.error('Failed to verify dividends', err)
    } finally {
      setVerificationLoading(false)
    }
  }

  const openEditModal = () => {
    if (stock) {
      setEditQuantity(stock.quantity.toString())
      setEditPurchasePrice(stock.purchase_price?.toString() || '')
      setShowEditModal(true)
    }
  }

  const handleSaveEdit = async () => {
    if (!ticker || !stock) return
    try {
      setSaving(true)
      const updated = await api.stocks.update(ticker, {
        quantity: parseFloat(editQuantity) || undefined,
        purchase_price: editPurchasePrice ? parseFloat(editPurchasePrice) : undefined,
      })
      setStock(updated)
      setShowEditModal(false)
    } catch (err) {
      console.error('Failed to save', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!ticker || !confirm(`Delete ${ticker} from your portfolio?`)) return
    try {
      await api.stocks.delete(ticker)
      navigate('/stocks')
    } catch (err) {
      console.error('Failed to delete', err)
    }
  }

  const openAddDividendModal = () => {
    setEditingDividend(null)
    setDivDate('')
    setDivAmount('')
    setDivNote('')
    setShowDividendModal(true)
  }

  const openEditDividendModal = (div: ManualDividend) => {
    setEditingDividend(div)
    setDivDate(div.date)
    setDivAmount(div.amount.toString())
    setDivNote(div.note || '')
    setShowDividendModal(true)
  }

  const handleSaveDividend = async () => {
    if (!ticker || !divDate || !divAmount) return
    try {
      setSaving(true)
      if (editingDividend) {
        const updated = await api.stocks.updateManualDividend(ticker, editingDividend.id, {
          date: divDate,
          amount: parseFloat(divAmount),
          note: divNote || undefined,
        })
        setStock(updated)
      } else {
        const updated = await api.stocks.addManualDividend(ticker, {
          date: divDate,
          amount: parseFloat(divAmount),
          currency: stock?.currency,
          note: divNote || undefined,
        })
        setStock(updated)
      }
      setShowDividendModal(false)
    } catch (err) {
      console.error('Failed to save dividend', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteDividend = async (dividendId: string) => {
    if (!ticker || !confirm('Delete this dividend entry?')) return
    try {
      await api.stocks.deleteManualDividend(ticker, dividendId)
      if (stock) {
        setStock({
          ...stock,
          manual_dividends: stock.manual_dividends?.filter(d => d.id !== dividendId) || []
        })
      }
    } catch (err) {
      console.error('Failed to delete dividend', err)
    }
  }

  const handleSuppressDividend = async (date: string, amount: number) => {
    if (!ticker) return
    try {
      await api.stocks.suppressDividend(ticker, { date, amount, currency: stock?.currency })
      const suppressed = await api.stocks.getSuppressedDividends(ticker)
      setSuppressedDividends(suppressed)
    } catch (err) {
      console.error('Failed to suppress dividend', err)
    }
  }

  const handleRestoreDividend = async (date: string) => {
    if (!ticker) return
    try {
      await api.stocks.restoreDividend(ticker, date)
      setSuppressedDividends(suppressedDividends.filter(d => d.date !== date))
    } catch (err) {
      console.error('Failed to restore dividend', err)
    }
  }

  const isDividendSuppressed = (date: string) => {
    return suppressedDividends.some(s => s.date === date)
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div>
  }

  if (error || !stock) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error || 'Stock not found'}</p>
        <Link to="/stocks" className="btn btn-primary">Back to Stocks</Link>
      </div>
    )
  }

  const dailyChange = stock.current_price && stock.previous_close 
    ? stock.current_price - stock.previous_close 
    : null
  const dailyChangePercent = dailyChange && stock.previous_close 
    ? (dailyChange / stock.previous_close) * 100 
    : null

  const convertToSEK = (amount: number | null, fromCurrency: string): number | null => {
    if (amount === null) return null
    if (fromCurrency === 'SEK') return amount
    const direct = exchangeRates[`${fromCurrency}_SEK`]
    if (direct) return amount * direct
    const inverse = exchangeRates[`SEK_${fromCurrency}`]
    if (inverse) return amount / inverse
    return null
  }

  const renderValueWithSEK = (amount: number | null, fromCurrency: string, align: 'left' | 'right' = 'right') => {
    const sekValue = convertToSEK(amount, fromCurrency)
    const textAlign = align

    return (
      <div style={{ textAlign }}>
        <div>{formatCurrency(amount, fromCurrency)}</div>
        {amount !== null && fromCurrency !== 'SEK' && sekValue !== null && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
            {formatCurrency(sekValue, 'SEK')}
          </div>
        )}
      </div>
    )
  }

  const displayName = formatDisplayName(stock.name, stock.ticker)
  const today = new Date()
  const oneYearAgo = new Date(today)
  oneYearAgo.setFullYear(today.getFullYear() - 1)

  let derivedDividendPerShare: number | null = null
  let derivedDividendEvents = 0

  for (const div of dividends) {
    const payoutDate = div.payment_date || div.date
    if (!payoutDate) continue

    const eventDate = new Date(`${payoutDate}T00:00:00Z`)
    if (Number.isNaN(eventDate.getTime())) continue

    if (eventDate >= oneYearAgo && eventDate <= today) {
      if (derivedDividendPerShare === null) derivedDividendPerShare = 0
      derivedDividendPerShare += div.amount
      derivedDividendEvents += 1
    }
  }

  if (derivedDividendEvents === 0) {
    derivedDividendPerShare = null
  }

  const estimatedDividendsPerYear = estimateDividendsPerYear(dividends)
  const upcomingThisYearAmounts = yearDividends
    .filter((div) => div.status === 'upcoming')
    .map((div) => div.amount_per_share)
    .filter((amount): amount is number => amount !== null && amount > 0)
  const knownThisYearAmounts = yearDividends
    .map((div) => div.amount_per_share)
    .filter((amount): amount is number => amount !== null && amount > 0)

  const knownThisYearCount = knownThisYearAmounts.length
  const knownThisYearPerShare = knownThisYearCount > 0
    ? knownThisYearAmounts.reduce((sum, amount) => sum + amount, 0)
    : null

  let modeledPerShareFromYearData: number | null = null
  if (knownThisYearPerShare !== null) {
    modeledPerShareFromYearData = knownThisYearPerShare
    if (knownThisYearCount < estimatedDividendsPerYear) {
      const missingCount = estimatedDividendsPerYear - knownThisYearCount
      const representativeUpcomingAmount = upcomingThisYearAmounts.length > 0
        ? upcomingThisYearAmounts[0]
        : knownThisYearAmounts[knownThisYearAmounts.length - 1]

      if (representativeUpcomingAmount > 0) {
        modeledPerShareFromYearData += representativeUpcomingAmount * missingCount
      }
    }
  }

  const displayDividendPerShare =
    modeledPerShareFromYearData ??
    stock.dividend_per_share ??
    financialMetrics?.dividend_per_share_annual ??
    derivedDividendPerShare

  const derivedDividendYield =
    displayDividendPerShare !== null && stock.current_price !== null && stock.current_price > 0
      ? (displayDividendPerShare / stock.current_price) * 100
      : null

  const displayDividendYield =
    stock.dividend_yield ??
    financialMetrics?.dividend_yield ??
    derivedDividendYield

  const displayAnnualIncome =
    displayDividendPerShare !== null ? displayDividendPerShare * stock.quantity : null
  const hasProfileContent = Boolean(companyProfile || financialMetrics || (peers && peers.length > 0))

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <Link to="/stocks" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
          ← Back to Stocks
        </Link>
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            {stock.logo ? (
              <img
                src={stock.logo}
                alt={displayName}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  objectFit: 'contain',
                  background: 'var(--bg-secondary)',
                  padding: 6,
                  border: '1px solid var(--border-color)'
                }}
              />
            ) : (
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)'
                }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 style={{ fontSize: '32px', fontWeight: '600', marginBottom: '8px' }}>
                {stock.ticker}
              </h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '18px' }}>
                {displayName}
              </p>
            </div>
            {stock.sector && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {stock.sector}
              </p>
            )}
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '8px' }}>
              Last updated: {formatTimeInTimezone(stock.last_updated, timezone)} · Auto-refresh every 10 min
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={openEditModal}>
              Edit
            </button>
            <button className="btn btn-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
        </div>
        
        <div style={{ marginTop: '24px', display: 'flex', gap: '32px', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: '36px', fontWeight: '600' }}>
              {formatCurrency(stock.current_price, stock.currency)}
            </div>
            {stock.currency !== 'SEK' && convertToSEK(stock.current_price, stock.currency) !== null && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {formatCurrency(convertToSEK(stock.current_price, stock.currency), 'SEK')}
              </p>
            )}
            {dailyChange !== null && (
              <p style={{ 
                color: dailyChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                fontSize: '16px'
              }}>
                {dailyChange >= 0 ? '+' : ''}{formatCurrency(dailyChange, stock.currency)} ({dailyChangePercent?.toFixed(2)}%)
              </p>
            )}
            {dailyChange !== null && stock.currency !== 'SEK' && convertToSEK(dailyChange, stock.currency) !== null && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '2px' }}>
                {dailyChange >= 0 ? '+' : ''}{formatCurrency(convertToSEK(dailyChange, stock.currency), 'SEK')}
              </p>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)' }}>
            {stock.currency}
          </p>
        </div>
      </div>

      <div style={{ marginBottom: '24px', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', gap: '24px' }}>
          {(['overview', 'profile', 'dividends', 'analyst'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '12px 0',
                background: 'none',
                border: 'none',
                color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: activeTab === tab ? '2px solid var(--accent-blue)' : 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
              }}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-2">
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>Position</h3>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Quantity</td>
                  <td style={{ textAlign: 'right' }}>{stock.quantity}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Purchase Price</td>
                  <td>{renderValueWithSEK(stock.purchase_price, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Current Value</td>
                  <td>{renderValueWithSEK(stock.current_price ? stock.current_price * stock.quantity : null, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Total Cost</td>
                  <td>{renderValueWithSEK(stock.purchase_price ? stock.purchase_price * stock.quantity : null, stock.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>Dividend Info</h3>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Dividend Yield</td>
                  <td style={{ textAlign: 'right' }}>
                    {displayDividendYield !== null ? `${displayDividendYield.toFixed(2)}%` : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Dividend/Share</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(displayDividendPerShare, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Annual Income</td>
                  <td style={{ textAlign: 'right' }}>
                    {displayAnnualIncome !== null ? formatCurrency(displayAnnualIncome, stock.currency) : '-'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'profile' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <CompanyProfileComponent profile={companyProfile} loading={finnhubLoading} />
          <FinancialMetricsComponent metrics={financialMetrics} loading={finnhubLoading} />
          <PeerCompanies peers={peers} loading={finnhubLoading} />
          {!finnhubLoading && !hasProfileContent && (
            <div className="card">
              <h3 style={{ marginBottom: '12px' }}>Profile Snapshot</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '14px' }}>
                No extended profile data is available for this ticker right now, but your core position data is up to date.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Sector</p>
                  <p>{stock.sector || '-'}</p>
                </div>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Dividend/Share (modeled)</p>
                  <p>{formatCurrency(displayDividendPerShare, stock.currency)}</p>
                </div>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Annual Income</p>
                  <p>{displayAnnualIncome !== null ? formatCurrency(displayAnnualIncome, stock.currency) : '-'}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'dividends' && (
        <div>
          <div className="card" style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3>Manual Dividends</h3>
              <button className="btn btn-primary" onClick={openAddDividendModal}>
                Add Dividend
              </button>
            </div>
            {stock.manual_dividends && stock.manual_dividends.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Note</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.manual_dividends.map((div) => (
                    <tr key={div.id}>
                      <td>{formatDate(div.date)}</td>
                      <td style={{ color: 'var(--accent-green)' }}>{formatCurrency(div.amount, div.currency)}</td>
                      <td>{div.note || '-'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => openEditDividendModal(div)}
                          >
                            Edit
                          </button>
                          <button 
                            className="btn btn-danger" 
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => handleDeleteDividend(div.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                No manual dividends. Click "Add Dividend" to add one.
              </p>
            )}
          </div>
          
          {yearDividends.length > 0 && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h3>Dividends (This Year)</h3>
                <div style={{ display: 'flex', gap: '16px', fontSize: '13px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Received: <strong style={{ color: 'var(--accent-green)' }}>{formatCurrency(yearReceived, 'SEK')}</strong>
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Remaining: <strong style={{ color: 'var(--accent-blue)' }}>{formatCurrency(yearRemaining, 'SEK')}</strong>
                  </span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Ex-Date</th>
                    <th>Dividend Date</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {yearDividends.map((div, i) => (
                    <tr key={i}>
                      <td>{formatDate(div.ex_date)}</td>
                      <td>{div.payment_date ? formatDate(div.payment_date) : '-'}</td>
                      <td>{formatCurrency(div.amount_per_share, div.currency || stock.currency)}</td>
                      <td style={{ color: div.status === 'paid' ? 'var(--accent-green)' : 'var(--accent-blue)', fontSize: '12px' }}>
                        {div.status === 'paid' ? 'Paid' : 'Upcoming'}
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {div.source || 'historical'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>Dividend History (Last 5 Years)</h3>
            {dividends.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                No dividend history available
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dividends.slice(0, 20).map((div, i) => {
                    const suppressed = isDividendSuppressed(div.date)
                    return (
                      <tr key={i} style={{ opacity: suppressed ? 0.5 : 1 }}>
                        <td>{formatDate(div.date)}</td>
                        <td style={{ color: suppressed ? 'var(--text-secondary)' : 'var(--accent-green)' }}>
                          {formatCurrency(div.amount, div.currency || stock.currency)}
                          {suppressed && <span style={{ marginLeft: '8px', fontSize: '12px' }}>(suppressed)</span>}
                        </td>
                        <td>
                          {suppressed ? (
                            <button 
                              className="btn btn-secondary" 
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => handleRestoreDividend(div.date)}
                            >
                              Restore
                            </button>
                          ) : (
                            <button 
                              className="btn btn-secondary" 
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => handleSuppressDividend(div.date, div.amount)}
                            >
                              Hide
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          
          <div className="card" style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3>Dividend Verification</h3>
              {marketstackStatus && (
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  API: {marketstackStatus.calls_remaining}/{marketstackStatus.calls_limit} calls remaining
                </span>
              )}
            </div>
            
            {marketstackStatus && marketstackStatus.api_configured === false ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                Marketstack API not configured. Set MARKETSTACK_API_KEY environment variable.
              </p>
            ) : verificationLoading ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                Verifying dividends...
              </p>
            ) : verificationResult ? (
              <div>
                <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
                  <div style={{ padding: '12px 16px', background: 'var(--card-bg-alt)', borderRadius: '8px' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Yahoo</span>
                    <p style={{ fontSize: '20px', fontWeight: '600' }}>{verificationResult.summary.yahoo_count}</p>
                  </div>
                  <div style={{ padding: '12px 16px', background: 'var(--card-bg-alt)', borderRadius: '8px' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Marketstack</span>
                    <p style={{ fontSize: '20px', fontWeight: '600' }}>{verificationResult.summary.marketstack_count}</p>
                  </div>
                  <div style={{ padding: '12px 16px', background: 'rgba(34, 197, 94, 0.15)', borderRadius: '8px' }}>
                    <span style={{ color: 'var(--accent-green)', fontSize: '12px' }}>Matches</span>
                    <p style={{ fontSize: '20px', fontWeight: '600', color: 'var(--accent-green)' }}>{verificationResult.summary.match_count}</p>
                  </div>
                  <div style={{ padding: '12px 16px', background: verificationResult.summary.discrepancy_count > 0 ? 'var(--accent-red)' : 'var(--card-bg-alt)', borderRadius: '8px' }}>
                    <span style={{ color: verificationResult.summary.discrepancy_count > 0 ? '#ffffff' : 'var(--text-secondary)', fontSize: '12px' }}>Discrepancies</span>
                    <p style={{ fontSize: '20px', fontWeight: '600', color: verificationResult.summary.discrepancy_count > 0 ? '#ffffff' : 'var(--text-primary)' }}>{verificationResult.summary.discrepancy_count}</p>
                  </div>
                </div>
                
                {verificationResult.cached && (
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    (Cached result from {new Date(verificationResult.verified_at).toLocaleString()})
                  </p>
                )}
                
                {verificationResult.discrepancies.length > 0 && (
                  <div>
                    <h4 style={{ marginBottom: '12px', fontSize: '14px' }}>Discrepancy Details</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Type</th>
                          <th>Yahoo</th>
                          <th>Marketstack</th>
                          <th>Difference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {verificationResult.discrepancies.map((d, i) => (
                          <tr key={i}>
                            <td>{d.date || '-'}</td>
                            <td>
                              <span style={{
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 500,
                                background: d.type === 'amount_mismatch' ? '#fbbf24' : 
                                           d.type === 'missing_from_yahoo' ? '#3b82f6' :
                                           d.type === 'missing_from_marketstack' ? '#f97316' : '#ef4444',
                                color: '#1a1a1a',
                              }}>
                                {d.type.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td>{d.yahoo_amount !== null ? formatCurrency(d.yahoo_amount, stock.currency) : '-'}</td>
                            <td>{d.marketstack_amount !== null ? formatCurrency(d.marketstack_amount, stock.currency) : '-'}</td>
                            <td>{d.difference !== null ? formatCurrency(d.difference, stock.currency) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                
                <div style={{ marginTop: '16px' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleVerifyDividends}
                    disabled={verificationLoading || (marketstackStatus !== null && (marketstackStatus.calls_remaining ?? 0) <= 0)}
                  >
                    Re-verify (uses 1 API call)
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  Compare Yahoo Finance dividend data against Marketstack to verify accuracy.
                </p>
                <button 
                  className="btn btn-primary" 
                  onClick={handleVerifyDividends}
                  disabled={verificationLoading || (marketstackStatus !== null && (marketstackStatus.calls_remaining ?? 0) <= 0)}
                >
                  Verify Dividends (1 API call)
                </button>
              </div>
            )}
          </div>
          
          {suppressedDividends.length > 0 && (
            <div className="card" style={{ marginTop: '20px' }}>
              <h3 style={{ marginBottom: '16px', color: 'var(--text-secondary)' }}>Suppressed Dividends</h3>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {suppressedDividends.map((div) => (
                    <tr key={div.id}>
                      <td>{formatDate(div.date)}</td>
                      <td>{formatCurrency(div.amount || 0, div.currency || stock.currency)}</td>
                      <td>
                        <button 
                          className="btn btn-secondary" 
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          onClick={() => handleRestoreDividend(div.date)}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'analyst' && (
        <div>
          {analystDataLoading ? (
            <div className="card">
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
                Loading analyst data...
              </p>
            </div>
          ) : (
            <>
              <YfinanceAnalystPanel
                priceTargets={analystData?.price_targets || null}
                recommendations={analystData?.recommendations || null}
                finnhubRecommendations={analystData?.finnhub_recommendations || null}
                currency={stock?.currency || 'USD'}
                currentPrice={stock?.current_price ?? null}
              />

              {!analystData?.price_targets && !analystData?.recommendations?.length && !analystData?.finnhub_recommendations?.length && !finnhubLoading && !analystDataLoading && (
                <div className="card">
                  <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
                    No analyst data available
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showEditModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowEditModal(false)}
        >
          <div 
            className="card" 
            style={{ width: '400px', maxWidth: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '20px' }}>Edit Position</h3>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Quantity
              </label>
              <input
                type="number"
                step="0.01"
                value={editQuantity}
                onChange={(e) => setEditQuantity(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Purchase Price ({stock?.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={editPurchasePrice}
                onChange={(e) => setEditPurchasePrice(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. 150.00"
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowEditModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDividendModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowDividendModal(false)}
        >
          <div 
            className="card" 
            style={{ width: '400px', maxWidth: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '20px' }}>
              {editingDividend ? 'Edit Dividend' : 'Add Dividend'}
            </h3>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Date
              </label>
              <input
                type="date"
                value={divDate}
                onChange={(e) => setDivDate(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Amount ({stock?.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={divAmount}
                onChange={(e) => setDivAmount(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. 1.50"
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Note (optional)
              </label>
              <input
                type="text"
                value={divNote}
                onChange={(e) => setDivNote(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. Q1 2024 dividend"
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowDividendModal(false)}>
                Cancel
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleSaveDividend} 
                disabled={saving || !divDate || !divAmount}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
