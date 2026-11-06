import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { SortMode, ViewMode } from "@renderer/browse/types/browserTypes";

export type SortDirection = "up" | "down";

export const PLACEMENT_MIN = 3;
export const PLACEMENT_MAX = 30;
const PLACEMENT_DEFAULT = 10;

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
    alwaysShowUnsorted: boolean;
    toggleAlwaysShowUnsorted: () => void;
    /** Compare: play both sides' audio, not just the focused side's. */
    compareBothAudio: boolean;
    toggleCompareBothAudio: () => void;
    /** Browse's sort, direction and grid/rows choice, kept between sessions. */
    browseSortMode: SortMode;
    setBrowseSortMode: (mode: SortMode) => void;
    browseSortDirection: SortDirection;
    setBrowseSortDirection: (direction: SortDirection) => void;
    browseViewMode: ViewMode;
    setBrowseViewMode: (mode: ViewMode) => void;
    /** Compare: files with fewer than placementMatches comparisons stay on
     *  screen until they've had that many (main/placement.ts). */
    placementEnabled: boolean;
    togglePlacement: () => void;
    placementMatches: number;
    setPlacementMatches: (n: number) => void;
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
    alwaysShowUnsorted: false,
    toggleAlwaysShowUnsorted: () => {},
    compareBothAudio: false,
    toggleCompareBothAudio: () => {},
    browseSortMode: "alphabetical",
    setBrowseSortMode: () => {},
    browseSortDirection: "down",
    setBrowseSortDirection: () => {},
    browseViewMode: "grid",
    setBrowseViewMode: () => {},
    placementEnabled: false,
    togglePlacement: () => {},
    placementMatches: 10,
    setPlacementMatches: () => {},
});

// Saved settings (config.json), read once at startup. Anything missing or
// malformed falls back to the default.
const saved: Record<string, unknown> = (() => {
    try {
        return window.api.getSettingsSync() ?? {};
    } catch {
        return {};
    }
})();
const savedBool = (key: string, fallback: boolean): boolean =>
    typeof saved[key] === "boolean" ? (saved[key] as boolean) : fallback;
const savedNum = (key: string, fallback: number, min: number, max: number): number => {
    const v = saved[key];
    return typeof v === "number" && v >= min && v <= max ? v : fallback;
};
const savedOneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = saved[key];
    return allowed.includes(v as T) ? (v as T) : fallback;
};

export function SettingsProvider({ children }: { children: React.ReactNode }) {

    const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState(() => savedBool("hoverPreviewEnabled", true));
    const toggleHoverPreview = useCallback(
        () => setHoverPreviewEnabled((p) => !p),
        [],
    );

    const [volume, setVolume] = useState(() => savedNum("volume", 100, 0, 100));
    const handleVolumeChange = useCallback((newVolume: number) => {
        if (newVolume < 0 || newVolume > 100) {
            throw new RangeError(
                `Volume must be between 0 and 100, got ${newVolume}`,
            );
        }
        setVolume(newVolume);
    }, []);

    const [scrollTime, setScrollTime] = useState(() => savedNum("scrollTime", 260, 0, 2000));
    const handleScrollTimeChange = useCallback((newScrollTime: number) => {
        if (newScrollTime < 0 || newScrollTime > 2000) {
            throw new RangeError(
                `ScrollTime must be between 0 and 2000, got ${newScrollTime}`,
            );
        }
        setScrollTime(newScrollTime);
    }, []);

    const [tileSize, setTileSize] = useState(() => savedNum("tileSize", 200, 100, 300));
    const handleTileSizeChange = useCallback((newTileSize: number) => {
        if (newTileSize < 100 || newTileSize > 300) {
            throw new RangeError(
                `tileSize must be between 100 and 300, got ${newTileSize}`
            )
        } 
        setTileSize(newTileSize);
    }, [])

    const [showTagCategoryNames, setShowTagCategoryNames] = useState<boolean>(() => savedBool("showTagCategoryNames", true));
    const toggleShowTagCategoryNames = useCallback(() => {
        setShowTagCategoryNames((tgn) => !tgn)
    }, []);

    const [alwaysShowUnsorted, setAlwaysShowUnsorted] = useState(() => savedBool("alwaysShowUnsorted", false));
    const toggleAlwaysShowUnsorted = useCallback(() => {
        setAlwaysShowUnsorted((a) => !a);
    }, []);

    const [compareBothAudio, setCompareBothAudio] = useState(() => savedBool("compareBothAudio", false));
    const toggleCompareBothAudio = useCallback(() => {
        setCompareBothAudio((b) => !b);
    }, []);

    const [browseSortMode, setBrowseSortMode] = useState<SortMode>(() =>
        savedOneOf("browseSortMode", ["alphabetical", "rank", "fileSize", "added", "compared"], "alphabetical"),
    );
    const [browseSortDirection, setBrowseSortDirection] = useState<SortDirection>(() =>
        savedOneOf("browseSortDirection", ["up", "down"], "down"),
    );
    const [browseViewMode, setBrowseViewMode] = useState<ViewMode>(() =>
        savedOneOf("browseViewMode", ["grid", "rows"], "grid"),
    );

    const [placementEnabled, setPlacementEnabled] = useState(() => savedBool("placementEnabled", false));
    const togglePlacement = useCallback(() => setPlacementEnabled((p) => !p), []);
    const [placementMatches, setPlacementMatchesState] = useState(() =>
        savedNum("placementMatches", PLACEMENT_DEFAULT, PLACEMENT_MIN, PLACEMENT_MAX),
    );
    const setPlacementMatches = useCallback((n: number) => {
        if (!Number.isFinite(n)) return;
        setPlacementMatchesState(
            Math.max(PLACEMENT_MIN, Math.min(PLACEMENT_MAX, Math.round(n))),
        );
    }, []);

    const [pauseWhenUnfocused, setPauseWhenUnfocused] = useState(() => savedBool("pauseWhenUnfocused", true));
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

    // Persist (debounced so dragging a slider doesn't write on every step).
    useEffect(() => {
        const t = setTimeout(() => {
            window.api
                .saveSettings({
                    hoverPreviewEnabled,
                    volume,
                    scrollTime,
                    tileSize,
                    showTagCategoryNames,
                    pauseWhenUnfocused,
                    alwaysShowUnsorted,
                    compareBothAudio,
                    browseSortMode,
                    browseSortDirection,
                    browseViewMode,
                    placementEnabled,
                    placementMatches,
                })
                .catch(() => {});
        }, 300);
        return () => clearTimeout(t);
    }, [
        hoverPreviewEnabled,
        volume,
        scrollTime,
        tileSize,
        showTagCategoryNames,
        pauseWhenUnfocused,
        alwaysShowUnsorted,
        compareBothAudio,
        browseSortMode,
        browseSortDirection,
        browseViewMode,
        placementEnabled,
        placementMatches,
    ]);

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
                alwaysShowUnsorted,
                toggleAlwaysShowUnsorted,
                compareBothAudio,
                toggleCompareBothAudio,
                browseSortMode,
                setBrowseSortMode,
                browseSortDirection,
                setBrowseSortDirection,
                browseViewMode,
                setBrowseViewMode,
                placementEnabled,
                togglePlacement,
                placementMatches,
                setPlacementMatches,
            }}
        >
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
