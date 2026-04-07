// contexts/StatusContext.tsx
import { createContext, useContext, useState } from 'react'

type StatusContext = {
  status: string
  setStatus: (msg: string) => void
  resetStatus: () => void
}

const StatusContext = createContext<StatusContext | null>(null)

export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState('Ready');
  const resetStatus = () => setStatus("Ready");
  return (
    <StatusContext.Provider value={{ status, setStatus, resetStatus }}>
      {children}
    </StatusContext.Provider>
  )
}

export function useStatus() {
  const ctx = useContext(StatusContext)
  if (!ctx) throw new Error('useStatus must be used within StatusProvider')
  return ctx
}