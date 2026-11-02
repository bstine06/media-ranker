import { createContext, useContext, useState, useCallback, useEffect } from "react";

interface Settings {
    hoverPreviewEnabled: boolean;
    toggleHoverPreview: () => void;
    volume: number;
    handleVolumeChange: (newVolume: number) => void;
    scrollTime: number; //260ms default
    handleScrollTimeChange: (newScrollTime: number) => void;
    tileSize: number; //200px default
    handleTileSizeChange: (newTileSize: number) => void;
    showTagCategoryNames: boolean;
    toggleShowTagCategoryNames: () => void;
    pauseWhenUnfocused: boolean;
    togglePauseWhenUnfocused: () => void;
}

const SettingsContext = createContext<Settings>({
    hoverPreviewEnabled: true,
    toggleHoverPreview: () => {},
    volume: 100,
    handleVolumeChange: (newVolume: number) => {},
    scrollTime: 260,
    handleScrollTimeChange: (newScrollTime: number) => {},
    tileSize: 200,
    handleTileSizeChange: (newTileSize: number) => {},
    showTagCategoryNames: true,
    toggleShowTagCategoryNames: () => {},
    pauseWhenUnfocused: true,
    togglePauseWhenUnfocused: () => {},
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

    const [tileSize, setTileSize] = useState(200);
    const handleTileSizeChange = useCallback((newTileSize: number) => {
        if (newTileSize < 100 || newTileSize > 300) {
            throw new RangeError(
                `tileSize must be between 100 and 300, got ${newTileSize}`
            )
        } 
        setTileSize(newTileSize);
    }, [])

    const [showTagCategoryNames, setShowTagCategoryNames] = useState<boolean>(true);
    const toggleShowTagCategoryNames = useCallback(() => {
        setShowTagCategoryNames((tgn) => !tgn)
    }, []);

    const [pauseWhenUnfocused, setPauseWhenUnfocused] = useState(true);
    const togglePauseWhenUnfocused = useCallback(() => {
        setPauseWhenUnfocused((p) => !p);
    }, []);

    // When the app loses focus (switching apps, dragging a file out into
    // another app), pause every playing video; when it comes back, resume
    // only the ones we paused. Videos the user paused stay paused.
    useEffect(() => {
        if (!pauseWhenUnfocused) return;
        const pausedByBlur = new Set<HTMLVideoElement>();
        const onBlur = () => {
            document.querySelectorAll("video").forEach((v) => {
                if (!v.paused) {
                    pausedByBlur.add(v);
                    v.pause();
                }
            });
        };
        const onFocus = () => {
            pausedByBlur.forEach((v) => {
                if (v.isConnected) v.play().catch(() => {});
            });
            pausedByBlur.clear();
        };
        window.addEventListener("blur", onBlur);
        window.addEventListener("focus", onFocus);
        return () => {
            window.removeEventListener("blur", onBlur);
            window.removeEventListener("focus", onFocus);
            // Setting turned off while unfocused: don't strand them paused.
            onFocus();
        };
    }, [pauseWhenUnfocused]);

    return (
        <SettingsContext.Provider
            value={{
                hoverPreviewEnabled,
                toggleHoverPreview,
                volume,
                handleVolumeChange,
                scrollTime,
                handleScrollTimeChange,
                tileSize,
                handleTileSizeChange,
                showTagCategoryNames,
                toggleShowTagCategoryNames,
                pauseWhenUnfocused,
                togglePauseWhenUnfocused,
            }}
        >
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
