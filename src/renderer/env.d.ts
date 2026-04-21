import { DbFile, DbTag, DbFolder, DbTagCategory } from "./src/shared/types/types";

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

            selectRootFolder: () => Promise<string | null>;
            openLibrary: (folderPath: string) => Promise<{
                scanned: number;
                added: number;
                updated: number;
                unsupported: number;
            }>;
            getRootPath: () => Promise<string | null>;
            onLibraryInvalid: (callback: () => void) => void;
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
            recordComparison: (
                winnerId: number,
                loserId: number,
                margin: number,
            ) => Promise<{
                newWinnerScore: number;
                newLoserScore: number;
            } | null>;
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
            moveFilesTo: (
                filePaths: string[],
                targetDir: string,
            ) => Promise<void>;
            fileReplace: (
                oldRelPath: string,
                newAbsPath: string,
            ) => Promise<DbFile>;
            openFile: (extensions: string[]) => Promise<string | null>;
            // Tag CRUD
            createTag: (name: string, categoryId: number | null) => Promise<DbTag>;
            updateTag: (id: number, name: string, categoryId: number | null) => Promise<void>;
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
