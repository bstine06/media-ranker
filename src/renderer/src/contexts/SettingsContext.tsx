import { createContext, useContext, useState, useCallback } from 'react'

interface Settings {
  hoverPreviewEnabled: boolean
  toggleHoverPreview: () => void
}

const SettingsContext = createContext<Settings>({
  hoverPreviewEnabled: true,
  toggleHoverPreview: () => {},
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState(true)
  const toggleHoverPreview = useCallback(() => setHoverPreviewEnabled(p => !p), [])

  return (
    <SettingsContext.Provider value={{ hoverPreviewEnabled, toggleHoverPreview }}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)