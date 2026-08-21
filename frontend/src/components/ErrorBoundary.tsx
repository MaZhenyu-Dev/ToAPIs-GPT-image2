import { Component, type ErrorInfo, type ReactNode } from 'react'
import GlassButton from './ui/GlassButton'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 捕获到渲染错误:', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <div className="glass glass-card-padding--lg" style={{ textAlign: 'center' }}>
          <h2 style={{ marginTop: 0, color: 'var(--danger)' }}>页面出现错误</h2>
          <p style={{ color: 'var(--text-2)', wordBreak: 'break-word' }}>
            {this.state.error?.message || '未知错误，请尝试刷新页面。'}
          </p>
          <GlassButton variant="primary" onClick={this.handleReload}>
            刷新页面
          </GlassButton>
        </div>
      )
    }
    return this.props.children
  }
}
