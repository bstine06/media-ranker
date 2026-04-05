import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}

const api = {
    // ── Utility ────────────────────────────────────────────────────────────
    ping: (): Promise<string> => ipcRenderer.invoke("ping"),

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

    // ── Folders & files ────────────────────────────────────────────────────
    getSubfolders: (): Promise<FolderNode[]> =>
        ipcRenderer.invoke("get-subfolders"),

    getAllFiles: (): Promise<unknown[]> => ipcRenderer.invoke("get-all-files"),

    getFilesInFolder: (folderRelPath: string): Promise<unknown[]> =>
        ipcRenderer.invoke("get-files-in-folder", folderRelPath),

    getThumbnailPath: (hash: string): Promise<string | null> =>
        ipcRenderer.invoke("get-thumbnail-path", hash),

    readFolderMetadata: (folderRelPath: string) =>
        ipcRenderer.invoke("read-folder-metadata", folderRelPath),

    writeFolderMetadata: (folderRelPath: string, metadata: unknown) =>
        ipcRenderer.invoke("write-folder-metadata", folderRelPath, metadata),

    renameFolder: (oldRelPath: string, newName: string) =>
        ipcRenderer.invoke("rename-folder", oldRelPath, newName),

    openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

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

    // ── Tags ───────────────────────────────────────────────────────────────
    getTags: (fileId: number): Promise<string[]> =>
        ipcRenderer.invoke("get-tags", fileId),

    addTag: (fileId: number, tag: string): Promise<string[]> =>
        ipcRenderer.invoke("add-tag", fileId, tag),

    removeTag: (fileId: number, tag: string): Promise<string[]> =>
        ipcRenderer.invoke("remove-tag", fileId, tag),

    getAllTags: (): Promise<string[]> => ipcRenderer.invoke("get-all-tags"),

    getFileIdsByTags: (tags: string[], mode: "and" | "or"): Promise<number[]> =>
        ipcRenderer.invoke("get-file-ids-by-tags", tags, mode),

    addTagToFolder: (folderRelPath: string, tag: string): Promise<number> =>
        ipcRenderer.invoke("add-tag-to-folder", folderRelPath, tag),

    // ── Comparisons ────────────────────────────────────────────────────────
    getPair: (
        folderPrefixes: string[] | null,
    ): Promise<[unknown, unknown] | null> =>
        ipcRenderer.invoke("get-pair", folderPrefixes),

    recordComparison: (
        winnerId: number,
        loserId: number,
    ): Promise<{ newWinnerScore: number; newLoserScore: number } | null> =>
        ipcRenderer.invoke("record-comparison", winnerId, loserId),
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
