import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Stocks from './pages/Stocks'
import Markets from './pages/Markets'
import StockDetail from './pages/StockDetail'
import Settings from './pages/Settings'
import Performance from './pages/Performance'
import Analytics from './pages/Analytics'
import HistoricalDividends from './pages/HistoricalDividends'
import UpcomingDividends from './pages/UpcomingDividends'
import { SettingsProvider } from './SettingsContext'
import { HeaderDataProvider } from './contexts/HeaderDataContext'
import { useAuth } from './AuthContext'
import InfographicLayout from './layouts/InfographicLayout'
import Login from './pages/Login'

/**
 * Root application component that provides settings context and defines the client-side routes within the InfographicLayout.
 *
 * @returns The root JSX element containing the SettingsProvider, BrowserRouter, and route configuration for the app.
 */
function App() {
  const { user } = useAuth()

  if (!user) {
    return <Login />
  }

  return (
    <HeaderDataProvider>
      <SettingsProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<InfographicLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/dividends" element={<Navigate to="/dividends/history" replace />} />
              <Route path="/dividends/history" element={<HistoricalDividends />} />
              <Route path="/dividends/upcoming" element={<UpcomingDividends />} />
              <Route path="/stocks" element={<Stocks />} />
              <Route path="/stocks/:ticker" element={<StockDetail />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SettingsProvider>
    </HeaderDataProvider>
  )
}

export default App
