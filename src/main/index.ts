import {
    app,
    BrowserWindow,
    shell,
    ipcMain,
    dialog,
    protocol,
    net,
} from "electron";
import path, { join } from "path";
import { pathToFileURL } from "url";
import { is } from "@electron-toolkit/utils";
import {
    initDb,
    closeDb,
    getAllFiles,
    getFilesByFolder,
    getTagsForFile,
    addTag,
    getAllTags,
    getFileIdsByTags,
    addTagToFolder,
    removeTag,
    getDb,
    updateEloScores,
    getFileByPath,
    getMissingFiles,
    reconcileMissingFiles,
    getAllActiveFiles,
    getFilesByPathPrefix,
} from "./db";
import type { DbFile } from "./db";
import {
    scanFolder,
    getSubfolders,
    getThumbnailPath,
    getFolderTree,
    FolderMetadata,
} from "./scanner";
import {
    readFileSync,
    writeFileSync,
    createReadStream,
    statSync,
    rename,
    existsSync,
} from "fs";
import { computeEloUpdate, getWeightedPair } from "./elo";
import { promisify } from "util";
import { renameFolderPaths } from "./db";
import { watchFolder, unwatchAll, ignoredPaths } from "./watcher";
import { replaceTrackedFile } from "./replaceFile";
import fs from "fs/promises";
import { getRandomFile } from "./random";
import { loadSavedRootPath, saveRootPath } from "./config";

let rootPath: string | null = null;

const renameAsync = promisify(rename);

export const pendingAppRenames = new Set<string>();

function registerIpcHandlers(): void {
    // ── Utility ──────────────────────────────────────────────────────────────
    ipcMain.handle("ping", () => "pong");

    // ── Library setup ────────────────────────────────────────────────────────

    ipcMain.handle("select-root-folder", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"],
            title: "Choose your media library folder",
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    ipcMain.handle("open-library", async (_event, folderPath: string) => {
        rootPath = folderPath;
        saveRootPath(folderPath);
        initDb(folderPath);
        reconcileMissingFiles(folderPath);
        const result = await scanFolder(folderPath);

        const win = BrowserWindow.getAllWindows()[0];

        // Tell renderer about any missing files (trashed, moved externally, etc.)
        const missing = getMissingFiles();
        for (const file of missing) {
            win?.webContents.send("media:removed", { relativePath: file.path });
        }

        if (win) watchFolder(folderPath, win);

        return result;
    });

    // And clean up on quit:
    app.on("before-quit", () => unwatchAll());

    ipcMain.handle("get-root-path", () => {
        if (!rootPath) {
            rootPath = loadSavedRootPath();
            if (rootPath) {
                initDb(rootPath); // ← add this
                const win = BrowserWindow.getAllWindows()[0];
                if (win) watchFolder(rootPath, win);
            }
        }
        return rootPath;
    });

    // ── Folders & files ──────────────────────────────────────────────────────

    ipcMain.handle("get-subfolders", () => {
        if (!rootPath) return [];
        return getFolderTree(rootPath);
    });

    ipcMain.handle("get-all-files", () => {
        return getAllFiles();
    });

    ipcMain.handle("get-all-active-files", () => {
        return getAllActiveFiles();
    });

    ipcMain.handle("get-files-in-folder", (_event, folderRelPath: string) => {
        return getFilesByFolder(folderRelPath);
    });

    ipcMain.handle("get-thumbnail-path", (_event, hash: string) => {
        if (!rootPath) return null;
        const thumbPath = getThumbnailPath(rootPath, hash);
        return existsSync(thumbPath) ? thumbPath : null;
    });

    ipcMain.handle("read-folder-metadata", (_event, folderRelPath: string) => {
        if (!rootPath) return null;
        const metaPath = path.join(rootPath, folderRelPath, ".metadata.json");
        try {
            if (!existsSync(metaPath)) return null;
            const raw = readFileSync(metaPath, "utf-8");
            return JSON.parse(raw);
        } catch {
            return null;
        }
    });

    ipcMain.handle(
        "write-folder-metadata",
        (_event, folderRelPath: string, metadata: unknown) => {
            if (!rootPath) return;
            const metaPath = path.join(
                rootPath,
                folderRelPath,
                ".metadata.json",
            );
            writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
        },
    );

    ipcMain.handle(
        "rename-folder",
        async (_event, oldRelPath: string, newName: string) => {
            if (!rootPath) return { ok: false, error: "No library open" };
            const win = BrowserWindow.getAllWindows()[0];

            const parentDir = path.dirname(oldRelPath);
            const newRelPath =
                parentDir === "." ? newName : `${parentDir}/${newName}`;
            const oldAbsPath = path.join(rootPath, oldRelPath);
            const newAbsPath = path.join(rootPath, newRelPath);

            if (
                existsSync(newAbsPath) &&
                oldAbsPath.toLowerCase() !== newAbsPath.toLowerCase()
            ) {
                return {
                    ok: false,
                    error: `A folder named "${newName}" already exists here`,
                };
            }

            try {
                // Grab affected records BEFORE rewriting the DB
                const affected = getFilesByPathPrefix(oldRelPath);

                ignoredPaths.add(oldAbsPath);
                ignoredPaths.add(newAbsPath);
                pendingAppRenames.add(newAbsPath);
                await renameAsync(oldAbsPath, newAbsPath);
                ignoredPaths.delete(oldAbsPath);
                ignoredPaths.delete(newAbsPath);

                renameFolderPaths(oldRelPath, newRelPath);

                // Emit exactly what commitFolderRename would have emitted
                for (const record of affected) {
                    const newFilePath =
                        newRelPath + record.path.slice(oldRelPath.length);
                    win.webContents.send("media:renamed", {
                        oldRelativePath: record.path,
                        relativePath: newFilePath,
                        hash: record.content_hash,
                        mediaType: record.media_type,
                    });
                }
                win.webContents.send("folder:renamed", {
                    oldRelativePath: oldRelPath,
                    relativePath: newRelPath,
                });

                return { ok: true, newRelPath };
            } catch (err: any) {
                ignoredPaths.delete(oldAbsPath);
                ignoredPaths.delete(newAbsPath);
                return { ok: false, error: err.message };
            }
        },
    );

    ipcMain.handle("open-external", (_event, url: string) => {
        shell.openExternal(url);
    });

    ipcMain.handle("show-in-folder", (_event, absolutePath: string) => {
        shell.showItemInFolder(absolutePath);
    });

    ipcMain.handle(
        "move-files-to",
        async (_event, filePaths: string[], targetDir: string) => {
            await Promise.all(
                filePaths.map((src) =>
                    fs.rename(src, path.join(targetDir, path.basename(src))),
                ),
            );
        },
    );

    ipcMain.handle(
        "file:replace",
        async (_event, oldRelPath: string, newAbsPath: string) => {
            if (!rootPath) throw new Error("No library open");
            const win = BrowserWindow.getAllWindows()[0];
            await replaceTrackedFile(
                rootPath,
                oldRelPath,
                newAbsPath,
                ignoredPaths,
            );
            const updated = getFileByPath(oldRelPath); // fresh record with new hash
            win?.webContents.send("media:updated", {
                relativePath: oldRelPath,
            });
            return updated;
        },
    );

    ipcMain.handle("dialog:open-file", async (_event, extensions: string[]) => {
        const result = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Media", extensions }],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    // ── Tags ─────────────────────────────────────────────────────────────────

    ipcMain.handle("get-tags", (_event, fileId: number) => {
        return getTagsForFile(fileId);
    });

    ipcMain.handle("add-tag", (_event, fileId: number, tag: string) => {
        addTag(fileId, tag);
        return getTagsForFile(fileId);
    });

    ipcMain.handle("remove-tag", (_event, fileId: number, tag: string) => {
        removeTag(fileId, tag);
        return getTagsForFile(fileId);
    });

    ipcMain.handle("get-all-tags", () => {
        return getAllTags();
    });

    ipcMain.handle(
        "get-file-ids-by-tags",
        (_event, tags: string[], mode: "and" | "or") => {
            return getFileIdsByTags(tags, mode);
        },
    );

    ipcMain.handle(
        "add-tag-to-folder",
        (_event, folderRelPath: string, tag: string) => {
            return addTagToFolder(folderRelPath, tag);
        },
    );

    // -- Scroll

    ipcMain.handle(
        "get-random-file",
        (
            _event,
            folderPrefixes: string[] | null,
            tagList: string[] | null,
            tagMode: "and" | "or",
            excludeIds: number[] = [],
        ) => {
            return getRandomFile(folderPrefixes, tagList, tagMode, excludeIds);
        },
    );

    // -- Comparisons

    ipcMain.handle(
        "get-pair",
        (
            _event,
            folderPrefixes: string[] | null,
            tagList: string[] | null,
            tagMode: "and" | "or",
        ) => {
            return getWeightedPair(folderPrefixes, tagList, tagMode);
        },
    );

    ipcMain.handle(
        "record-comparison",
        (_event, winnerId: number, loserId: number, margin: number) => {
            const db = getDb();
            const winner = db
                .prepare("SELECT * FROM files WHERE id = ?")
                .get(winnerId) as DbFile;
            const loser = db
                .prepare("SELECT * FROM files WHERE id = ?")
                .get(loserId) as DbFile;
            if (!winner || !loser) return null;
            const { newWinnerScore, newLoserScore } = computeEloUpdate(
                winner,
                loser,
                margin,
            );
            updateEloScores(
                winnerId,
                loserId,
                newWinnerScore,
                newLoserScore,
                rootPath ?? "all",
            );
            return { newWinnerScore, newLoserScore };
        },
    );
}

function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        show: false,
        titleBarStyle: "hiddenInset",
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            sandbox: false,
        },
    });

    mainWindow.on("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url);
        return { action: "deny" };
    });

    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
        mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    } else {
        mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    }
}

app.whenReady().then(() => {
    protocol.handle("media", async (request) => {
        const url = request.url.replace("media://local", "");
        const filePath = decodeURIComponent(url);

        try {
            const stat = statSync(filePath);
            const fileSize = stat.size;
            const rangeHeader = request.headers.get("range");

            if (rangeHeader) {
                const parts = rangeHeader.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;

                const ext = path.extname(filePath).toLowerCase();
                const contentType =
                    {
                        ".mp4": "video/mp4",
                        ".mov": "video/quicktime",
                        ".qt": "video/quicktime",
                        ".jpg": "image/jpeg",
                        ".png": "image/png",
                        ".gif": "image/gif",
                    }[ext] ?? "application/octet-stream";

                const stream = createReadStream(filePath, { start, end });
                return new Response(stream as any, {
                    status: 206,
                    headers: {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": String(chunkSize),
                        "Content-Type": contentType,
                    },
                });
            } else {
                const stream = createReadStream(filePath);
                return new Response(stream as any, {
                    status: 200,
                    headers: {
                        "Content-Length": String(fileSize),
                        "Content-Type": "video/mp4",
                        "Accept-Ranges": "bytes",
                    },
                });
            }
        } catch (err) {
            console.error("protocol error:", err);
            return new Response("Not found", { status: 404 });
        }
    });

    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    closeDb();
    if (process.platform !== "darwin") app.quit();
});
