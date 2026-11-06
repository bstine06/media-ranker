import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useFolders } from "./FolderContext";
import { useSettings } from "./SettingsContext";

/**
 * Every ranked file's place in the whole library (main: getLibraryRanks),
 * kept in one map so any view can show "#12" without its own query.
 * Refetched when scores change or files come and go.
 */
interface RankContextValue {
    ranks: Map<number, number>;
    /** How many files are ranked (have at least one comparison). */
    total: number;
}

const RankContext = createContext<RankContextValue>({ ranks: new Map(), total: 0 });

export function RankProvider({ children }: { children: React.ReactNode }) {
    const { rootPath } = useFolders();
    const { showLibraryRank } = useSettings();
    const [value, setValue] = useState<RankContextValue>({ ranks: new Map(), total: 0 });

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refresh = useCallback(() => {
        // Coalesce bursts (a scan, a batch delete) into one query.
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            window.api
                .getLibraryRanks()
                .then(({ ranks, total }) => setValue({ ranks: new Map(ranks), total }))
                .catch(() => {});
        }, 100);
    }, []);

    useEffect(() => {
        if (!rootPath || !showLibraryRank) return;
        refresh();
        const offs = [
            window.api.onRanksChanged(refresh),
            window.api.onMediaRemoved(refresh),
            window.api.onMediaAdded(refresh), // a missing file coming back
            window.api.onLibraryScanned(refresh),
        ];
        return () => {
            offs.forEach((off) => off());
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [rootPath, showLibraryRank, refresh]);

    return <RankContext.Provider value={value}>{children}</RankContext.Provider>;
}

/** "#12" for a ranked file, or null when it's unranked or the setting is off. */
export function useLibraryRank(fileId: number): string | null {
    const { ranks } = useContext(RankContext);
    const { showLibraryRank } = useSettings();
    if (!showLibraryRank) return null;
    const place = ranks.get(fileId);
    return place ? `#${place}` : null;
}

/** The number of ranked files, for "#12 of 340". */
export const useRankedTotal = () => useContext(RankContext).total;
