// File orders shared by Browse and Sweep's pass mode, so a pass goes
// through files in exactly the order Browse shows them.
import type { DbFile } from "@renderer/shared/types/types";
import type { SortMode } from "@renderer/browse/types/browserTypes";
import type { SortDirection } from "@renderer/contexts/SettingsContext";

// Each sort's natural order ("down"); the up arrow reverses it.
export const SORTS: Record<
    SortMode,
    {
        label: string;
        title: string;
        icon: string; // heroicons path
        compare: (a: DbFile, b: DbFile) => number;
        order: { down: string; up: string };
    }
> = {
    alphabetical: {
        label: "A-Z",
        title: "Sort by name",
        icon: "M3 4.5h14.25M3 9h9.75M3 13.5h9.75M3 18h9.75",
        compare: (a, b) => a.filename.localeCompare(b.filename),
        order: { down: "A to Z", up: "Z to A" },
    },
    rank: {
        label: "Rank",
        title: "Sort by rank",
        icon: "M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12",
        compare: (a, b) => b.elo_score - a.elo_score,
        order: { down: "Best first", up: "Worst first" },
    },
    compared: {
        label: "Compared",
        title: "Sort by how often each file has been compared (the least compared need ranking most)",
        icon: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
        compare: (a, b) => a.comparison_count - b.comparison_count,
        order: { down: "Fewest comparisons first", up: "Most comparisons first" },
    },
    added: {
        label: "Added",
        title: "Sort by when each file was added to the library",
        icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
        // "YYYY-MM-DD HH:MM:SS" strings sort chronologically.
        compare: (a, b) => b.date_indexed.localeCompare(a.date_indexed),
        order: { down: "Newest first", up: "Oldest first" },
    },
    fileSize: {
        label: "Size",
        title: "Sort by file size",
        icon: "M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5",
        compare: (a, b) => b.size - a.size,
        order: { down: "Largest first", up: "Smallest first" },
    },
};

/** Files in a sort's order ("down" is its natural order, "up" reverses it).
 *  Ties fall back to the filename so the order is stable. */
export function sortFiles(files: DbFile[], mode: SortMode, direction: SortDirection): DbFile[] {
    const sort = SORTS[mode] ?? SORTS.alphabetical;
    return [...files].sort((a, b) => {
        const d = sort.compare(a, b) || a.filename.localeCompare(b.filename);
        return direction === "down" ? d : -d;
    });
}

/** A pass's order: one of Browse's sorts, or shuffled (direction ignored). */
export type PassOrder = SortMode | "shuffled";

export function orderFiles(files: DbFile[], order: PassOrder, direction: SortDirection): DbFile[] {
    if (order !== "shuffled") return sortFiles(files, order, direction);
    const out = [...files];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
