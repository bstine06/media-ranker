import { DbFile, DbTag, DbFolder, DbTagCategory, ComparisonResult, PoolFilter, TagUsage } from "./src/shared/types/types";

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
            getAllTags: () => Promise<DbTag[]>;
            addTagToFolder: (
                folderRelPath: string,
                tag: string,
            ) => Promise<void>;
            getFolderTags: (folderRelPath: string) => Promise<DbTag[]>;
            removeTagFromFolder: (
                folderRelPath: string,
                tag: string,
            ) => Promise<void>;
            getMostUsedTags: (folderId?: number) => Promise<DbTag[]>;
            getFileIdsByTags: (
                tags: number[],
                mode: "and" | "or",
            ) => Promise<number[]>;
            getRandomFile: (
                folderPrefixes: string[] | null,
                tagList: number[] | null,
                tagMode: "and" | "or",
                excludeIds: number[] = [],
            ) => Promise<import("./types").DbFile | null>;
            getPair: (
                folderPrefixes: string[] | null,
                tagList: number[] | null,
                tagMode: "and" | "or",
            ) => Promise<
                [import("./types").DbFile, import("./types").DbFile] | null
            >;
            /** A pair with the left file from laneA's pool, the right from laneB's. */
            getLanePair: (
                laneA: PoolFilter,
                laneB: PoolFilter,
            ) => Promise<[DbFile, DbFile] | null>;
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
            /** Reverts a comparison, then returns the given files' fresh rows. */
            undoComparison: (
                comparisonId: number,
                fileIds: number[],
            ) => Promise<(DbFile | undefined)[] | null>;
            getChallenger: (
                kingId: number,
                folderPrefixes: string[] | null,
                tagList: number[] | null,
                tagMode: "and" | "or",
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
            moveIntoFolder: (
                absPaths: string[],
                targetFolder: string,
            ) => Promise<{ moved: number; errors: string[] }>;
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
            mergeTags: (sourceId: number, targetId: number) => Promise<void>;
            deleteTag: (id: number) => Promise<void>;

            // Category CRUD
            getAllTagCategories: () => Promise<DbTagCategory[]>;
            createTagCategory: (name: string, color: string, icon: string) => Promise<DbTagCategory>;
            updateTagCategory: (id: number, updates: { name?: string; color?: string | null; icon?: string | null, order_index?: number }) => Promise<void>;
            deleteTagCategory: (id: number) => Promise<void>;

            // file drag out
            dragFileOut: (file: DbFile) => Promise<void>;
        };
    }
}
