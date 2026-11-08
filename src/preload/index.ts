import { contextBridge, ipcRenderer, webUtils } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { DbFile, DbFolder, DbTag, DbTagCategory, getAllTagCategories } from "@main/db";
import type { PoolFilter } from "@main/elo";

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}

const api = {
    // ── Utility ────────────────────────────────────────────────────────────
    ping: (): Promise<string> => ipcRenderer.invoke("ping"),
    
    onProcessMessageSent: (
        callback: (data: {
            message: string,
            progress?: [number, number]
        }) => void,
    ) => {
        const handler = (
            _event: unknown,
            data: { message: string, progress?: [number, number] },
        ) => callback(data);
        ipcRenderer.on("process:message-sent", handler);
        return () => ipcRenderer.removeListener("process:message-sent", handler);
    },

    setFullscreen: (on: boolean): Promise<void> => ipcRenderer.invoke("set-fullscreen", on),
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
        const listener = (_: any, isFullscreen: boolean) => callback(isFullscreen);
        ipcRenderer.on('fullscreen-status', listener);
        return () => ipcRenderer.removeListener('fullscreen-status', listener);
    },
    

    // ── Library setup ──────────────────────────────────────────────────────
    selectRootFolder: (): Promise<string | null> =>
        ipcRenderer.invoke("select-root-folder"),

    openLibrary: (
        folderPath: string,
    ): Promise<{
        scanned: number;
        added: number;
        updated: number;
        unsupported: number;
    }> => ipcRenderer.invoke("open-library", folderPath),

    getRootPath: (): Promise<string | null> =>
        ipcRenderer.invoke("get-root-path"),

    onLibraryInvalid: (callback: () => void) =>
        ipcRenderer.on("library:invalid", () => callback()),

    // Background catch-up scan at launch (see get-root-path).
    onLibraryScanStarted: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.on("library:scan-started", handler);
        return () => ipcRenderer.removeListener("library:scan-started", handler);
    },
    onLibraryScanned: (
        callback: (result: { scanned: number; added: number } | null) => void,
    ) => {
        const handler = (
            _event: unknown,
            result: { scanned: number; added: number } | null,
        ) => callback(result);
        ipcRenderer.on("library:scanned", handler);
        return () => ipcRenderer.removeListener("library:scanned", handler);
    },

    // ── Folders & files ────────────────────────────────────────────────────
    getSubfolders: (): Promise<FolderNode[]> =>
        ipcRenderer.invoke("get-subfolders"),

    getAllFiles: (): Promise<unknown[]> => ipcRenderer.invoke("get-all-files"),
    getAllActiveFiles: (): Promise<unknown[]> =>
        ipcRenderer.invoke("get-all-active-files"),

    getFilesInFolder: (folderRelPath: string): Promise<unknown[]> =>
        ipcRenderer.invoke("get-files-in-folder", folderRelPath),

    getThumbnailPath: (hash: string): Promise<string | null> =>
        ipcRenderer.invoke("get-thumbnail-path", hash),

    getFolderMetadata: (
        folderRelPath: string,
    ): Promise<{ key: string; value: string; type: string }[]> =>
        ipcRenderer.invoke("get-folder-metadata", folderRelPath),

    setFolderMetadataField: (
        folderRelPath: string,
        key: string,
        value: string,
        type?: string,
    ): Promise<void> =>
        ipcRenderer.invoke(
            "set-folder-metadata-field",
            folderRelPath,
            key,
            value,
            type ?? "string",
        ),

    deleteFolderMetadataField: (
        folderRelPath: string,
        key: string,
    ): Promise<void> =>
        ipcRenderer.invoke("delete-folder-metadata-field", folderRelPath, key),

    getMetadataFields: (): Promise<string[]> =>
        ipcRenderer.invoke("get-metadata-fields"),

    setFolderProfileImage: (
        folderRelPath: string,
        hash: string | null,
    ): Promise<void> =>
        ipcRenderer.invoke("set-folder-profile-image", folderRelPath, hash),

    getFolder: (folderRelPath: string): Promise<DbFolder | null> =>
        ipcRenderer.invoke("get-folder", folderRelPath),

    renameFolder: (oldRelPath: string, newName: string) =>
        ipcRenderer.invoke("rename-folder", oldRelPath, newName),

    openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

    showInFolder: (absolutePath: string) =>
        ipcRenderer.invoke("show-in-folder", absolutePath),

    createFolder: (
        name: string,
    ): Promise<{ relativePath: string } | { error: string }> =>
        ipcRenderer.invoke("create-folder", name),

    moveIntoFolder: (
        absPaths: string[],
        targetFolder: string,
    ): Promise<{ moved: number; errors: string[] }> =>
        ipcRenderer.invoke("move-into-folder", absPaths, targetFolder),

    getSettingsSync: (): Record<string, unknown> =>
        ipcRenderer.sendSync("settings:get-sync"),
    saveSettings: (settings: Record<string, unknown>): Promise<void> =>
        ipcRenderer.invoke("settings:save", settings),

    getRootFiles: (): Promise<DbFile[]> => ipcRenderer.invoke("get-root-files"),
    countRootFiles: (): Promise<number> => ipcRenderer.invoke("count-root-files"),

    // Absolute path of a File from a drag/drop (File.path is deprecated).
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),

    fileReplace: (oldRelPath: string, newAbsPath: string): Promise<DbFile> =>
        ipcRenderer.invoke("file:replace", oldRelPath, newAbsPath),

    rotateFile: (relPath: string, quarterTurns: number): Promise<DbFile> =>
        ipcRenderer.invoke("file:rotate", relPath, quarterTurns),

    openFile: () => ipcRenderer.invoke("dialog:open-file"),

    deleteFile: (fileId: number): Promise<void> =>
        ipcRenderer.invoke("delete-file-by-id", fileId),

    copyFileToClipboard: (filePath: string): Promise<boolean> =>
        ipcRenderer.invoke("copy-file-to-clipboard", filePath),

    dragFileOut: (file: DbFile) => 
        ipcRenderer.send("drag-file-out", file),

    dragFilesOut: (files: DbFile[]) =>
        ipcRenderer.send("drag-files-out", files),

    // ── File watching ──────────────────────────────────────────────────────
    onMediaAdded: (
        callback: (file: {
            relativePath: string;
            hash: string;
            mediaType: string;
        }) => void,
    ) => {
        const handler = (
            _event: unknown,
            data: { relativePath: string; hash: string; mediaType: string },
        ) => callback(data);
        ipcRenderer.on("media:added", handler);
        return () => ipcRenderer.removeListener("media:added", handler); // returns cleanup fn
    },

    onMediaRemoved: (callback: (file: { relativePath: string }) => void) => {
        const handler = (_event: unknown, data: { relativePath: string }) =>
            callback(data);
        ipcRenderer.on("media:removed", handler);
        return () => ipcRenderer.removeListener("media:removed", handler);
    },

    onMediaRenamed: (
        callback: (file: {
            oldRelativePath: string;
            relativePath: string;
            hash: string;
            mediaType: string;
        }) => void,
    ) => {
        const handler = (
            _event: unknown,
            data: {
                oldRelativePath: string;
                relativePath: string;
                hash: string;
                mediaType: string;
            },
        ) => callback(data);
        ipcRenderer.on("media:renamed", handler);
        return () => ipcRenderer.removeListener("media:renamed", handler);
    },

    // A file's content changed in place (rotated / replaced); `file` is its
    // fresh record.
    onMediaUpdated: (
        callback: (data: { relativePath: string; file: DbFile | undefined }) => void,
    ) => {
        const handler = (
            _event: unknown,
            data: { relativePath: string; file: DbFile | undefined },
        ) => callback(data);
        ipcRenderer.on("media:updated", handler);
        return () => ipcRenderer.removeListener("media:updated", handler);
    },

    onFolderRenamed: (
        callback: (data: {
            oldRelativePath: string;
            relativePath: string;
        }) => void,
    ) => {
        const handler = (
            _event: unknown,
            data: { oldRelativePath: string; relativePath: string },
        ) => callback(data);
        ipcRenderer.on("folder:renamed", handler);
        return () => ipcRenderer.removeListener("folder:renamed", handler);
    },

    folderDeletePreview: (
        folderRelPath: string,
    ): Promise<{
        files: number;
        otherFiles: number;
        subfolders: number;
        tags: string[];
        metadata: number;
        profileImage: boolean;
    } | null> => ipcRenderer.invoke("folder:delete-preview", folderRelPath),
    deleteFolder: (
        folderRelPath: string,
        mode: "trash" | "unsort",
    ): Promise<{ ok: true } | { error: string }> =>
        ipcRenderer.invoke("folder:delete", folderRelPath, mode),
    onFolderRemoved: (callback: (data: { relativePath: string }) => void) => {
        const handler = (_event: unknown, data: { relativePath: string }) =>
            callback(data);
        ipcRenderer.on("folder:removed", handler);
        return () => ipcRenderer.removeListener("folder:removed", handler);
    },

    onFolderAdded: (callback: (data: { relativePath: string }) => void) => {
        const handler = (_event: unknown, data: { relativePath: string }) =>
            callback(data);
        ipcRenderer.on("folder:added", handler);
        return () => ipcRenderer.removeListener("folder:added", handler);
    },

    // ── Tags ───────────────────────────────────────────────────────────────
    getTags: (fileId: number): Promise<DbTag[]> =>
        ipcRenderer.invoke("get-tags", fileId),

    addTag: (fileId: number, tag: string): Promise<DbTag[]> =>
        ipcRenderer.invoke("add-tag", fileId, tag),

    removeTag: (fileId: number, tag: string): Promise<DbTag[]> =>
        ipcRenderer.invoke("remove-tag", fileId, tag),

    addTagCheckSeconds: (
        tagId: number,
        entries: { fileId: number; seconds: number }[],
    ): Promise<void> => ipcRenderer.invoke("add-tag-check-seconds", tagId, entries),

    getAllTags: (): Promise<DbTag[]> => ipcRenderer.invoke("get-all-tags"),

    getFileIdsByTags: (tags: number[], mode: "and" | "or"): Promise<number[]> =>
        ipcRenderer.invoke("get-file-ids-by-tags", tags, mode),

    getFilesByTags: (tagIds: number[], mode: "and" | "or", folderPath?: string): Promise<DbFile[]> =>
        ipcRenderer.invoke("get-files-by-tags", tagIds, mode, folderPath),

    addTagToFolder: (folderRelPath: string, tag: string): Promise<void> =>
        ipcRenderer.invoke("add-tag-to-folder", folderRelPath, tag),

    getFolderTags: (folderRelPath: string): Promise<DbTag[]> =>
        ipcRenderer.invoke("get-folder-tags", folderRelPath),

    removeTagFromFolder: (folderRelPath: string, tag: string): Promise<void> =>
        ipcRenderer.invoke("remove-tag-from-folder", folderRelPath, tag),

    getMostUsedTags: (folderId?: number): Promise<DbTag[]> =>
        ipcRenderer.invoke("get-most-used-tags", folderId),

    // ── Scroll ────────────────────────────────────────────────────────
    getRandomFile: (
        folderPrefixes: string[] | null,
        tagList: number[] | null,
        tagMode: "and" | "or",
        excludeIds: number[] = [],
        withoutTagId: number | null = null,
    ): Promise<unknown | null> =>
        ipcRenderer.invoke(
            "get-random-file",
            folderPrefixes,
            tagList,
            tagMode,
            excludeIds,
            withoutTagId,
        ),

    // ── Comparisons ────────────────────────────────────────────────────────
    getPair: (
        folderPrefixes: string[] | null,
        tagList: number[] | null,
        tagMode: "and" | "or",
    ): Promise<[unknown, unknown] | null> =>
        ipcRenderer.invoke("get-pair", folderPrefixes, tagList, tagMode),

    getLanePair: (
        laneA: unknown,
        laneB: unknown,
    ): Promise<[unknown, unknown] | null> =>
        ipcRenderer.invoke("get-lane-pair", laneA, laneB),

    refitPair: (
        ids: [number, number],
        laneA: unknown,
        laneB: unknown,
        kingSide: "a" | "b" | null,
        recentIds: number[],
    ): Promise<[unknown, unknown] | null> =>
        ipcRenderer.invoke("refit-pair", ids, laneA, laneB, kingSide, recentIds),

    recordComparison: (
        winnerId: number,
        loserId: number,
    ): Promise<unknown | null> =>
        ipcRenderer.invoke("record-comparison", winnerId, loserId),

    undoComparison: (
        comparisonId: number,
        fileIds: number[],
    ): Promise<unknown[] | null> =>
        ipcRenderer.invoke("undo-comparison", comparisonId, fileIds),

    getChallenger: (
        kingId: number,
        folderPrefixes: string[] | null,
        tagList: number[] | null,
        tagMode: "and" | "or",
        recentIds: number[] = [],
    ): Promise<unknown | null> =>
        ipcRenderer.invoke(
            "get-challenger",
            kingId,
            folderPrefixes,
            tagList,
            tagMode,
            recentIds,
        ),

    // Placement matches (main/placement.ts)
    getPlacementCandidate: (
        laneA: PoolFilter,
        laneB: PoolFilter,
        matches: number,
        opponentPool?: PoolFilter,
    ) => ipcRenderer.invoke("placement:candidate", laneA, laneB, matches, opponentPool),
    countPlacementCandidates: (laneA: PoolFilter, laneB: PoolFilter, matches: number) =>
        ipcRenderer.invoke("placement:count", laneA, laneB, matches),
    getPlacementBounds: (fileId: number, pool: PoolFilter, matches: number) =>
        ipcRenderer.invoke("placement:bounds", fileId, pool, matches),
    getPlacementOpponent: (
        fileId: number,
        pool: PoolFilter,
        matches: number,
        bounds: { lo: number; hi: number },
        recentIds: number[],
    ) => ipcRenderer.invoke("placement:opponent", fileId, pool, matches, bounds, recentIds),
    recordPlacement: (
        placingId: number,
        opponentId: number,
        placingWon: boolean,
        pool: PoolFilter,
        matches: number,
        bounds: { lo: number; hi: number },
    ) =>
        ipcRenderer.invoke(
            "placement:record",
            placingId,
            opponentId,
            placingWon,
            pool,
            matches,
            bounds,
        ),

    // Tag manager

    createTag: (
        name: string, 
        categoryId: number | null,
    ): Promise<DbTag> =>
        ipcRenderer.invoke("create-tag", name, categoryId),
    
    updateTag: (
        id: number,
        name: string,
        categoryId: number | null,
    ): Promise<
        | { ok: true; tag: DbTag }
        | { ok: false; conflict: DbTag & { files: number; folders: number } }
    > => ipcRenderer.invoke("update-tag", id, name, categoryId),

    getLibraryRanks: (): Promise<{ ranks: [number, number][]; total: number }> =>
        ipcRenderer.invoke("get-library-ranks"),
    onRanksChanged: (callback: () => void) => {
        const handler = () => callback();
        ipcRenderer.on("ranks:changed", handler);
        return () => ipcRenderer.removeListener("ranks:changed", handler);
    },
    countMissingFiles: (): Promise<number> =>
        ipcRenderer.invoke("count-missing-files"),
    deleteMissingFiles: (): Promise<number> =>
        ipcRenderer.invoke("delete-missing-files"),
    getTagUsage: (id: number): Promise<{ files: number; folders: number }> =>
        ipcRenderer.invoke("get-tag-usage", id),

    mergeTags: (
        sourceId: number,
        targetId: number,
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
        ipcRenderer.invoke("merge-tags", sourceId, targetId),

    // Tag links ("kitten" implies "cat")
    getTagImplications: (): Promise<{ tag_id: number; implies_id: number }[]> =>
        ipcRenderer.invoke("get-tag-implications"),
    previewTagImplication: (
        tagId: number,
        impliesId: number,
        action: "add" | "remove",
    ): Promise<
        | { files: number; convertedFiles: number; convertedFolders: number }
        | { error: string }
    > => ipcRenderer.invoke("preview-tag-implication", tagId, impliesId, action),
    addTagImplication: (
        tagId: number,
        impliesId: number,
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
        ipcRenderer.invoke("add-tag-implication", tagId, impliesId),
    removeTagImplication: (tagId: number, impliesId: number): Promise<void> =>
        ipcRenderer.invoke("remove-tag-implication", tagId, impliesId),

    deleteTag: (
        id: number,
    ): Promise<void> =>
        ipcRenderer.invoke("delete-tag", id),

    // Tag category manager

    getAllTagCategories: (): Promise<DbTagCategory[]> =>
        ipcRenderer.invoke("get-all-tag-categories"),

    createTagCategory: (
        name: string,
        color: string,
        icon: string
    ): Promise<DbTagCategory> =>
        ipcRenderer.invoke("create-tag-category", name, color, icon),

    updateTagCategory: (
        id: number,
        updates: {
            name?: string,
            color?: string | null,
            icon?: string | null,
            order_index?: number,
            sweep?: number
        },
    ): Promise<void> =>
        ipcRenderer.invoke("update-tag-category", id, updates),

    reorderTags: (categoryId: number | null, tagIds: number[]): Promise<void> =>
        ipcRenderer.invoke("reorder-tags", categoryId, tagIds),
    setTagSweep: (tagId: number, on: boolean): Promise<void> =>
        ipcRenderer.invoke("set-tag-sweep", tagId, on),
    setCategoryTagsSweep: (categoryId: number, on: boolean): Promise<void> =>
        ipcRenderer.invoke("set-category-tags-sweep", categoryId, on),

    deleteTagCategory: (
        id: number,
    ): Promise<void> =>
        ipcRenderer.invoke("delete-tag-category", id),
};

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld("electron", electronAPI);
        contextBridge.exposeInMainWorld("api", api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-ignore
    window.electron = electronAPI;
    // @ts-ignore
    window.api = api;
}
