import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './ThemeContext'
import { HeaderDataProvider } from './contexts/HeaderDataContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <HeaderDataProvider>
        <App />
      </HeaderDataProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
