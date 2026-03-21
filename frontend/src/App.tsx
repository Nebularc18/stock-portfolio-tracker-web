import { Suspense, lazy, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SettingsProvider } from './SettingsContext'
import { HeaderDataProvider } from './contexts/HeaderDataContext'
import { useAuth } from './AuthContext'
import ErrorBoundary from './components/ErrorBoundary'
import InfographicLayout from './layouts/InfographicLayout'
import Login from './pages/Login'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Stocks = lazy(() => import('./pages/Stocks'))
const Markets = lazy(() => import('./pages/Markets'))
const StockDetail = lazy(() => import('./pages/StockDetail'))
const Settings = lazy(() => import('./pages/Settings'))
const Performance = lazy(() => import('./pages/Performance'))
const Analytics = lazy(() => import('./pages/Analytics'))
const HistoricalDividends = lazy(() => import('./pages/HistoricalDividends'))
const UpcomingDividends = lazy(() => import('./pages/UpcomingDividends'))

/**
 * Root application component that provides settings context and defines the client-side routes within the InfographicLayout.
 *
 * @returns The root JSX element containing the SettingsProvider, BrowserRouter, and route configuration for the app.
 */
function App() {
  const { user } = useAuth()
  const [routeBoundaryKey, setRouteBoundaryKey] = useState(0)

  if (!user) {
    return <Login />
  }

  return (
    <HeaderDataProvider>
      <SettingsProvider>
        <BrowserRouter>
          <ErrorBoundary key={routeBoundaryKey} onRetry={() => setRouteBoundaryKey((current) => current + 1)}>
            <Suspense fallback={<div className="loading-state">Loading...</div>}>
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
            </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </SettingsProvider>
    </HeaderDataProvider>
  )
}

export default App
