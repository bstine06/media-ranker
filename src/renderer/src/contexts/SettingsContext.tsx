import { createContext, useContext, useState, useCallback } from "react";

interface Settings {
    hoverPreviewEnabled: boolean;
    toggleHoverPreview: () => void;
    volume: number;
    handleVolumeChange: (newVolume: number) => void;
    scrollTime: number; //260ms default
    handleScrollTimeChange: (newScrollTime: number) => void;
}

const SettingsContext = createContext<Settings>({
    hoverPreviewEnabled: true,
    toggleHoverPreview: () => {},
    volume: 100,
    handleVolumeChange: (newVolume: number) => {},
    scrollTime: 260,
    handleScrollTimeChange: (newScrollTime: number) => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {

    const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState(true);
    const toggleHoverPreview = useCallback(
        () => setHoverPreviewEnabled((p) => !p),
        [],
    );

    const [volume, setVolume] = useState(100);
    const handleVolumeChange = useCallback((newVolume: number) => {
        if (newVolume < 0 || newVolume > 100) {
            throw new RangeError(
                `Volume must be between 0 and 100, got ${newVolume}`,
            );
        }
        setVolume(newVolume);
    }, []);

    const [scrollTime, setScrollTime] = useState(260);
    const handleScrollTimeChange = useCallback((newScrollTime: number) => {
        if (newScrollTime < 0 || newScrollTime > 2000) {
            throw new RangeError(
                `ScrollTime must be between 0 and 2000, got ${newScrollTime}`,
            );
        }
        setScrollTime(newScrollTime);
    }, []);

    return (
        <SettingsContext.Provider
            value={{
                hoverPreviewEnabled,
                toggleHoverPreview,
                volume,
                handleVolumeChange,
                scrollTime,
                handleScrollTimeChange
            }}
        >
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
