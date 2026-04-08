// ─── Types ────────────────────────────────────────────────────────────────────

export interface FolderMetadata {
    profileImage?: string;
    fields?: { key: string; value: string }[];
    tags?: string[];
}

export const URL_RE = /^https?:\/\//i;

export type ViewMode = "grid" | "rows";
export type SortMode = "default" | "rank";