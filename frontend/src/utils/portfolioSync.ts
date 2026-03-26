const PORTFOLIO_DATA_UPDATED_EVENT = 'portfolio-data-updated'
const DASHBOARD_DATA_CACHE_STORAGE_KEY = 'dashboard.data'
const DASHBOARD_HISTORY_CACHE_STORAGE_KEY = 'dashboard.history'

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function invalidatePortfolioCaches(): void {
  const storage = getStorage()
  if (!storage) return

  const keysToRemove: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key) continue
    if (key.startsWith(`${DASHBOARD_DATA_CACHE_STORAGE_KEY}:`) || key.startsWith(`${DASHBOARD_HISTORY_CACHE_STORAGE_KEY}:`)) {
      keysToRemove.push(key)
    }
  }

  for (const key of keysToRemove) {
    storage.removeItem(key)
  }
}

export function notifyPortfolioDataUpdated(): void {
  invalidatePortfolioCaches()
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(PORTFOLIO_DATA_UPDATED_EVENT))
}

export function subscribeToPortfolioDataUpdates(onUpdate: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  window.addEventListener(PORTFOLIO_DATA_UPDATED_EVENT, onUpdate)
  return () => {
    window.removeEventListener(PORTFOLIO_DATA_UPDATED_EVENT, onUpdate)
  }
}
