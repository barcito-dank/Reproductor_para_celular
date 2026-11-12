import React from 'react'
import ReactDOM from 'react-dom/client'
import { initMobileBridge } from './services/mobileBridge'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './App.css'

initMobileBridge()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
