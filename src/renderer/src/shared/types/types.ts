export type View = "browse" | "compare" | "file" | "sweep" | "pass" | "tag-manager";

export interface DbFile {
    id: number;
    content_hash: string;
    path: string;
    filename: string;
    media_type: "photo" | "gif" | "video";
    elo_score: number;
    comparison_count: number;
    date_indexed: string;
    mtime: number;
    size: number;
    status: "active" | "missing";
    missing_since: string | null;
    folder_id?: number | null;
}

export interface DbTag {
    id: number;
    name: string;
    category_id: number | null;
    /** Position within its category (Tag Manager, quick tags). */
    order_index: number;
    /** 1: offered in Sweep (if its category is too). */
    sweep: number;
    /** On a file's (or folder's) tag list: it comes from the file's folder
     *  or is implied by another tag, so it can only be removed at its source. */
    inherited?: boolean;
    /** With `inherited`: the tag that implies it. Absent: from the folder. */
    inheritedVia?: string;
    /** On a file's tag list: a no disagrees with it (says which). */
    conflict?: string;
}

/** A firm no on a file: its own (`hard`: taken off or a batch no; `pass`:
 *  from a pass), and/or from its folder (`folder`, with `via` the folder no
 *  it follows from when this tag implies it). */
export interface FileNo extends DbTag {
    hard: boolean;
    pass: boolean;
    folder?: string;
    via?: string;
}

export type FolderRuleResult = { ok: true } | { ok: false; error: string };

/** What adding a folder no would take off the folder's files. */
export interface FolderNoPreview {
    /** It replaces the folder's tag of the same name. */
    swap: boolean;
    removed: { name: string; files: number }[];
    files: number;
}

/** A folder rule a batch clashes with: a folder tag giving a tag being
 *  marked no, or a folder no ruling out a tag being added. Confirmed, it
 *  comes off the folder and the folder's other files keep what it gave
 *  them as their own. */
export interface FolderRuleClash {
    folderId: number;
    folder: string;
    tagId: number;
    tag: string;
    kind: "tag" | "no";
    /** Files in the folder outside the batch. */
    others: number;
}

/** What a batch no would do (or did). */
export interface BatchNoPreview {
    removed: { name: string; files: number }[];
    files: number;
    /** Folder tags that come off their folders first. */
    folderRules: FolderRuleClash[];
}

export interface DbTagCategory {
    id: number;
    name: string;
    color: string;
    icon: string;
    order_index: number;
    /** 1: its tags can be offered in Sweep (0 overrides theirs). */
    sweep: number;
}

export interface DbTagWithCategory extends DbTag {
    category: DbTagCategory | null;
}

export interface DbFolder {
    id: number;
    path: string;
    name: string;
    profile_image_hash: string | null;
    date_added: string;
}

export interface DbFolderMetadata {
    key: string;
    value: string;
    type: "string" | "number" | "date" | "url";
}

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}

export type TagGroup = {
    label: string;
    color: string | null;
    icon: string | null;
    tags: DbTagWithCategory[];
    categoryId: number | null;
    orderIndex?: number;
};

export function isDbTag(value: any): value is DbTag {
    return (
        value &&
        typeof value === 'object' &&
        typeof value.id === 'number' &&
        typeof value.name === 'string' &&
        (typeof value.category_id === 'number' || value.category_id === null)
    );
}

export function isDbTagArray(value: any): value is DbTag[] {
    return Array.isArray(value) && value.every(isDbTag);
}
/** Where a tag-count item counts from: every tag, uncategorized ones, or a category id. */
export type CountFrom = "all" | "uncategorized" | number;

/**
 * The tag filter, as a tree (mirrors main/tagFilter.ts). A group joins its
 * items with one word, AND or OR; any node can be WITHOUT (inverted).
 */
export type FilterNode =
    | { kind: "group"; op: "and" | "or"; items: FilterNode[]; without?: boolean }
    | { kind: "tag"; id: number; without?: boolean }
    | { kind: "count"; op: "<" | "=" | ">"; n: number; from: CountFrom; without?: boolean };

export type FilterGroup = Extract<FilterNode, { kind: "group" }>;

/** A saved filter. */
export interface Feed {
    id: number;
    name: string;
    tree: FilterNode;
}

/** A recently applied filter: a saved feed (feedId, name) or an unsaved tree. */
export interface FeedHistoryEntry {
    id: number;
    feedId: number | null;
    name: string | null;
    tree: FilterNode;
}

/** What one side of Compare draws its files from. */
export interface PoolFilter {
    folderPrefixes: string[] | null;
    filter: FilterNode | null;
}

export interface ComparisonResult {
    comparisonId: number;
    newWinnerScore: number;
    newLoserScore: number;
    winner: DbFile;
    loser: DbFile;
    winnerRank: { before: number; after: number };
    loserRank: { before: number; after: number };
}

/** Placement: where the file being placed may rank in its opponent pool,
 *  as fractions from the top (0 = best, 1 = worst). See main/placement.ts. */
export interface PlacementBounds {
    lo: number;
    hi: number;
}

/** How widely a tag is used (for confirm dialogs). */
/** "kitten" (tag_id) implies "cat" (implies_id). */
export interface TagImplication {
    tag_id: number;
    implies_id: number;
}

/** What adding or removing a tag link would do. */
export interface TagImplicationPreview {
    /** Active files that gain the implied tag (negative: lose it). */
    files: number;
    /** Active files whose own copy becomes inherited (adding only). */
    convertedFiles: number;
    /** Folders whose own copy becomes inherited (adding only). */
    convertedFolders: number;
}

/** What coverage is worked out from (see getTagCoverage). */
export interface TagCoverageRaw {
    /** Active files in scope (the library, or a selection) — the whole
     *  for every tag's share. */
    files: number;
    tags: {
        tagId: number;
        /** Files that have the tag. */
        yes: number;
        /** Untagged files with a firm no: the tag was taken off, or they
         *  were stepped past in a pass. */
        firmNo: number;
        /** The other untagged files with Sweep time: [whole seconds, files],
         *  seconds capped at the threshold's max (30). */
        seen: [number, number][];
        /** Files where a no and a yes disagree (see getConflictFiles). */
        conflicts: number;
    }[];
}

/** How many files have been checked for each tag, at the current
 *  seconds threshold. no = firmNo + seen. */
export interface TagCoverage {
    files: number;
    tags: {
        tagId: number;
        yes: number;
        firmNo: number;
        seen: number;
        no: number;
        conflicts: number;
    }[];
}

export interface TagUsage {
    /** Files that have it, their own or from their folder. */
    files: number;
    /** Folders that give it to their files. */
    folders: number;
}

// ── Undo history (main/undo.ts) ──
export interface HistoryItem {
    id: number;
    label: string;
    /** Undone: shown dimmed above the "you are here" line, can be redone. */
    undone: boolean;
}

export type HistoryMeta =
    | { kind: "compare"; winnerId: number; loserId: number }
    | { kind: "placement"; placingId: number; opponentId: number };

export interface HistoryApplied {
    direction: "undo" | "redo";
    label: string;
    meta?: HistoryMeta;
    /** Couldn't be done; the history was cut back there. */
    error?: string;
}
