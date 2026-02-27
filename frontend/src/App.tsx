import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
import InfographicLayout from './layouts/InfographicLayout'

function App() {
  return (
    <SettingsProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<InfographicLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/dividends" element={<UpcomingDividends />} />
            <Route path="/dividends/history" element={<HistoricalDividends />} />
            <Route path="/stocks" element={<Stocks />} />
            <Route path="/stocks/:ticker" element={<StockDetail />} />
            <Route path="/markets" element={<Markets />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SettingsProvider>
  )
}

export default App
