import { DbFile, DbTag, DbFolder, DbTagCategory, ComparisonResult, PoolFilter, FilterNode, Feed, FeedHistoryEntry, TagUsage, TagCoverageRaw, PlacementBounds, TagImplication, TagImplicationPreview, FileNo, FolderNoPreview, FolderTagPreview, BatchTagResult, FolderRuleResult, HistoryItem, HistoryApplied } from "./src/shared/types/types";

export {};

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}

declare global {
    interface Window {
        api: {
            ping: () => Promise<string>;
            onProcessMessageSent: (
                callback: (data: { message: string, progress?: [number, number] }) => void,
            ) => () => void;
            /** What deleting a folder would affect (for the confirm). */
            folderDeletePreview: (folderRelPath: string) => Promise<{
                files: number;
                otherFiles: number;
                subfolders: number;
                tags: string[];
                metadata: number;
                profileImage: boolean;
            } | null>;
            /** Delete a folder: its media to Unsorted ("unsort") or the Trash. */
            deleteFolder: (
                folderRelPath: string,
                mode: "trash" | "unsort",
            ) => Promise<{ ok: true } | { error: string }>;
            /** The window's own full screen (Sweep's F). */
            setFullscreen: (on: boolean) => Promise<void>;
            onFullscreenChange: (
                callback: (isFullscreen: boolean) => void,
            ) => () => void;
            

            selectRootFolder: () => Promise<string | null>;
            openLibrary: (folderPath: string) => Promise<{
                scanned: number;
                added: number;
                updated: number;
                unsupported: number;
            }>;
            getRootPath: () => Promise<string | null>;
            onLibraryInvalid: (callback: () => void) => void;
            onLibraryScanStarted: (callback: () => void) => () => void;
            onLibraryScanned: (
                callback: (
                    result: { scanned: number; added: number } | null,
                ) => void,
            ) => () => void;
            getSubfolders: () => Promise<FolderNode[]>;
            getAllFiles: () => Promise<import("./types").DbFile[]>;
            getAllActiveFiles: () => Promise<import("./types").DbFile[]>;
            getFilesInFolder: (
                folderRelPath: string,
            ) => Promise<import("./types").DbFile[]>;
            onMediaAdded: (
                callback: (file: {
                    relativePath: string;
                    hash: string;
                    mediaType: string;
                }) => void,
            ) => () => void;

            onMediaRemoved: (
                callback: (file: { relativePath: string }) => void,
            ) => () => void;

            /** A file's content changed in place (e.g. rotated). */
            onMediaUpdated: (
                callback: (data: {
                    relativePath: string;
                    file: DbFile | undefined;
                }) => void,
            ) => () => void;
            onMediaRenamed: (
                callback: (file: {
                    oldRelativePath: string;
                    relativePath: string;
                    hash: string;
                    mediaType: string;
                }) => void,
            ) => () => void;

            onFolderRenamed: (
                callback: (data: {
                    oldRelativePath: string;
                    relativePath: string;
                }) => void,
            ) => () => void;

            onFolderRemoved: (
                callback: (data: { relativePath: string }) => void,
            ) => () => void;

            onFolderAdded: (
                callback: (data: { relativePath: string }) => void,
            ) => () => void;

            getThumbnailPath: (hash: string) => Promise<string | null>;
            getTags: (fileId: number) => Promise<DbTag[]>;
            addTag: (fileId: number, tag: string) => Promise<DbTag[]>;
            removeTag: (fileId: number, tag: string) => Promise<DbTag[]>;
            /** Tags often on the same files as this one, best first. */
            getRelatedTags: (tagId: number) => Promise<{ id: number; n: number }[]>;
            /** Sweep: time each file was on screen with this tag up. */
            addTagCheckSeconds: (tagId: number, entries: { fileId: number; seconds: number }[]) => Promise<void>;
            /** Sweep pass: the files a pass goes through for a tag
             *  (unordered). needs-firm leaves out yes, hard no, pass no. */
            getPassFiles: (
                folderPrefixes: string[] | null,
                filter: FilterNode | null,
                slot: { tagId: number; upperId: number | null },
                which: "needs-firm" | "all",
            ) => Promise<DbFile[]>;
            /** Sweep pass: how many files each slot's pass would have (in order). */
            getPassCounts: (
                folderPrefixes: string[] | null,
                filter: FilterNode | null,
                slots: { tagId: number; upperId: number | null }[],
                which: "needs-firm" | "all",
            ) => Promise<number[]>;
            /** Sweep pass: these files (order kept) that still need a firm answer. */
            prunePassList: (
                slot: { tagId: number; upperId: number | null },
                fileIds: number[],
            ) => Promise<number[]>;
            /** Sweep pass: 3 records a pass no (skipped if the file has the tag). */
            setPassNo: (fileId: number, tagId: number) => Promise<void>;
            /** Sweep pass: 2 (skip) clears a pass no. */
            clearPassNo: (fileId: number, tagId: number) => Promise<void>;
            /** Sweep pass: which of these files have a firm no for the tag
             *  (untagged only), hard (removed by hand) and/or pass. */
            getFirmNoes: (
                tagId: number,
                fileIds: number[],
            ) => Promise<{ fileId: number; hard: boolean; pass: boolean }[]>;
            /** Active files by id (order not kept), to rebuild a saved pass. */
            getFilesByIds: (fileIds: number[]) => Promise<DbFile[]>;
            /** The one unfinished Sweep pass, saved as JSON. */
            loadPassRun: () => Promise<string | null>;
            savePassRun: (state: string) => Promise<void>;
            clearPassRun: () => Promise<void>;
            /** Active files in a scope. */
            countScope: (folderPrefixes: string[] | null, filter: FilterNode | null) => Promise<number>;
            /** What per-tag coverage is worked out from (threshold applied
             *  in the renderer), over the library or a scope. */
            getTagCoverage: (
                folderPrefixes?: string[] | null,
                filter?: FilterNode | null,
            ) => Promise<TagCoverageRaw>;
            getAllTags: () => Promise<DbTag[]>;
            /** Swaps out a folder no for the same tag; refused when the
             *  folder would contradict itself. */
            addTagToFolder: (
                folderRelPath: string,
                tag: string,
            ) => Promise<FolderRuleResult>;
            getFolderNoes: (folderRelPath: string) => Promise<DbTag[]>;
            /** What adding a folder no would take off files (or why it can't). */
            previewFolderTag: (folderRelPath: string, tag: string) => Promise<FolderTagPreview | { error: string }>;
            previewFolderNo: (
                folderRelPath: string,
                tag: string,
            ) => Promise<FolderNoPreview | { error: string }>;
            addFolderNo: (folderRelPath: string, tag: string) => Promise<FolderRuleResult>;
            removeFolderNo: (folderRelPath: string, tag: string) => Promise<void>;
            /** A file's firm noes: its own and from its folder. */
            getFileNoes: (fileId: number) => Promise<FileNo[]>;
            /** Back to unchecked for that tag (hard, pass and Sweep time). */
            clearFileNo: (fileId: number, tagId: number) => Promise<void>;
            /** What a batch would do, per tag (see batchApply). */
            previewBatchApply: (
                selected: number[],
                rest: number[],
                tags: string[],
                mode: "yes" | "no",
            ) => Promise<BatchTagResult[]>;
            /** Batch Tag: selected get the tags (yes) or noes (no); the rest
             *  get the opposite where undecided. One undo entry. */
            batchApply: (
                selected: number[],
                rest: number[],
                tags: string[],
                mode: "yes" | "no",
            ) => Promise<BatchTagResult[]>;
            countFolderFiles: (folderRelPath: string) => Promise<number>;
            /** Folder tag/no → each file's own tag / no; returns file count. */
            convertFolderRule: (folderRelPath: string, tag: string, kind: "tag" | "no") => Promise<number>;
            getConflictFiles: (
                tagId: number,
                folderPrefixes?: string[] | null,
                filter?: FilterNode | null,
            ) => Promise<(DbFile & { reason: string })[]>;
            getFolderTags: (folderRelPath: string) => Promise<DbTag[]>;
            removeTagFromFolder: (
                folderRelPath: string,
                tag: string,
            ) => Promise<void>;
            getMostUsedTags: (folderId?: number) => Promise<DbTag[]>;
            getFileIdsByFilter: (filter: FilterNode | null) => Promise<number[]>;
            listFeeds: () => Promise<Feed[]>;
            createFeed: (name: string, tree: FilterNode) => Promise<{ feed: Feed } | { error: string }>;
            /** Overwrites a saved feed's filter. */
            updateFeed: (id: number, tree: FilterNode) => Promise<void>;
            renameFeed: (id: number, name: string) => Promise<{ ok: true } | { error: string }>;
            deleteFeed: (id: number) => Promise<void>;
            getFeedHistory: () => Promise<FeedHistoryEntry[]>;
            pushFeedHistory: (entry: { feedId: number } | { tree: FilterNode }) => Promise<void>;
            /** Names of saved feeds that use a tag or category. */
            feedsUsing: (ref: { tagId: number } | { categoryId: number }) => Promise<string[]>;
            /** Active files matching a filter: library-wide, and within the folders (null if none). */
            countFilter: (
                filter: FilterNode | null,
                folderPrefixes: string[] | null,
            ) => Promise<{ matches: number; total: number; inFolders: number | null }>;
            getRandomFile: (
                folderPrefixes: string[] | null,
                filter: FilterNode | null,
                excludeIds?: number[],
                /** Only files without this tag (Sweep). */
                withoutTagId?: number | null,
            ) => Promise<import("./types").DbFile | null>;
            getPair: (
                folderPrefixes: string[] | null,
                filter: FilterNode | null,
            ) => Promise<
                [import("./types").DbFile, import("./types").DbFile] | null
            >;
            /** Keeps the sides of a pair that still fit their filters, replacing the rest. */
            refitPair: (
                ids: [number, number],
                laneA: PoolFilter,
                laneB: PoolFilter,
                kingSide: "a" | "b" | null,
                recentIds: number[],
            ) => Promise<[DbFile, DbFile] | null>;
            recordComparison: (
                winnerId: number,
                loserId: number,
            ) => Promise<ComparisonResult | null>;
            getChallenger: (
                kingId: number,
                folderPrefixes: string[] | null,
                filter: FilterNode | null,
                recentIds?: number[],
            ) => Promise<DbFile | null>;
            getFolderMetadata: (
                folderRelPath: string,
            ) => Promise<{ key: string; value: string; type: string }[]>;
            setFolderMetadataField: (
                folderRelPath: string,
                key: string,
                value: string,
                type?: string,
            ) => Promise<void>;
            deleteFolderMetadataField: (
                folderRelPath: string,
                key: string,
            ) => Promise<void>;
            getMetadataFields: () => Promise<string[]>;
            setFolderProfileImage: (
                folderRelPath: string,
                hash: string | null,
            ) => Promise<void>;
            getFolder: (folderRelPath: string) => Promise<DbFolder | null>;
            renameFolder: (
                oldRelPath: string,
                newName: string,
            ) => Promise<
                { ok: true; newRelPath: string } | { ok: false; error: string }
            >;
            openExternal: (url: string) => Promise<void>;
            showInFolder: (absolutePath: string) => Promise<void>;
            createFolder: (
                name: string,
            ) => Promise<{ relativePath: string } | { error: string }>;
            /** Makes the folder and moves the files in: one undo step. */
            moveIntoNewFolder: (
                absPaths: string[],
                name: string,
            ) => Promise<{ relativePath: string; moved: number; errors: string[] } | { error: string }>;
            /** `enforceNoes`: the user agreed to lose own tags the target
             *  folder's noes rule out. */
            moveIntoFolder: (
                absPaths: string[],
                targetFolder: string,
                enforceNoes?: boolean,
            ) => Promise<{ moved: number; errors: string[] }>;
            /** Library files that would lose own tags to the target's noes. */
            previewMoveIntoFolder: (
                absPaths: string[],
                targetFolder: string,
            ) => Promise<{ absPath: string; fileId: number; filename: string; tags: string[] }[]>;
            getPathForFile: (file: File) => string;
            getSettingsSync: () => Record<string, unknown>;
            saveSettings: (settings: Record<string, unknown>) => Promise<void>;
            getRootFiles: () => Promise<DbFile[]>;
            countRootFiles: () => Promise<number>;
            fileReplace: (
                oldRelPath: string,
                newAbsPath: string,
            ) => Promise<DbFile>;
            /** Rotates a file left by quarter turns, in place; resolves to its fresh record. */
            rotateFile: (relPath: string, quarterTurns: number) => Promise<DbFile>;
            openFile: () => Promise<string | null>;
            deleteFile: (fileId: number) => Promise<void>;
            /** Several files as one undo entry; resolves to the names that failed. */
            deleteFiles: (fileIds: number[]) => Promise<string[]>;
            copyFileToClipboard: (filePath: string) => Promise<boolean>;
            dragFileOut: (file: DbFile) => void;
            dragFilesOut: (files: DbFile[]) => void;

            // Tag CRUD
            createTag: (name: string, categoryId: number | null) => Promise<DbTag>;
            updateTag: (
                id: number,
                name: string,
                categoryId: number | null,
            ) => Promise<
                | { ok: true; tag: DbTag }
                | { ok: false; conflict: DbTag & TagUsage }
            >;
            getTagUsage: (id: number) => Promise<TagUsage>;
            countMissingFiles: () => Promise<number>;
            getLibraryRanks: () => Promise<{ ranks: [number, number][]; total: number }>;
            onRanksChanged: (callback: () => void) => () => void;

            // Undo history (see main/undo.ts)
            historyList: () => Promise<HistoryItem[]>;
            historyUndo: () => Promise<HistoryApplied | null>;
            historyRedo: () => Promise<HistoryApplied | null>;
            onHistoryChanged: (callback: (items: HistoryItem[]) => void) => () => void;
            onHistoryApplied: (callback: (applied: HistoryApplied) => void) => () => void;
            /** Edit ▸ Undo / Redo (⌘Z, ⇧⌘Z) from the app menu. */
            onHistoryKey: (callback: (action: "undo" | "redo") => void) => () => void;
            deleteMissingFiles: () => Promise<number>;
            getPlacementCandidate: (
                laneA: PoolFilter,
                laneB: PoolFilter,
                matches: number,
                opponentPool?: PoolFilter,
            ) => Promise<{ file: DbFile; side: "a" | "b" } | null>;
            countPlacementCandidates: (
                laneA: PoolFilter,
                laneB: PoolFilter,
                matches: number,
            ) => Promise<number>;
            getPlacementBounds: (
                fileId: number,
                pool: PoolFilter,
                matches: number,
            ) => Promise<PlacementBounds>;
            getPlacementOpponent: (
                fileId: number,
                pool: PoolFilter,
                matches: number,
                bounds: PlacementBounds,
                recentIds: number[],
            ) => Promise<DbFile | null>;
            recordPlacement: (
                placingId: number,
                opponentId: number,
                placingWon: boolean,
                pool: PoolFilter,
                matches: number,
                bounds: PlacementBounds,
            ) => Promise<(ComparisonResult & { bounds: PlacementBounds }) | null>;
            mergeTags: (
                sourceId: number,
                targetId: number,
            ) => Promise<{ ok: true } | { ok: false; error: string }>;

            // Tag links ("kitten" implies "cat")
            getTagImplications: () => Promise<TagImplication[]>;
            previewTagImplication: (
                tagId: number,
                impliesId: number,
                action: "add" | "remove",
            ) => Promise<TagImplicationPreview | { error: string }>;
            addTagImplication: (
                tagId: number,
                impliesId: number,
            ) => Promise<{ ok: true } | { ok: false; error: string }>;
            removeTagImplication: (tagId: number, impliesId: number) => Promise<void>;
            deleteTag: (id: number) => Promise<void>;

            // Category CRUD
            getAllTagCategories: () => Promise<DbTagCategory[]>;
            createTagCategory: (name: string, color: string, icon: string) => Promise<DbTagCategory>;
            updateTagCategory: (id: number, updates: { name?: string; color?: string | null; icon?: string | null, order_index?: number, sweep?: number }) => Promise<void>;
            reorderTags: (categoryId: number | null, tagIds: number[]) => Promise<void>;
            setTagSweep: (tagId: number, on: boolean) => Promise<void>;
            setCategoryTagsSweep: (categoryId: number, on: boolean) => Promise<void>;
            deleteTagCategory: (id: number) => Promise<void>;

            // file drag out
            dragFileOut: (file: DbFile) => Promise<void>;
        };
    }
}
