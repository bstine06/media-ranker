import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { SettingsProvider } from './contexts/SettingsContext'
import { StatusProvider } from './contexts/StatusContext'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <StatusProvider>
        <App />
      </StatusProvider>
    </SettingsProvider>
  </React.StrictMode>
)