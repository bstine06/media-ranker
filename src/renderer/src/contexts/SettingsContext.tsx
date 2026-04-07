import { createContext, useContext, useState, useCallback } from 'react'

interface Settings {
  hoverPreviewEnabled: boolean
  toggleHoverPreview: () => void
  volume: number,
  handleVolumeChange: (newVolume: number) => void;
}

const SettingsContext = createContext<Settings>({
  hoverPreviewEnabled: true,
  toggleHoverPreview: () => {},
  volume: 100,
  handleVolumeChange: (newVolume: number) => {}
})

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState(true)
  const toggleHoverPreview = useCallback(() => setHoverPreviewEnabled(p => !p), [])
  const [volume, setVolume] = useState(100);
  const handleVolumeChange = useCallback((newVolume: number) => {
    if (newVolume < 0 || newVolume > 100) {
    throw new RangeError(`Volume must be between 0 and 100, got ${newVolume}`);
  }
  setVolume(newVolume);
  }, []);

  return (
    <SettingsContext.Provider value={{ hoverPreviewEnabled, toggleHoverPreview, volume, handleVolumeChange }}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)