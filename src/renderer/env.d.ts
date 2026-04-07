import { DbFile } from "./src/types";

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
            selectRootFolder: () => Promise<string | null>;
            openLibrary: (folderPath: string) => Promise<{
                scanned: number;
                added: number;
                updated: number;
                unsupported: number;
            }>;
            getRootPath: () => Promise<string | null>;
            getSubfolders: () => Promise<FolderNode[]>;
            getAllFiles: () => Promise<import("./types").DbFile[]>;
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
            getThumbnailPath: (hash: string) => Promise<string | null>;
            getTags: (fileId: number) => Promise<string[]>;
            addTag: (fileId: number, tag: string) => Promise<string[]>;
            removeTag: (fileId: number, tag: string) => Promise<string[]>;
            getAllTags: () => Promise<string[]>;
            getFileIdsByTags: (
                tags: string[],
                mode: "and" | "or",
            ) => Promise<number[]>;
            addTagToFolder: (
                folderRelPath: string,
                tag: string,
            ) => Promise<number>;
            getPair: (
                folderPrefixes: string[] | null,
                tagList: string[] | null,
                tagMode: "and" | "or",
            ) => Promise<
                [import("./types").DbFile, import("./types").DbFile] | null
            >;
            recordComparison: (
                winnerId: number,
                loserId: number,
                margin: number,
            ) => Promise<{
                newWinnerScore: number;
                newLoserScore: number;
            } | null>;
            readFolderMetadata: (
                folderRelPath: string,
            ) => Promise<
                import("./components/BrowseView").FolderMetadata | null
            >;
            writeFolderMetadata: (
                folderRelPath: string,
                metadata: import("./components/BrowseView").FolderMetadata,
            ) => Promise<void>;
            renameFolder: (
                oldRelPath: string,
                newName: string,
            ) => Promise<
                { ok: true; newRelPath: string } | { ok: false; error: string }
            >;
            openExternal: (url: string) => Promise<void>;
            showInFolder: (absolutePath: string) => Promise<void>;
            moveFilesTo: (filePaths: string[], targetDir: string) => Promise<void>;
            fileReplace: (oldRelPath: string, newAbsPath: string) => Promise<DbFile>;
            openFile: (extensions: string[]) => Promise<string | null>;
        };
    }
}
