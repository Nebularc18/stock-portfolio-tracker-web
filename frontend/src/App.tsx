import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Stocks from './pages/Stocks'
import Markets from './pages/Markets'
import StockDetail from './pages/StockDetail'
import Settings from './pages/Settings'
import { SettingsProvider } from './SettingsContext'

function App() {
  return (
    <SettingsProvider>
      <Router>
        <div className="app">
          <nav style={{
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border-color)',
            padding: '16px 24px',
            marginBottom: '20px'
          }}>
            <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Link to="/" style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
                <h1 style={{ fontSize: '20px', fontWeight: '600' }}>Stock Portfolio</h1>
              </Link>
              <div style={{ display: 'flex', gap: '24px' }}>
                <Link to="/" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Dashboard</Link>
                <Link to="/stocks" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Stocks</Link>
                <Link to="/markets" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Markets</Link>
                <Link to="/settings" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Settings</Link>
              </div>
            </div>
          </nav>
          <div className="container">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/stocks" element={<Stocks />} />
              <Route path="/stocks/:ticker" element={<StockDetail />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </div>
      </Router>
    </SettingsProvider>
  )
}

export default App
