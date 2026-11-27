import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { SortMode, ViewMode } from "@renderer/browse/types/browserTypes";
import type { PassOrder } from "@renderer/lib/sorts";
import { isMixed, setAway } from "@renderer/lib/audioMix";

export type SortDirection = "up" | "down";

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
    /** The undo history drawer, docked on the right. */
    showHistory: boolean;
    toggleShowHistory: () => void;
    /** Show each file's place in the whole library (#12) wherever it appears. */
    showLibraryRank: boolean;
    toggleShowLibraryRank: () => void;
    /** Compare: play both sides' audio, not just the focused side's. */
    compareBothAudio: boolean;
    /** Sweep (X): every video on screen heard, not just the pointer's. */
    sweepAllAudio: boolean;
    toggleSweepAllAudio: () => void;
    /** Free sweep skips files with a firm answer for the tag (tagged, hard
     *  no, pass no); off, it shows everything. */
    sweepSkipAnswered: boolean;
    toggleSweepSkipAnswered: () => void;
    /** Pass: how fast holding 4 plays the current video (2–10×). */
    passFfFactor: number;
    setPassFfFactor: (n: number) => void;
    toggleCompareBothAudio: () => void;
    /** Browse's sort, direction and grid/rows choice, kept between sessions. */
    browseSortMode: SortMode;
    setBrowseSortMode: (mode: SortMode) => void;
    browseSortDirection: SortDirection;
    setBrowseSortDirection: (direction: SortDirection) => void;
    browseViewMode: ViewMode;
    setBrowseViewMode: (mode: ViewMode) => void;
    /** Sweep: the tag being swept, whether it's picked at random, and how
     *  often a random one is rerolled (seconds). */
    sweepTagId: number | null;
    setSweepTagId: (id: number | null) => void;
    sweepRandom: boolean;
    setSweepRandom: (on: boolean) => void;
    sweepInterval: number;
    setSweepInterval: (seconds: number) => void;
    /** Strip scroll speed, px per second. */
    sweepSpeed: number;
    setSweepSpeed: (speed: number) => void;
    /** Sweep's extra lanes run slightly faster / slower than the top one. */
    sweepVarispeed: boolean;
    toggleSweepVarispeed: () => void;
    /** Scrubbing in Sweep stops the lanes until 3 (off: they pick up again
     *  1 s after the last scrub). */
    sweepScrubHold: boolean;
    toggleSweepScrubHold: () => void;
    /** Sweep's 1 / 3 (and edge zones) move every lane, not just the
     *  one under the cursor. */
    sweepAllLanes: boolean;
    toggleSweepAllLanes: () => void;
    /** Tag coverage: seconds a file must be on screen in Sweep with a tag up
     *  (and not tagged) to count as a no for that tag. */
    coverageSeconds: number;
    /** Coverage tab: the whole library, or the current folders + filter. */
    coverageScope: "library" | "selection";
    setCoverageScope: (scope: "library" | "selection") => void;
    /** Sweep pass: the order files come in (Browse's sorts, or shuffled). */
    passOrder: PassOrder;
    setPassOrder: (order: PassOrder) => void;
    passDirection: SortDirection;
    /** The left sidebar's and the file view's tag panel's widths (px),
     *  set by dragging their edges. */
    sidebarWidth: number;
    setSidebarWidth: (px: number) => void;
    tagPanelWidth: number;
    setTagPanelWidth: (px: number) => void;
    setPassDirection: (direction: SortDirection) => void;
    setCoverageSeconds: (seconds: number) => void;
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
    showHistory: false,
    toggleShowHistory: () => {},
    showLibraryRank: true,
    toggleShowLibraryRank: () => {},
    compareBothAudio: false,
    sweepAllAudio: false,
    toggleSweepAllAudio: () => {},
    sweepSkipAnswered: true,
    toggleSweepSkipAnswered: () => {},
    passFfFactor: 2,
    setPassFfFactor: () => {},
    toggleCompareBothAudio: () => {},
    browseSortMode: "alphabetical",
    setBrowseSortMode: () => {},
    browseSortDirection: "down",
    setBrowseSortDirection: () => {},
    browseViewMode: "grid",
    setBrowseViewMode: () => {},
    sweepTagId: null,
    setSweepTagId: () => {},
    sweepRandom: false,
    setSweepRandom: () => {},
    sweepInterval: 60,
    setSweepInterval: () => {},
    sweepSpeed: 90,
    setSweepSpeed: () => {},
    sweepVarispeed: false,
    toggleSweepVarispeed: () => {},
    sweepScrubHold: false,
    toggleSweepScrubHold: () => {},
    sweepAllLanes: false,
    toggleSweepAllLanes: () => {},
    coverageSeconds: 6,
    coverageScope: "library",
    setCoverageScope: () => {},
    passOrder: "alphabetical",
    setPassOrder: () => {},
    passDirection: "down",
    sidebarWidth: 208,
    setSidebarWidth: () => {},
    tagPanelWidth: 288,
    setTagPanelWidth: () => {},
    setPassDirection: () => {},
    setCoverageSeconds: () => {},
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

    const [showLibraryRank, setShowLibraryRank] = useState(() => savedBool("showLibraryRank", true));
    const toggleShowLibraryRank = useCallback(() => setShowLibraryRank((s) => !s), []);
    const [alwaysShowUnsorted, setAlwaysShowUnsorted] = useState(() => savedBool("alwaysShowUnsorted", false));
    const toggleAlwaysShowUnsorted = useCallback(() => {
        setAlwaysShowUnsorted((a) => !a);
    }, []);

    const [showHistory, setShowHistory] = useState(() => savedBool("showHistory", false));
    const toggleShowHistory = useCallback(() => setShowHistory((s) => !s), []);

    const [compareBothAudio, setCompareBothAudio] = useState(() => savedBool("compareBothAudio", false));
    const [sweepAllAudio, setSweepAllAudio] = useState(() => savedBool("sweepAllAudio", false));
    const toggleSweepAllAudio = useCallback(() => setSweepAllAudio((a) => !a), []);
    const [sweepSkipAnswered, setSweepSkipAnswered] = useState(() => savedBool("sweepSkipAnswered", true));
    const toggleSweepSkipAnswered = useCallback(() => setSweepSkipAnswered((a) => !a), []);
    const [passFfFactor, setPassFfFactor] = useState(() => savedNum("passFfFactor", 2, 2, 10));
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

    const [sweepTagId, setSweepTagId] = useState<number | null>(() =>
        typeof saved.sweepTagId === "number" ? saved.sweepTagId : null,
    );
    const [sweepRandom, setSweepRandom] = useState(() => savedBool("sweepRandom", false));
    const [sweepInterval, setSweepInterval] = useState(() => savedNum("sweepInterval", 60, 5, 3600));
    const [sweepSpeed, setSweepSpeed] = useState(() => savedNum("sweepSpeed", 90, 20, 1000));
    const [sweepVarispeed, setSweepVarispeed] = useState(() => savedBool("sweepVarispeed", false));
    const toggleSweepVarispeed = useCallback(() => setSweepVarispeed((v) => !v), []);
    const [sweepScrubHold, setSweepScrubHold] = useState(() => savedBool("sweepScrubHold", false));
    const toggleSweepScrubHold = useCallback(() => setSweepScrubHold((v) => !v), []);
    const [sweepAllLanes, setSweepAllLanes] = useState(() => savedBool("sweepAllLanes", false));
    const toggleSweepAllLanes = useCallback(() => setSweepAllLanes((v) => !v), []);
    // Max 30: getTagCoverage groups Sweep time up to 30 s.
    const [coverageSeconds, setCoverageSeconds] = useState(() => savedNum("coverageSeconds", 6, 1, 30));
    const [coverageScope, setCoverageScope] = useState<"library" | "selection">(() =>
        savedOneOf("coverageScope", ["library", "selection"], "library"),
    );
    const [passOrder, setPassOrder] = useState<PassOrder>(() =>
        savedOneOf(
            "passOrder",
            ["alphabetical", "rank", "fileSize", "added", "compared", "shuffled"],
            "alphabetical",
        ),
    );
    const [passDirection, setPassDirection] = useState<SortDirection>(() =>
        savedOneOf("passDirection", ["up", "down"], "down"),
    );
    const [sidebarWidth, setSidebarWidth] = useState(() => savedNum("sidebarWidth", 208, 208, 400));
    const [tagPanelWidth, setTagPanelWidth] = useState(() => savedNum("tagPanelWidth", 288, 200, 600));

    const [pauseWhenUnfocused, setPauseWhenUnfocused] = useState(() => savedBool("pauseWhenUnfocused", true));
    const togglePauseWhenUnfocused = useCallback(() => {
        setPauseWhenUnfocused((p) => !p);
    }, []);

    // When the app loses focus (switching apps, dragging a file out into
    // another app), pause every playing video; when it comes back, resume
    // only the ones we paused. Videos the user paused stay paused. Sweep's
    // and Pass's lanes keep playing instead, with their sound faded out
    // until the window is back: mixed videos, unless their media layer
    // player says to pause (data-when-away, a spot setting).
    useEffect(() => {
        if (!pauseWhenUnfocused) return;
        const pausedByBlur = new Set<HTMLVideoElement>();
        const onBlur = () => {
            setAway(true);
            document.querySelectorAll("video").forEach((v) => {
                if (!v.paused && (!isMixed(v) || v.closest('[data-when-away="pause"]'))) {
                    pausedByBlur.add(v);
                    v.pause();
                }
            });
        };
        const onFocus = () => {
            setAway(false);
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
                    showHistory,
                    showLibraryRank,
                    compareBothAudio,
                    sweepAllAudio,
                    sweepSkipAnswered,
                    passFfFactor,
                    browseSortMode,
                    browseSortDirection,
                    browseViewMode,
                    sweepTagId,
                    sweepRandom,
                    sweepInterval,
                    sweepSpeed,
                    sweepVarispeed,
                    sweepScrubHold,
                    sweepAllLanes,
                    coverageSeconds,
                    coverageScope,
                    passOrder,
                    passDirection,
                    sidebarWidth,
                    tagPanelWidth,
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
        showHistory,
        showLibraryRank,
        compareBothAudio,
        sweepAllAudio,
        sweepSkipAnswered,
        passFfFactor,
        browseSortMode,
        browseSortDirection,
        browseViewMode,
        sweepTagId,
        sweepRandom,
        sweepInterval,
        sweepSpeed,
        sweepVarispeed,
        sweepScrubHold,
        sweepAllLanes,
        coverageSeconds,
        coverageScope,
        passOrder,
        passDirection,
        sidebarWidth,
        tagPanelWidth,
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
                showHistory,
                toggleShowHistory,
                showLibraryRank,
                toggleShowLibraryRank,
                compareBothAudio,
                sweepAllAudio,
                toggleSweepAllAudio,
                sweepSkipAnswered,
                toggleSweepSkipAnswered,
                passFfFactor,
                setPassFfFactor,
                toggleCompareBothAudio,
                browseSortMode,
                setBrowseSortMode,
                browseSortDirection,
                setBrowseSortDirection,
                browseViewMode,
                setBrowseViewMode,
                sweepTagId,
                setSweepTagId,
                sweepRandom,
                setSweepRandom,
                sweepInterval,
                setSweepInterval,
                sweepSpeed,
                setSweepSpeed,
                sweepVarispeed,
                toggleSweepVarispeed,
                sweepScrubHold,
                toggleSweepScrubHold,
                sweepAllLanes,
                toggleSweepAllLanes,
                coverageSeconds,
                setCoverageSeconds,
                coverageScope,
                setCoverageScope,
                passOrder,
                setPassOrder,
                passDirection,
                setPassDirection,
                sidebarWidth,
                setSidebarWidth,
                tagPanelWidth,
                setTagPanelWidth,
            }}
        >
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => useContext(SettingsContext);
