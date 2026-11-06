import {
    app,
    BrowserWindow,
    shell,
    ipcMain,
    dialog,
    protocol,
    nativeImage,
    clipboard,
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
    getAllTags,
    getFileIdsByTags,
    addTagToFolder,
    getDb,
    updateEloScores,
    undoComparison,
    getFileByPath,
    getMissingFiles,
    reconcileMissingFiles,
    getAllActiveFiles,
    getFilesByPathPrefix,
    renameFolderPath,
    upsertTag,
    addTagToFile,
    getTagByName,
    removeTagFromFile,
    upsertFolder,
    getTagsForFolderByPath,
    removeTagFromFolderByPath,
    getFolderMetadata,
    setFolderMetadataField,
    deleteFolderMetadataField,
    getAllMetadataFieldNames,
    setFolderProfileImageByPath,
    getFolderByPath,
    getFolderMetadataByPath,
    getActiveFilesByTags,
    getMostUsedTags,
    getAllTagCategories,
    deleteTagCategory,
    updateTag,
    deleteTag,
    upsertTagCategory,
    updateTagCategory,
    getFileById,
    markFileMissingById,
    moveFileRecord,
    getRootFiles,
    countRootFiles,
} from "./db";
import type { DbFile } from "./db";
import { scanFolder, getThumbnailPath, getFolderTree, type ScanResult } from "./scanner";
import { getMimeType, isBrowserNative, SUPPORTED_EXTENSIONS } from "./formats";
import { getDisplayCopy } from "./displayCopy";
import {
    readFileSync,
    writeFileSync,
    createReadStream,
    statSync,
    rename,
    existsSync,
} from "fs";
import {
    computeEloUpdate,
    getChallenger,
    getLanePair,
    refitPair,
    getWeightedPair,
    type PoolFilter,
} from "./elo";
import { promisify } from "util";
import { renameFolderPaths } from "./db";
import { watchFolder, unwatchAll, ignoredPaths } from "./watcher";
import { replaceTrackedFile } from "./replaceFile";
import { rotateTrackedFile } from "./rotate";
import fs from "fs/promises";
import { getRandomFile } from "./random";
import { loadSavedRootPath, saveRootPath, loadSettings, saveSettings } from "./config";

let rootPath: string | null = null;

const renameAsync = promisify(rename);

export const pendingAppRenames = new Set<string>();

// Bring the index in line with the disk: mark files that vanished, index new
// ones, pick up moves. Shared by launch and Rescan so two scans of the same
// library never run at once (a second caller just waits for the first).
let scanInFlight: { root: string; promise: Promise<ScanResult> } | null = null;
function scanLibrary(root: string, win: BrowserWindow): Promise<ScanResult> {
    if (scanInFlight?.root === root) return scanInFlight.promise;
    const promise = (async () => {
        reconcileMissingFiles(root);
        return scanFolder(root, win);
    })().finally(() => {
        if (scanInFlight?.promise === promise) scanInFlight = null;
    });
    scanInFlight = { root, promise };
    return promise;
}

// rename() can't cross drives (EXDEV), e.g. a file dropped in from a USB
// stick. Fall back to copy-then-delete; COPYFILE_EXCL so it never overwrites.
async function moveAcrossVolumes(src: string, dest: string): Promise<void> {
    try {
        await fs.rename(src, dest);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
        await fs.unlink(src);
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
        const win = BrowserWindow.getAllWindows()[0];

        // Switching libraries: stop watching the old one first, or its events
        // would be written into the new library's database.
        if (rootPath && rootPath !== folderPath) await unwatchAll();

        rootPath = folderPath;
        saveRootPath(folderPath);
        initDb(folderPath);
        const result = await scanLibrary(folderPath, win);

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
                const root = rootPath;
                initDb(root);
                const win = BrowserWindow.getAllWindows()[0];
                if (win) {
                    watchFolder(root, win);
                    // The watcher only sees changes from now on. Catch up on
                    // anything that changed while the app was closed, in the
                    // background so the library opens right away.
                    win.webContents.send("library:scan-started");
                    scanLibrary(root, win)
                        .then((result) => {
                            if (rootPath !== root || win.isDestroyed()) return;
                            win.webContents.send("library:scanned", result);
                        })
                        .catch((err) => {
                            console.error("Startup scan failed:", err);
                            if (!win.isDestroyed()) {
                                win.webContents.send("library:scanned", null);
                            }
                        });
                }
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

    ipcMain.handle(
        "get-files-by-tags",
        (_event, tagIds: number[], mode: "and" | "or", folderPath?: string) => {
            return getActiveFilesByTags(tagIds, mode, folderPath);
        },
    );

    ipcMain.handle("get-thumbnail-path", (_event, hash: string) => {
        if (!rootPath) return null;
        const thumbPath = getThumbnailPath(rootPath, hash);
        return existsSync(thumbPath) ? thumbPath : null;
    });

    ipcMain.handle("get-folder-metadata", (_event, folderRelPath: string) => {
        return getFolderMetadataByPath(folderRelPath);
    });

    ipcMain.handle(
        "set-folder-metadata-field",
        (
            _event,
            folderRelPath: string,
            key: string,
            value: string,
            type: string,
        ) => {
            setFolderMetadataField(folderRelPath, key, value, type as any);
        },
    );

    ipcMain.handle(
        "delete-folder-metadata-field",
        (_event, folderRelPath: string, key: string) => {
            deleteFolderMetadataField(folderRelPath, key);
        },
    );

    ipcMain.handle("get-metadata-fields", () => {
        return getAllMetadataFieldNames();
    });

    ipcMain.handle(
        "set-folder-profile-image",
        (_event, folderRelPath: string, hash: string | null) => {
            setFolderProfileImageByPath(folderRelPath, hash);
        },
    );

    ipcMain.handle("get-folder", (_event, folderRelPath: string) => {
        return getFolderByPath(folderRelPath);
    });

    ipcMain.handle("get-folder-tags", (_event, folderRelPath: string) => {
        return getTagsForFolderByPath(folderRelPath);
    });

    ipcMain.handle(
        "remove-tag-from-folder",
        (_event, folderRelPath: string, tag: string) => {
            removeTagFromFolderByPath(folderRelPath, tag);
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
                renameFolderPath(oldRelPath, newRelPath);

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

    // App settings (persisted in config.json). Read synchronously at preload
    // time so the UI starts with saved values instead of flashing defaults.
    ipcMain.on("settings:get-sync", (event) => {
        event.returnValue = loadSettings();
    });
    ipcMain.handle("settings:save", (_event, settings: Record<string, unknown>) => {
        saveSettings(settings);
    });

    ipcMain.handle("get-root-files", () => getRootFiles());
    ipcMain.handle("count-root-files", () => countRootFiles());

    // Move files into a top-level library folder ("" = the library root,
    // i.e. Unsorted). Files already in the
    // library keep their record (score, tags, history); the folder's tags are
    // applied. Files from outside the library are just moved in and the
    // watcher indexes them. Never overwrites: clashes get " (2)" etc.
    ipcMain.handle(
        "move-into-folder",
        async (
            _event,
            absPaths: string[],
            targetFolder: string,
        ): Promise<{ moved: number; errors: string[] }> => {
            const errors: string[] = [];
            let moved = 0;
            if (!rootPath) return { moved, errors: ["No library open."] };
            const root = rootPath;
            const targetDir = path.join(root, targetFolder);
            if (!existsSync(targetDir)) {
                return { moved, errors: [`Folder "${targetFolder}" not found.`] };
            }
            const win = BrowserWindow.getAllWindows()[0];

            const freeName = (dir: string, filename: string): string => {
                if (!existsSync(path.join(dir, filename))) return filename;
                const ext = path.extname(filename);
                const stem = filename.slice(0, filename.length - ext.length);
                for (let i = 2; ; i++) {
                    const candidate = `${stem} (${i})${ext}`;
                    if (!existsSync(path.join(dir, candidate))) return candidate;
                }
            };

            for (const src of absPaths) {
                try {
                    if (path.dirname(src) === targetDir) continue; // already there

                    const rel = path.relative(root, src);
                    const insideLibrary =
                        !rel.startsWith("..") && !path.isAbsolute(rel);
                    const record = insideLibrary ? getFileByPath(rel) : undefined;

                    const filename = freeName(targetDir, path.basename(src));
                    const dest = path.join(targetDir, filename);

                    if (!record) {
                        // Untracked / external file: plain move, watcher indexes it.
                        await moveAcrossVolumes(src, dest);
                        moved++;
                        continue;
                    }

                    const newRel = path.relative(root, dest);
                    ignoredPaths.add(src);
                    ignoredPaths.add(dest);
                    try {
                        await fs.rename(src, dest);
                    } finally {
                        // Hold the ignore briefly: chokidar reports the
                        // events asynchronously after the rename returns.
                        setTimeout(() => {
                            ignoredPaths.delete(src);
                            ignoredPaths.delete(dest);
                        }, 1500);
                    }

                    const folder = targetFolder
                        ? upsertFolder(targetFolder, path.basename(targetFolder))
                        : null;
                    moveFileRecord(record.id, newRel, filename, folder?.id ?? null);

                    win?.webContents.send("media:renamed", {
                        oldRelativePath: rel,
                        relativePath: newRel,
                        hash: record.content_hash,
                        mediaType: record.media_type,
                    });
                    moved++;
                } catch (err) {
                    console.error("Failed to move", src, err);
                    errors.push(`Couldn't move ${path.basename(src)}`);
                }
            }
            return { moved, errors };
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
                file: updated,
            });
            return updated;
        },
    );

    // Rotate left by quarter turns, in place. Returns the fresh record (new
    // content hash) and tells every view, so e.g. Compare shows it rotated.
    ipcMain.handle(
        "file:rotate",
        async (_event, relPath: string, quarterTurns: number) => {
            if (!rootPath) throw new Error("No library open");
            await rotateTrackedFile(rootPath, relPath, quarterTurns, ignoredPaths);
            const updated = getFileByPath(relPath);
            BrowserWindow.getAllWindows()[0]?.webContents.send("media:updated", {
                relativePath: relPath,
                file: updated,
            });
            return updated;
        },
    );

    ipcMain.handle("dialog:open-file", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Media", extensions: SUPPORTED_EXTENSIONS }],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle("delete-file-by-id", async (_event, fileId: number) => {
        const win = BrowserWindow.getAllWindows()[0];
        try {
            const file = getFileById(fileId);
            if (!file) {
                throw new Error(`File with id ${fileId} not found in database`);
            }

            // Convert relative path to absolute
            if (!rootPath) throw Error("unable to read rootPath");
            const absolutePath = path.join(rootPath, file.path); // Use your app's rootPath

            await shell.trashItem(absolutePath);

            markFileMissingById(fileId);

            // Emit the removal event so UI updates
            win?.webContents.send("media:removed", { relativePath: file.path });
        } catch (error) {
            console.error("Failed to delete file:", error);
            throw error;
        }
    });

    ipcMain.handle(
        "copy-file-to-clipboard",
        async (event, filePath: string) => {
            clipboard.writeBuffer(
                "public.file-url",
                Buffer.from(pathToFileURL(filePath).href, "utf-8"),
            );
            return true;
        },
    );

    // ── Tags ─────────────────────────────────────────────────────────────────

    ipcMain.handle("get-tags", (_event, fileId: number) => {
        return getTagsForFile(fileId);
    });

    ipcMain.handle("add-tag", (_event, fileId: number, tag: string) => {
        const { id: tagId } = upsertTag(tag, undefined);
        addTagToFile(fileId, tagId);
        return getTagsForFile(fileId);
    });

    ipcMain.handle("remove-tag", (_event, fileId: number, tag: string) => {
        const existing = getTagByName(tag);
        if (existing) removeTagFromFile(fileId, existing.id);
        return getTagsForFile(fileId);
    });

    ipcMain.handle("get-all-tags", () => {
        return getAllTags();
    });

    ipcMain.handle(
        "get-file-ids-by-tags",
        (_event, tags: number[], mode: "and" | "or") => {
            const tagIds = tags.filter((id): id is number => id !== undefined);
            return getFileIdsByTags(tagIds, mode);
        },
    );

    // Create a new top-level folder in the library. Returns its relative path,
    // or an error message for the UI.
    ipcMain.handle(
        "create-folder",
        async (
            _event,
            name: string,
        ): Promise<{ relativePath: string } | { error: string }> => {
            if (!rootPath) return { error: "No library open." };
            const trimmed = name.trim();
            if (!trimmed) return { error: "Enter a folder name." };
            if (/[/\\:]/.test(trimmed) || trimmed === "." || trimmed === "..") {
                return { error: "Folder names can't contain / \\ or :" };
            }
            if (trimmed.startsWith(".") || trimmed === "_thumbnails") {
                return { error: "That name is reserved." };
            }
            const absolutePath = join(rootPath, trimmed);
            try {
                await fs.mkdir(absolutePath);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                    return { error: "A folder with that name already exists." };
                }
                console.error("Failed to create folder:", err);
                return { error: "Couldn't create the folder." };
            }
            upsertFolder(trimmed, trimmed);
            return { relativePath: trimmed };
        },
    );

    ipcMain.handle(
        "add-tag-to-folder",
        (_event, folderRelPath: string, tag: string) => {
            const folder = upsertFolder(
                folderRelPath,
                path.basename(folderRelPath),
            );
            const { id: tagId } = upsertTag(tag);
            addTagToFolder(folder.id, tagId);
        },
    );

    ipcMain.handle("get-most-used-tags", (_event, folderId?: number) => {
        return getMostUsedTags(folderId);
    });

    // -- Scroll

    ipcMain.handle(
        "get-random-file",
        (
            _event,
            folderPrefixes: string[] | null,
            tagList: number[] | null,
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
            tagList: number[] | null,
            tagMode: "and" | "or",
        ) => {
            return getWeightedPair(folderPrefixes, tagList, tagMode);
        },
    );

    ipcMain.handle(
        "get-lane-pair",
        (_event, laneA: PoolFilter, laneB: PoolFilter) => {
            return getLanePair(laneA, laneB);
        },
    );

    ipcMain.handle(
        "refit-pair",
        (
            _event,
            ids: [number, number],
            laneA: PoolFilter,
            laneB: PoolFilter,
            kingSide: "a" | "b" | null,
            recentIds: number[],
        ) => refitPair(ids, laneA, laneB, kingSide, recentIds),
    );

    ipcMain.handle(
        "get-challenger",
        (
            _event,
            kingId: number,
            folderPrefixes: string[] | null,
            tagList: number[] | null,
            tagMode: "and" | "or",
            recentIds: number[],
        ) => {
            return getChallenger(
                kingId,
                folderPrefixes,
                tagList,
                tagMode,
                recentIds,
            );
        },
    );

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

            // Library-wide rank (1 = best) among active files.
            const rankOf = (id: number): number =>
                (
                    db
                        .prepare(
                            `SELECT COUNT(*) AS n FROM files
                             WHERE status = 'active' AND id != ?
                             AND elo_score > (SELECT elo_score FROM files WHERE id = ?)`,
                        )
                        .get(id, id) as { n: number }
                ).n + 1;
            const winnerRankBefore = rankOf(winnerId);
            const loserRankBefore = rankOf(loserId);

            const { newWinnerScore, newLoserScore } = computeEloUpdate(
                winner,
                loser,
            );
            const comparisonId = updateEloScores(
                winnerId,
                loserId,
                newWinnerScore,
                newLoserScore,
                rootPath ?? "all",
            );

            const getFile = (id: number) =>
                db.prepare("SELECT * FROM files WHERE id = ?").get(id) as DbFile;
            return {
                comparisonId,
                newWinnerScore,
                newLoserScore,
                winner: getFile(winnerId),
                loser: getFile(loserId),
                winnerRank: { before: winnerRankBefore, after: rankOf(winnerId) },
                loserRank: { before: loserRankBefore, after: rankOf(loserId) },
            };
        },
    );

    ipcMain.handle(
        "undo-comparison",
        (_event, comparisonId: number, fileIds: number[]) => {
            if (!undoComparison(comparisonId)) return null;
            const db = getDb();
            return fileIds.map(
                (id) =>
                    db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
                        | DbFile
                        | undefined,
            );
        },
    );

    // tag manager

    ipcMain.handle(
        "create-tag",
        (_event, name: string, categoryId: number | null) => {
            return upsertTag(name, categoryId);
        },
    );

    ipcMain.handle(
        "update-tag",
        (_event, id: number, name: string, categoryId: number | null) => {
            return updateTag(id, name, categoryId);
        },
    );

    ipcMain.handle("delete-tag", (_event, id: number) => {
        deleteTag(id);
    });

    ipcMain.handle("get-all-tag-categories", (_event) => {
        return getAllTagCategories();
    });

    ipcMain.handle(
        "create-tag-category",
        (_event, name: string, color: string, icon: string) => {
            upsertTagCategory(name, color, icon);
        },
    );

    ipcMain.handle(
        "update-tag-category",
        (
            _event,
            id: number,
            updates: {
                name?: string;
                color?: string | null;
                icon?: string | null;
                order_index?: number;
            },
        ) => {
            updateTagCategory(id, updates);
        },
    );

    ipcMain.handle("delete-tag-category", (_event, id: number) => {
        deleteTagCategory(id);
    });

    ipcMain.on("drag-file-out", (event, file: DbFile) => {
        if (!file || !rootPath) return;
        const filePath = join(rootPath, file.path);
        if (!existsSync(filePath)) return;

        event.sender.startDrag({
            file: filePath,
            icon: getDragIcon(getThumbnailPath(rootPath, file.content_hash)),
        });
    });

    // Drag several files at once (a Browse selection).
    ipcMain.on("drag-files-out", (event, files: DbFile[]) => {
        if (!rootPath || !Array.isArray(files) || files.length === 0) return;
        const root = rootPath;
        const present = files.filter((f) => existsSync(join(root, f.path)));
        if (present.length === 0) return;
        const paths = present.map((f) => join(root, f.path));

        event.sender.startDrag({
            file: paths[0],
            files: paths,
            icon: getDragIcon(getThumbnailPath(root, present[0].content_hash)),
        });
    });
}

// Image shown under the cursor while dragging a file out of the app: the
// file's thumbnail if it has one, else a generic file icon. The fallback is
// embedded (not loaded from src/) so it survives packaging; macOS refuses to
// start a drag with an empty icon.
const FALLBACK_DRAG_ICON_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADhSURBVDiNndO/SgNBEMfxjxqwMTFqk9LX8BF8iYCF+BARrMTSwj5gI1j4HIIgloI2lv4JInqdohZ3S5Zwczn9wTY78/vu7DDDVAd4Dc47jrAg0Ape0A3il7jGGEt5YDEDTPARvYBhZb7A8ixgnr6whTNs4jQFOi0Bh9hR9uAO2+jjLSUMcNsSpsodRBWcYz0wXmGUX9QB9tELAI+zF3WAVeX/6lS0AexiLQDcKAeqEbAXmGvV1MRv5fA8/RWQmviJ5/9UcD/PlCuNcoEN8TLl6la5RV5BgRM8aFjZSj84ToBfH9spjYC2aR8AAAAASUVORK5CYII=";
const DRAG_ICON_MAX = 96;

function getDragIcon(thumbnailPath: string): Electron.NativeImage {
    const thumb = existsSync(thumbnailPath)
        ? nativeImage.createFromPath(thumbnailPath)
        : null;
    if (thumb && !thumb.isEmpty()) {
        const { width, height } = thumb.getSize();
        const scale = Math.min(1, DRAG_ICON_MAX / Math.max(width, height));
        return thumb.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
        });
    }
    return nativeImage.createFromDataURL(FALLBACK_DRAG_ICON_DATA_URL);
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

    mainWindow.on("enter-full-screen", () => {
        mainWindow.webContents.send("fullscreen-status", true);
    });

    mainWindow.on("leave-full-screen", () => {
        mainWindow.webContents.send("fullscreen-status", false);
    });

    // Dropping a file anywhere that doesn't handle drops would otherwise
    // navigate the whole window to that file. Only allow navigating to the
    // app's own page.
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const strip = (u: string) => u.split("#")[0].split("?")[0];
        if (
            url.startsWith("file:") &&
            strip(url) !== strip(mainWindow.webContents.getURL())
        ) {
            event.preventDefault();
        }
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
        // Drop any ?query: it only versions the URL (so a rotated file isn't
        // served from cache), it isn't part of the path.
        const url = request.url.replace("media://local", "").split("?")[0];
        let filePath = decodeURIComponent(url);
        let contentType = getMimeType(path.extname(filePath));

        try {
            // Formats Chromium can't decode are served as a JPEG copy.
            if (!isBrowserNative(path.extname(filePath))) {
                filePath = await getDisplayCopy(filePath);
                contentType = "image/jpeg";
            }
            const stat = statSync(filePath);
            const fileSize = stat.size;
            const rangeHeader = request.headers.get("range");

            if (rangeHeader) {
                const parts = rangeHeader.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;

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
                        "Content-Type": contentType,
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

// On macOS the app outlives its window (reopened from the Dock), so the
// database stays open until the app actually quits.
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => closeDb());
