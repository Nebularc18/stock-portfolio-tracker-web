import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, Stock, Dividend, StockUpcomingDividend, AnalystData, ManualDividend, CompanyProfile, FinancialMetrics, VerificationResult, MarketstackUsage } from '../services/api'
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
  return new Date(dateStr).toLocaleDateString()
}

export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>()
  const navigate = useNavigate()
  const [stock, setStock] = useState<Stock | null>(null)
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [upcomingDividends, setUpcomingDividends] = useState<StockUpcomingDividend[]>([])
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
  const { timezone } = useSettings()

  useEffect(() => {
    if (!ticker) return
    
    setVerificationResult(null)
    setMarketstackStatus(null)
    
    const fetchData = async () => {
      try {
        setLoading(true)
        const [stockData, divData, upcomingData, suppressedData] = await Promise.all([
          api.stocks.get(ticker),
          api.stocks.dividends(ticker),
          api.stocks.upcomingDividends(ticker),
          api.stocks.getSuppressedDividends(ticker).catch(() => []),
        ])
        setStock(stockData)
        setDividends(divData)
        setUpcomingDividends(upcomingData)
        setSuppressedDividends(suppressedData)
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

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <Link to="/stocks" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
          ← Back to Stocks
        </Link>
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontSize: '32px', fontWeight: '600', marginBottom: '8px' }}>
              {stock.ticker}
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '18px' }}>
              {stock.name || 'Unknown Company'}
            </p>
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
            <p style={{ fontSize: '36px', fontWeight: '600' }}>
              {formatCurrency(stock.current_price, stock.currency)}
            </p>
            {dailyChange !== null && (
              <p style={{ 
                color: dailyChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                fontSize: '16px'
              }}>
                {dailyChange >= 0 ? '+' : ''}{dailyChange.toFixed(2)} ({dailyChangePercent?.toFixed(2)}%)
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
                  <td style={{ textAlign: 'right' }}>{formatCurrency(stock.purchase_price, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Current Value</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.current_price ? formatCurrency(stock.current_price * stock.quantity, stock.currency) : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Total Cost</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.purchase_price ? formatCurrency(stock.purchase_price * stock.quantity, stock.currency) : '-'}
                  </td>
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
                    {stock.dividend_yield ? `${stock.dividend_yield.toFixed(2)}%` : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Dividend/Share</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(stock.dividend_per_share, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Annual Income</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.dividend_per_share && stock.quantity
                      ? formatCurrency(stock.dividend_per_share * stock.quantity, stock.currency)
                      : '-'}
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
          
          {upcomingDividends.length > 0 && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <h3 style={{ marginBottom: '16px' }}>Upcoming Dividends</h3>
              <table>
                <thead>
                  <tr>
                    <th>Ex-Date</th>
                    <th>Dividend Date</th>
                    <th>Amount</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingDividends.map((div, i) => (
                    <tr key={i}>
                      <td>{formatDate(div.ex_date)}</td>
                      <td>{div.payment_date ? formatDate(div.payment_date) : '-'}</td>
                      <td>{formatCurrency(div.amount, div.currency || stock.currency)}</td>
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
