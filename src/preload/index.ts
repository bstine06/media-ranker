import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { DbFile, DbFolder, DbTag } from "@main/db";

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

    moveFilesTo: (filePaths: string[], targetDir: string) =>
        ipcRenderer.invoke("move-files-to", filePaths, targetDir),

    fileReplace: (oldRelPath: string, newAbsPath: string): Promise<DbFile> =>
        ipcRenderer.invoke("file:replace", oldRelPath, newAbsPath),

    openFile: (extensions: string[]) =>
        ipcRenderer.invoke("dialog:open-file", extensions),

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

    // ── Scroll ────────────────────────────────────────────────────────
    getRandomFile: (
        folderPrefixes: string[] | null,
        tagList: number[] | null,
        tagMode: "and" | "or",
        excludeIds: number[] = [],
    ): Promise<unknown | null> =>
        ipcRenderer.invoke(
            "get-random-file",
            folderPrefixes,
            tagList,
            tagMode,
            excludeIds,
        ),

    // ── Comparisons ────────────────────────────────────────────────────────
    getPair: (
        folderPrefixes: string[] | null,
        tagList: number[] | null,
        tagMode: "and" | "or",
    ): Promise<[unknown, unknown] | null> =>
        ipcRenderer.invoke("get-pair", folderPrefixes, tagList, tagMode),

    recordComparison: (
        winnerId: number,
        loserId: number,
        margin: number,
    ): Promise<{ newWinnerScore: number; newLoserScore: number } | null> =>
        ipcRenderer.invoke("record-comparison", winnerId, loserId, margin),
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
