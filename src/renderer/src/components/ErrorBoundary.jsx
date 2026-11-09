import React from 'react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    console.error('[ErrorBoundary] Error no capturado en interfaz React:', error, errorInfo)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    window.location.reload()
  }

  handleDismiss = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(15, 15, 19, 0.96)',
          color: '#f0f0f5',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '24px',
          zIndex: 99999,
          textAlign: 'center'
        }}>
          <div style={{
            maxWidth: '520px',
            backgroundColor: '#1b1b24',
            border: '1px solid #36364a',
            borderRadius: '16px',
            padding: '32px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)'
          }}>
            <div style={{ fontSize: '42px', marginBottom: '16px' }}>⚠️</div>
            <h2 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 8px 0' }}>
              Se produjo un error inesperado
            </h2>
            <p style={{ color: '#a0a0b8', fontSize: '14px', lineHeight: 1.5, margin: '0 0 20px 0' }}>
              La interfaz visual ha capturado un error sin interrumpir el proceso de audio. Puedes recargar la vista para continuar.
            </p>

            {this.state.error && (
              <pre style={{
                backgroundColor: '#111116',
                border: '1px solid #292938',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '12px',
                color: '#ff7b72',
                textAlign: 'left',
                overflowX: 'auto',
                maxHeight: '140px',
                marginBottom: '24px'
              }}>
                {this.state.error.toString()}
              </pre>
            )}

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={this.handleDismiss}
                style={{
                  background: 'transparent',
                  color: '#cfcfe6',
                  border: '1px solid #424258',
                  padding: '10px 18px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: 500,
                  fontSize: '14px'
                }}
              >
                Ignorar
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                style={{
                  background: '#6366f1',
                  color: '#ffffff',
                  border: 'none',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '14px'
                }}
              >
                Recargar Interfaz
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
