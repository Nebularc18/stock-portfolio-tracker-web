import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
  onRetry?: () => void
}

type ErrorBoundaryState = {
  error: Error | null
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Route render failed:', error, errorInfo)
  }

  private handleRetry = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 28 }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '32px', textAlign: 'center' }}>
            <p role="alert" aria-live="assertive" aria-atomic="true" style={{ color: 'var(--red)', marginBottom: 12 }}>
              Failed to load this page.
            </p>
            <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
              {this.state.error.message || 'Unexpected render error'}
            </p>
            <button className="btn btn-primary" onClick={this.handleRetry}>
              Retry
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
