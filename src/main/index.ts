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
    removeTag,
    getDb,
    updateEloScores,
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

let rootPath: string | null = null;

const renameAsync = promisify(rename);

function getConfigPath(): string {
    return join(app.getPath("userData"), "config.json");
}

function loadSavedRootPath(): string | null {
    try {
        const raw = readFileSync(getConfigPath(), "utf-8");
        const config = JSON.parse(raw);
        return config.rootPath ?? null;
    } catch {
        return null;
    }
}

function saveRootPath(path: string): void {
    try {
        writeFileSync(
            getConfigPath(),
            JSON.stringify({ rootPath: path }),
            "utf-8",
        );
    } catch (err) {
        console.error("Failed to save config:", err);
    }
}

function saveFolderMetadata(path: string, metadata: FolderMetadata): void {
    try {
        writeFileSync(path + ".meta.json", JSON.stringify(metadata), "utf-8");
    } catch (err) {
        console.error("Failed to save metadata:", err);
    }
}

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
        const result = await scanFolder(folderPath);
        return result;
    });

    ipcMain.handle("get-root-path", () => {
        if (!rootPath) {
            rootPath = loadSavedRootPath();
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

            const parentDir = path.dirname(oldRelPath);
            const newRelPath =
                parentDir === "." ? newName : `${parentDir}/${newName}`;
            const oldAbsPath = path.join(rootPath, oldRelPath);
            const newAbsPath = path.join(rootPath, newRelPath);

            // Conflict check — refuse if sibling with that name already exists
            if (existsSync(newAbsPath)) {
                return {
                    ok: false,
                    error: `A folder named "${newName}" already exists here`,
                };
            }

            try {
                await renameAsync(oldAbsPath, newAbsPath);
                renameFolderPaths(oldRelPath, newRelPath);
                return { ok: true, newRelPath };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
    );

    ipcMain.handle("open-external", (_event, url: string) => {
        shell.openExternal(url);
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

    // -- Comparisons

    ipcMain.handle("get-pair", (_event, folderPrefixes: string[] | null) => {
        return getWeightedPair(folderPrefixes);
    });

    ipcMain.handle(
        "record-comparison",
        (_event, winnerId: number, loserId: number) => {
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

        console.log("protocol request:", request.url);
        console.log("resolved path:", filePath);
        console.log("exists:", existsSync(filePath));

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
