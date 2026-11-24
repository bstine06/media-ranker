import {
    app,
    BrowserWindow,
    shell,
    ipcMain,
    dialog,
    protocol,
    nativeImage,
    clipboard,
    Menu,
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
    getFileIdsByFilter,
    addTagToFolder,
    getDb,
    updateEloScores,
    getFileByPath,
    getMissingFiles,
    countMissingFiles,
    getLibraryRanks,
    deleteMissingFiles,
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
    deleteFolderTree,
    getFolderMetadataByPath,
    getActiveFilesByFilter,
    getMostUsedTags,
    getAllTagCategories,
    deleteTagCategory,
    updateTag,
    deleteTag,
    upsertTagCategory,
    updateTagCategory,
    getFileById,
    markFileMissingById,
    markFileMissing,
    moveFileRecord,
    getRootFiles,
    countRootFiles,
    getTagUsage,
    mergeTags,
    addTagCheckSeconds,
    getTagCoverage,
    getNoesForFolder,
    previewFolderNo,
    previewFolderTag,
    addFolderNo,
    removeFolderNo,
    tagsRuledOutByFolder,
    noesGivenByFolder,
    getNoesForFile,
    clearFileNo,
    previewBatchApply,
    batchApply,
    convertFolderRule,
    countFolderFiles,
    getConflictFiles,
    getRelatedTags,
    getTagImplications,
    reorderTags,
    setTagSweep,
    setCategoryTagsSweep,
    previewTagImplication,
    addTagImplication,
    removeTagImplication,
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
    recordComparison,
    getChallenger,
    refitPair,
    getWeightedPair,
    type PoolFilter,
} from "./elo";
import { validateFilter } from "./tagFilter";
import {
    listFeeds,
    createFeed,
    updateFeedTree,
    renameFeed,
    deleteFeed,
    getFeedHistory,
    pushFeedHistory,
    feedsUsing,
    countFilter,
} from "./feeds";

// A Compare pool from the renderer, with its filter tree checked.
const pool = (p: PoolFilter): PoolFilter => ({
    folderPrefixes: p.folderPrefixes,
    filter: validateFilter(p.filter),
});
import { promisify } from "util";
import { renameFolderPaths } from "./db";
import { watchFolder, unwatchAll, ignoredPaths, waitForWatcher } from "./watcher";
import { replaceTrackedFile } from "./replaceFile";
import {
    getPlacementCandidate,
    countPlacementCandidates,
    initialPlacementBounds,
    getPlacementOpponent,
    recordPlacement,
    type PlacementBounds,
} from "./placement";
import { rotateTrackedFile, previousVersionPath } from "./rotate";
import fs from "fs/promises";
import { getRandomFile } from "./random";
import {
    initUndo,
    record,
    beginStep,
    holdingPath,
    undo as undoHistory,
    redo as redoHistory,
    recordState,
    recordSelection,
    type FilterState,
    historyList,
    clearHistory,
    flushHolding,
    hasHeldFiles,
    type Step,
} from "./undo";
import { generateSizedImage, getMediaType, hashFile } from "./scanner";
import {
    getPassFiles,
    getPassCounts,
    prunePassList,
    countScope,
    setPassNo,
    clearPassNo,
    getFirmNoes,
    getFilesByIds,
    loadPassRun,
    savePassRun,
    clearPassRun,
    type PassWhich,
    type PassSlot,
} from "./pass";
import {
    loadSavedRootPath,
    saveRootPath,
    loadSettings,
    saveSettings,
    INTERNAL_NAMES,
} from "./config";

let rootPath: string | null = null;

/** Scores changed: views showing library ranks refetch them. Passes the
 *  handler's result through. */
function ranksChanged<T>(result: T): T {
    BrowserWindow.getAllWindows()[0]?.webContents.send("ranks:changed");
    return result;
}

const renameAsync = promisify(rename);

// ── Undo history labels ──
const quote = (s: string) => `“${s}”`;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const fileLabel = (id: number) => getFileById(id)?.filename ?? "a file";
const filesLabel = (ids: number[]) => (ids.length === 1 ? fileLabel(ids[0]) : plural(ids.length, "file"));
const folderLabel = (rel: string) => (rel ? path.basename(rel) : "Unsorted");
const tagLabel = (id: number) => {
    const row = getDb().prepare(`SELECT name FROM tags WHERE id = ?`).get(id) as { name: string } | undefined;
    return row ? quote(row.name) : "a tag";
};
const tagsLabel = (names: string[]) => names.map((n) => quote(n.trim().toLowerCase())).join(", ");

// Opening a library: a fresh history (it belongs to the library), held
// files left by a crash go to the Trash, and the change triggers go on.
// Rescanning reopens the same library: its history stays.
let undoRoot: string | null = null;
function openLibraryDb(root: string): void {
    if (undoRoot === root) {
        initDb(root);
        return;
    }
    undoRoot = root;
    clearHistory();
    initUndo(initDb(root), {
        rootPath: () => rootPath,
        ignoredPaths,
        fileById: (id) => getFileById(id),
        settle: async (onSlow) => {
            await waitForWatcher(10_000, onSlow);
        },
        hashFile: (abs) => hashFile(abs),
        filesUnder: (relPath) => getFilesByPathPrefix(relPath),
        fileGone: (relPath) => markFileMissing(relPath),
        ensureThumbnail: async (relPath) => {
            if (!rootPath) return;
            const f = getFileByPath(relPath);
            const type = getMediaType(path.extname(relPath));
            if (!f || !type) return;
            const thumb = getThumbnailPath(rootPath, f.content_hash);
            if (!existsSync(thumb)) {
                await generateSizedImage(path.join(rootPath, relPath), thumb, 400, type);
            }
        },
    });
    if (hasHeldFiles(root)) void flushHolding(root);
}

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

// Every file and folder under a directory (to keep the watcher off them
// while it moves as a whole).
async function listTree(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
        const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
            const p = path.join(d, e.name);
            out.push(p);
            if (e.isDirectory()) await walk(p);
        }
    };
    await walk(dir);
    return out;
}

// Why a name can't be used for a library folder, or null if it can. Folders
// are top-level only, so no path separators.
function folderNameError(name: string): string | null {
    if (!name) return "Enter a folder name.";
    if (/[/\\:]/.test(name) || name === "." || name === "..") {
        return "Folder names can't contain / \\ or :";
    }
    if (name.startsWith(".") || INTERNAL_NAMES.has(name)) {
        return "That name is reserved.";
    }
    return null;
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

        if (rootPath && rootPath !== folderPath) {
            clearHistory();
            void flushHolding(rootPath);
            undoRoot = null;
        }
        rootPath = folderPath;
        saveRootPath(folderPath);
        openLibraryDb(folderPath);
        const result = await scanLibrary(folderPath, win);

        // Tell renderer about any missing files (trashed, moved externally, etc.)
        const missing = getMissingFiles();
        for (const file of missing) {
            win?.webContents.send("media:removed", { relativePath: file.path });
        }

        if (win) watchFolder(folderPath, win);

        return result;
    });

    // And clean up on quit. Held files (undo) go to the Trash first.
    let flushedOnQuit = false;
    app.on("before-quit", (event) => {
        unwatchAll();
        const root = rootPath;
        if (flushedOnQuit || !root || !hasHeldFiles(root)) return;
        event.preventDefault();
        flushedOnQuit = true;
        clearHistory();
        flushHolding(root).finally(() => app.quit());
    });

    // ── Undo history ──
    ipcMain.handle("history:list", () => historyList());
    // The result goes to every view (toast, refetching, Compare's pair).
    const applied = (res: Awaited<ReturnType<typeof undoHistory>>) => {
        if (!res) return null;
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send("history:applied", res);
        win?.webContents.send("ranks:changed");
        return res;
    };
    ipcMain.handle("history:undo", async () => applied(await undoHistory()));
    ipcMain.handle("history:redo", async () => applied(await redoHistory()));
    // View-state steps: the tag filter, the collection selection.
    ipcMain.handle(
        "history:record-filter",
        (_event, label: string, before: FilterState, after: FilterState) =>
            recordState(String(label), { kind: "filter", before, after }),
    );
    ipcMain.handle("history:record-selection", (_event, before: string[], after: string[]) =>
        recordSelection(before, after),
    );

    ipcMain.handle("get-root-path", () => {
        if (!rootPath) {
            rootPath = loadSavedRootPath();
            if (rootPath) {
                const root = rootPath;
                openLibraryDb(root);
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
        (_event, filter: unknown, folderPath?: string) => {
            return getActiveFilesByFilter(validateFilter(filter), folderPath);
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
            record(`Set ${key} on ${folderLabel(folderRelPath)}`, () =>
                setFolderMetadataField(folderRelPath, key, value, type as any),
            );
        },
    );

    ipcMain.handle(
        "delete-folder-metadata-field",
        (_event, folderRelPath: string, key: string) => {
            record(`Removed ${key} from ${folderLabel(folderRelPath)}`, () =>
                deleteFolderMetadataField(folderRelPath, key),
            );
        },
    );

    ipcMain.handle("get-metadata-fields", () => {
        return getAllMetadataFieldNames();
    });

    ipcMain.handle(
        "set-folder-profile-image",
        (_event, folderRelPath: string, hash: string | null) => {
            record(
                hash
                    ? `Changed the picture of ${folderLabel(folderRelPath)}`
                    : `Removed the picture of ${folderLabel(folderRelPath)}`,
                () => setFolderProfileImageByPath(folderRelPath, hash),
            );
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
            record(`Removed ${quote(tag)} from ${folderLabel(folderRelPath)}`, () =>
                removeTagFromFolderByPath(folderRelPath, tag),
            );
        },
    );

    ipcMain.handle(
        "rename-folder",
        async (_event, oldRelPath: string, newName: string) => {
            if (!rootPath) return { ok: false, error: "No library open" };
            const win = BrowserWindow.getAllWindows()[0];

            newName = newName.trim();
            const invalid = folderNameError(newName);
            if (invalid) return { ok: false, error: invalid };

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
                    error: `A folder named «${newName}» already exists here`,
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

                const step = beginStep(
                    `Renamed ${folderLabel(oldRelPath)} to ${newName}`,
                );
                step.disk({
                    kind: "move",
                    from: oldAbsPath,
                    to: newAbsPath,
                    folder: { fromRel: oldRelPath, toRel: newRelPath, mode: "rename", fileIds: [] },
                });
                step.db(() => {
                    renameFolderPaths(oldRelPath, newRelPath);
                    renameFolderPath(oldRelPath, newRelPath);
                });
                step.commit();

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
    const moveIntoFolder = async (
        absPaths: string[],
        targetFolder: string,
        enforceNoes = false,
        step?: Step,
    ): Promise<{ moved: number; errors: string[] }> => {
            const own = !step;
            const s = step ?? beginStep("");
            const movedIds: number[] = [];
            try {
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
                        // Undoable only within one volume (a plain rename back).
                        if (insideLibrary) s.disk({ kind: "move", from: src, to: dest });
                        else {
                            const sameVolume = await fs.stat(path.dirname(src)).then(
                                async (a) => a.dev === (await fs.stat(targetDir)).dev,
                                () => false,
                            );
                            if (sameVolume) s.disk({ kind: "move", from: src, to: dest });
                        }
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
                    s.disk({ kind: "move", from: src, to: dest, fileId: record.id });
                    s.db(() =>
                        moveFileRecord(record.id, newRel, filename, folder?.id ?? null, enforceNoes),
                    );
                    movedIds.push(record.id);

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
            } finally {
                if (own) {
                    s.label =
                        movedIds.length === 1
                            ? `Moved ${fileLabel(movedIds[0])} to ${folderLabel(targetFolder)}`
                            : `Moved ${plural(Math.max(s.ops.length, movedIds.length), "file")} to ${folderLabel(targetFolder)}`;
                    s.commit();
                }
            }
    };

    ipcMain.handle(
        "move-into-folder",
        (_event, absPaths: string[], targetFolder: string, enforceNoes?: boolean) =>
            moveIntoFolder(absPaths, targetFolder, enforceNoes === true),
    );

    // Before a move: the library files that clash with the target folder's
    // rules (for the confirm): own tags its noes rule out (`tags`), and own
    // noes on tags it gives (`cleared`).
    ipcMain.handle(
        "preview-move-into-folder",
        (_event, absPaths: string[], targetFolder: string) => {
            if (!rootPath || !targetFolder) return [];
            const folder = getFolderByPath(targetFolder);
            if (!folder) return [];
            const targetDir = path.join(rootPath, targetFolder);
            const out: {
                absPath: string;
                fileId: number;
                filename: string;
                tags: string[];
                cleared: string[];
            }[] = [];
            for (const src of absPaths) {
                if (path.dirname(src) === targetDir) continue;
                const rel = path.relative(rootPath, src);
                if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
                const record = getFileByPath(rel);
                if (!record) continue;
                const tags = tagsRuledOutByFolder(record.id, folder.id);
                const cleared = noesGivenByFolder(record.id, folder.id);
                if (tags.length > 0 || cleared.length > 0) {
                    out.push({ absPath: src, fileId: record.id, filename: record.filename, tags, cleared });
                }
            }
            return out;
        },
    );

    // ── Deleting a folder (Browse) ───────────────────────────────────────
    // What deleting would affect, for the confirm: its media files, other
    // files in it (not media: they go to the Trash with the folder either
    // way), subfolders, and what only the folder holds (tags, metadata,
    // profile image).
    ipcMain.handle("folder:delete-preview", async (_event, folderRelPath: string) => {
        if (!rootPath) return null;
        const root = rootPath;
        const files = getFilesByFolder(folderRelPath);
        const tracked = new Set(files.map((f) => f.path));
        let otherFiles = 0;
        let subfolders = 0;
        const walk = async (dir: string): Promise<void> => {
            let entries: import("fs").Dirent[] = [];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue;
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    subfolders++;
                    await walk(abs);
                } else if (!tracked.has(path.relative(root, abs))) {
                    otherFiles++;
                }
            }
        };
        await walk(path.join(root, folderRelPath));
        const folder = getFolderByPath(folderRelPath);
        return {
            files: files.length,
            otherFiles,
            subfolders,
            tags: getTagsForFolderByPath(folderRelPath)
                .filter((t) => !t.inherited)
                .map((t) => t.name),
            metadata: getFolderMetadataByPath(folderRelPath).length,
            profileImage: !!folder?.profile_image_hash,
        };
    });

    // Delete a folder. "unsort": its media moves to the library root
    // (Unsorted) first, keeping scores, tags and history; "trash": it all
    // goes to the Trash. The folder itself (with anything left in it) goes
    // to the Trash, and its tags, metadata and profile image are dropped.
    // If any file can't be moved to Unsorted, nothing is deleted.
    ipcMain.handle(
        "folder:delete",
        async (
            _event,
            folderRelPath: string,
            mode: "trash" | "unsort",
        ): Promise<{ ok: true } | { error: string }> => {
            if (!rootPath) return { error: "No library open." };
            if (!folderRelPath || folderRelPath.split("/").includes("..") || path.isAbsolute(folderRelPath)) {
                return { error: "That isn't a folder in the library." };
            }
            const root = rootPath;
            const dirAbs = path.join(root, folderRelPath);
            const files = getFilesByFolder(folderRelPath);
            const win = BrowserWindow.getAllWindows()[0];
            const step = beginStep(`Deleted ${folderLabel(folderRelPath)}`);

            if (mode === "unsort" && files.length > 0) {
                const { errors } = await moveIntoFolder(
                    files.map((f) => path.join(root, f.path)),
                    "",
                    false,
                    step,
                );
                if (errors.length > 0) {
                        // The files that did move can still be undone.
                    step.label = `Moved files out of ${folderLabel(folderRelPath)}`;
                    step.commit();
                    return {
                        error:
                            `${errors.length} file${errors.length === 1 ? "" : "s"} couldn't be ` +
                            `moved to Unsorted, so the folder was kept. ${errors[0]}.`,
                    };
                }
            }

            // Into the holding folder (undo), not the Trash.
            try {
                if (existsSync(dirAbs)) {
                    const held = await holdingPath(path.basename(dirAbs));
                    const paths = [dirAbs, ...(await listTree(dirAbs))];
                    paths.forEach((p) => ignoredPaths.add(p));
                    try {
                        await fs.rename(dirAbs, held);
                    } finally {
                        setTimeout(() => paths.forEach((p) => ignoredPaths.delete(p)), 1500);
                    }
                    step.disk({
                        kind: "move",
                        from: dirAbs,
                        to: held,
                        folder: {
                            fromRel: folderRelPath,
                            toRel: folderRelPath,
                            mode: "delete",
                            fileIds: mode === "trash" ? files.map((f) => f.id) : [],
                        },
                    });
                }
            } catch (err) {
                console.error("Failed to set folder aside:", dirAbs, err);
                if (step.ops.length > 0 || step.sql.length > 0) {
                    step.label = `Moved files out of ${folderLabel(folderRelPath)}`;
                    step.commit();
                }
                return { error: "Couldn't delete the folder." };
            }

            step.db(() => {
                if (mode === "trash") {
                    for (const f of files) markFileMissingById(f.id);
                }
                deleteFolderTree(folderRelPath);
            });
            step.commit();
            if (mode === "trash") {
                for (const f of files) {
                    win?.webContents.send("media:removed", { relativePath: f.path });
                }
            }
            win?.webContents.send("folder:removed", { relativePath: folderRelPath });
            return { ok: true };
        },
    );

    ipcMain.handle(
        "file:replace",
        async (_event, oldRelPath: string, newAbsPath: string) => {
            if (!rootPath) throw new Error("No library open");
            const win = BrowserWindow.getAllWindows()[0];
            const before = getFileByPath(oldRelPath);
            const step = beginStep(`Replaced ${before?.filename ?? path.basename(oldRelPath)}`);
            const held = await holdingPath(path.basename(oldRelPath));
            await replaceTrackedFile(
                rootPath,
                oldRelPath,
                newAbsPath,
                ignoredPaths,
                { hold: held },
                (fn) => step.db(fn),
            );
            if (before) step.disk({ kind: "swap", fileId: before.id, held });
            step.commit();
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
            const before = getFileByPath(relPath);
            const step = beginStep(`Rotated ${before?.filename ?? path.basename(relPath)}`);
            const held = await rotateTrackedFile(
                rootPath,
                relPath,
                quarterTurns,
                ignoredPaths,
                (fn) => step.db(fn),
            );
            if (before && held) step.disk({ kind: "swap", fileId: before.id, held });
            step.commit();
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

    // Deleting files: into the holding folder (undo), not the Trash; they
    // reach the Trash when they leave the history. One history entry for
    // the lot. Returns the names of files that couldn't be deleted.
    const deleteFiles = async (fileIds: number[]): Promise<string[]> => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!rootPath) throw Error("unable to read rootPath");
        const root = rootPath;
        const step = beginStep(`Deleted ${filesLabel(fileIds)}`);
        const failed: string[] = [];
        for (const fileId of fileIds) {
            const file = getFileById(fileId);
            if (!file) continue;
            try {
                const absolutePath = path.join(root, file.path);
                const held = await holdingPath(file.filename);
                ignoredPaths.add(absolutePath);
                try {
                    await fs.rename(absolutePath, held);
                } finally {
                    setTimeout(() => ignoredPaths.delete(absolutePath), 1500);
                }
                step.disk({ kind: "move", from: absolutePath, to: held, fileId });
                step.db(() => markFileMissingById(fileId));
                win?.webContents.send("media:removed", { relativePath: file.path });
            } catch (error) {
                console.error("Failed to delete file:", error);
                failed.push(file.filename);
            }
        }
        step.meta = { kind: "delete", fileIds };
        step.commit();
        return failed;
    };

    ipcMain.handle("delete-file-by-id", async (_event, fileId: number) => {
        const failed = await deleteFiles([fileId]);
        if (failed.length > 0) throw new Error(`Couldn't delete ${failed[0]}`);
    });
    ipcMain.handle("delete-files", (_event, fileIds: number[]) => deleteFiles(fileIds));

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
        // The tag's id is only known once it's made (or found).
        const meta = { kind: "file-tag" as const, fileId, tagId: 0 };
        record(
            `Tagged ${fileLabel(fileId)} ${quote(tag.trim().toLowerCase())}`,
            () => {
                const { id: tagId } = upsertTag(tag, undefined);
                meta.tagId = tagId;
                addTagToFile(fileId, tagId);
            },
            meta,
        );
        return getTagsForFile(fileId);
    });

    ipcMain.handle("remove-tag", (_event, fileId: number, tag: string) => {
        const existing = getTagByName(tag);
        if (existing) {
            record(
                `Removed ${quote(existing.name)} from ${fileLabel(fileId)}`,
                () => removeTagFromFile(fileId, existing.id),
                { kind: "file-tag", fileId, tagId: existing.id },
            );
        }
        return getTagsForFile(fileId);
    });

    // Generous limit: the picker filters it for Sweep's lists (2 and 3).
    ipcMain.handle("get-related-tags", (_event, tagId: number) => getRelatedTags(tagId, 300));

    ipcMain.handle(
        "add-tag-check-seconds",
        (_event, tagId: number, entries: { fileId: number; seconds: number }[]) =>
            addTagCheckSeconds(tagId, entries),
    );

    // -- Sweep pass mode
    const passWhich = (w: unknown): PassWhich => (w === "all" ? "all" : "needs-firm");
    const passSlot = (s: PassSlot): PassSlot => ({
        tagId: Number(s?.tagId),
        upperId: s?.upperId == null ? null : Number(s.upperId),
    });
    ipcMain.handle(
        "get-pass-files",
        (_event, folderPrefixes: string[] | null, filter: unknown, slot: PassSlot, which: unknown) =>
            getPassFiles(folderPrefixes, validateFilter(filter), passSlot(slot), passWhich(which)),
    );
    ipcMain.handle(
        "get-pass-counts",
        (_event, folderPrefixes: string[] | null, filter: unknown, slots: PassSlot[], which: unknown) =>
            getPassCounts(folderPrefixes, validateFilter(filter), slots.map(passSlot), passWhich(which)),
    );
    ipcMain.handle("prune-pass-list", (_event, slot: PassSlot, fileIds: number[]) =>
        prunePassList(passSlot(slot), fileIds),
    );
    ipcMain.handle("set-pass-no", (_event, fileId: number, tagId: number) =>
        record(`No for ${tagLabel(tagId)} on ${fileLabel(fileId)} (pass)`, () =>
            setPassNo(fileId, tagId),
            { kind: "pass-no", fileId, tagId },
        ),
    );
    ipcMain.handle("clear-pass-no", (_event, fileId: number, tagId: number) =>
        record(`Took back the pass no for ${tagLabel(tagId)} on ${fileLabel(fileId)}`, () =>
            clearPassNo(fileId, tagId),
        ),
    );
    ipcMain.handle("get-firm-noes", (_event, tagId: number, fileIds: number[]) =>
        getFirmNoes(tagId, fileIds),
    );
    ipcMain.handle("get-files-by-ids", (_event, fileIds: number[]) => getFilesByIds(fileIds));
    ipcMain.handle("load-pass-run", () => loadPassRun());
    ipcMain.handle("save-pass-run", (_event, state: string) => savePassRun(state));
    ipcMain.handle("clear-pass-run", () => clearPassRun());
    ipcMain.handle("count-scope", (_event, folderPrefixes: string[] | null, filter: unknown) =>
        countScope(folderPrefixes, validateFilter(filter)),
    );

    ipcMain.handle(
        "get-tag-coverage",
        (_event, folderPrefixes: string[] | null = null, filter: unknown = null) =>
            getTagCoverage(folderPrefixes, validateFilter(filter)),
    );

    ipcMain.handle("get-all-tags", () => {
        return getAllTags();
    });

    ipcMain.handle("get-file-ids-by-filter", (_event, filter: unknown) =>
        getFileIdsByFilter(validateFilter(filter)),
    );

    // -- Feeds (saved tag filters) and recent filters, see feeds.ts

    ipcMain.handle("feeds:list", () => listFeeds());
    const feedLabel = (id: number) => {
        const row = getDb().prepare(`SELECT name FROM feeds WHERE id = ?`).get(id) as { name: string } | undefined;
        return row ? quote(row.name) : "a feed";
    };
    ipcMain.handle("feeds:create", (_event, name: string, tree: unknown) =>
        record(`Saved feed ${quote(name.trim())}`, () => createFeed(name, tree)),
    );
    ipcMain.handle("feeds:update", (_event, id: number, tree: unknown) =>
        record(`Updated feed ${feedLabel(id)}`, () => updateFeedTree(id, tree)),
    );
    ipcMain.handle("feeds:rename", (_event, id: number, name: string) => {
        const before = feedLabel(id);
        return record(`Renamed feed ${before} to ${quote(name.trim())}`, () => renameFeed(id, name));
    });
    ipcMain.handle("feeds:delete", (_event, id: number) =>
        record(`Deleted feed ${feedLabel(id)}`, () => deleteFeed(id)),
    );
    ipcMain.handle("feeds:history", () => getFeedHistory());
    ipcMain.handle(
        "feeds:push-history",
        (_event, entry: { feedId: number } | { tree: unknown }) => pushFeedHistory(entry),
    );
    ipcMain.handle(
        "feeds:using",
        (_event, ref: { tagId: number } | { categoryId: number }) => feedsUsing(ref),
    );
    ipcMain.handle(
        "feeds:count",
        (_event, filter: unknown, folderPrefixes: string[] | null) =>
            countFilter(validateFilter(filter), folderPrefixes),
    );

    // Create a new top-level folder in the library. Returns its relative path,
    // or an error message for the UI.
    // Makes the folder on disk and records it in `step` (not committed).
    const makeFolder = async (
        name: string,
        step: Step,
    ): Promise<{ relativePath: string } | { error: string }> => {
        if (!rootPath) return { error: "No library open." };
        const trimmed = name.trim();
        const invalid = folderNameError(trimmed);
        if (invalid) return { error: invalid };
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
        step.disk({ kind: "mkdir", path: absolutePath, relPath: trimmed });
        step.db(() => upsertFolder(trimmed, trimmed));
        return { relativePath: trimmed };
    };

    ipcMain.handle(
        "create-folder",
        async (
            _event,
            name: string,
        ): Promise<{ relativePath: string } | { error: string }> => {
            const step = beginStep("");
            const made = await makeFolder(name, step);
            if ("relativePath" in made) {
                step.label = `Created ${made.relativePath}`;
                step.commit();
            }
            return made;
        },
    );

    // Filing into a folder made for the purpose: one undo step, so undo
    // puts the files back AND removes the folder.
    ipcMain.handle(
        "move-into-new-folder",
        async (
            _event,
            absPaths: string[],
            name: string,
        ): Promise<{ relativePath: string; moved: number; errors: string[] } | { error: string }> => {
            const step = beginStep("");
            const made = await makeFolder(name, step);
            if ("error" in made) return made;
            try {
                const res = await moveIntoFolder(absPaths, made.relativePath, false, step);
                return { relativePath: made.relativePath, ...res };
            } finally {
                const n = step.ops.filter((o) => o.kind === "move").length;
                step.label = n > 0
                    ? `Moved ${plural(n, "file")} to new folder ${made.relativePath}`
                    : `Created ${made.relativePath}`;
                step.commit();
            }
        },
    );

    ipcMain.handle(
        "add-tag-to-folder",
        (_event, folderRelPath: string, tag: string) => {
            return record(
                (res) => (res.ok ? `Added ${quote(tag.trim().toLowerCase())} to ${folderLabel(folderRelPath)}` : null),
                () => {
                    const folder = upsertFolder(
                        folderRelPath,
                        path.basename(folderRelPath),
                    );
                    const { id: tagId } = upsertTag(tag);
                    return addTagToFolder(folder.id, tagId);
                },
            );
        },
    );

    ipcMain.handle("preview-folder-tag", (_event, folderRelPath: string, tag: string) => {
        const folder = getFolderByPath(folderRelPath);
        const existing = getTagByName(tag.trim().toLowerCase());
        // A brand-new tag or folder row: no file can be marked no for it.
        if (!folder || !existing) return { cleared: [], files: 0, names: [] };
        return previewFolderTag(folder.id, existing.id);
    });

    // ── Folder noes ──
    ipcMain.handle("get-folder-noes", (_event, folderRelPath: string) => {
        const folder = getFolderByPath(folderRelPath);
        return folder ? getNoesForFolder(folder.id) : [];
    });
    ipcMain.handle("preview-folder-no", (_event, folderRelPath: string, tag: string) => {
        const folder = getFolderByPath(folderRelPath);
        const existing = getTagByName(tag.trim().toLowerCase());
        // A brand-new tag or folder row: nothing can clash or come off yet.
        if (!folder || !existing) return { swap: false, removed: [], files: 0 };
        return previewFolderNo(folder.id, existing.id);
    });
    ipcMain.handle("add-folder-no", (_event, folderRelPath: string, tag: string) =>
        record(
            (res) => (res.ok ? `No for ${quote(tag.trim().toLowerCase())} in ${folderLabel(folderRelPath)}` : null),
            () => {
                const folder = upsertFolder(folderRelPath, path.basename(folderRelPath));
                const { id: tagId } = upsertTag(tag);
                return addFolderNo(folder.id, tagId);
            },
        ),
    );
    ipcMain.handle("remove-folder-no", (_event, folderRelPath: string, tag: string) => {
        const folder = getFolderByPath(folderRelPath);
        const existing = getTagByName(tag);
        if (folder && existing) {
            record(`Removed the no for ${quote(existing.name)} from ${folderLabel(folderRelPath)}`, () =>
                removeFolderNo(folder.id, existing.id),
            );
        }
    });

    // ── Noes on files ──
    ipcMain.handle("get-file-noes", (_event, fileId: number) => getNoesForFile(fileId));
    ipcMain.handle("clear-file-no", (_event, fileId: number, tagId: number) =>
        record(`Removed 'no' for ${tagLabel(tagId)} from ${fileLabel(fileId)}`, () =>
            clearFileNo(fileId, tagId),
        ),
    );
    // Batch Tag: the selected files get the tags (yes) or noes (no); the
    // rest of the files shown, if given, get the opposite where undecided
    // (a pass no / the tag). Folder rules win. One history entry.
    const batchTagIds = (tags: string[]) =>
        tags
            .map((t) => getTagByName(t.trim().toLowerCase())?.id)
            .filter((id): id is number => id != null);
    ipcMain.handle(
        "preview-batch-apply",
        (_event, selected: number[], rest: number[], tags: string[], mode: "yes" | "no") =>
            previewBatchApply(selected, rest, batchTagIds(tags), mode),
    );
    ipcMain.handle(
        "batch-apply",
        (_event, selected: number[], rest: number[], tags: string[], mode: "yes" | "no") => {
            const what = mode === "yes" ? `Tagged ${filesLabel(selected)} ${tagsLabel(tags)}` : `Marked ${filesLabel(selected)} as no for ${tagsLabel(tags)}`;
            const label = rest.length > 0 ? `${what} (and the opposite on ${plural(rest.length, "other file")})` : what;
            return record(label, () => batchApply(selected, rest, batchTagIds(tags), mode));
        },
    );

    // A folder rule turned into one on each file (the folder's files keep
    // it as their own; new files won't get it).
    ipcMain.handle("folder:count-files", (_event, folderRelPath: string) => {
        const folder = getFolderByPath(folderRelPath);
        return folder ? countFolderFiles(folder.id) : 0;
    });
    ipcMain.handle(
        "folder:convert-rule",
        (_event, folderRelPath: string, tag: string, kind: "tag" | "no") => {
            const folder = getFolderByPath(folderRelPath);
            const existing = getTagByName(tag);
            if (!folder || !existing) return 0;
            // Both halves: the folder's rule goes, each file gets its own.
            const label =
                kind === "tag"
                    ? `Removed ${quote(existing.name)} from ${folder.name} and gave each of its files the tag`
                    : `Removed 'no' for ${quote(existing.name)} from ${folder.name} and gave each of its files a 'no'`;
            return record(label, () => convertFolderRule(folder.id, existing.id, kind));
        },
    );
    ipcMain.handle(
        "get-conflict-files",
        (_event, tagId: number, folderPrefixes: string[] | null = null, filter: unknown = null) =>
            getConflictFiles(tagId, folderPrefixes, validateFilter(filter)),
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
            filter: unknown,
            excludeIds: number[] = [],
            withoutTagId: number | null = null,
        ) => {
            return getRandomFile(
                folderPrefixes,
                validateFilter(filter),
                excludeIds,
                withoutTagId,
            );
        },
    );

    // -- Comparisons

    ipcMain.handle(
        "get-pair",
        (
            _event,
            folderPrefixes: string[] | null,
            filter: unknown,
        ) => {
            return getWeightedPair(folderPrefixes, validateFilter(filter));
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
        ) => refitPair(ids, pool(laneA), pool(laneB), kingSide, recentIds),
    );

    ipcMain.handle(
        "get-challenger",
        (
            _event,
            kingId: number,
            folderPrefixes: string[] | null,
            filter: unknown,
            recentIds: number[],
        ) => {
            return getChallenger(
                kingId,
                folderPrefixes,
                validateFilter(filter),
                recentIds,
            );
        },
    );

    ipcMain.handle(
        "record-comparison",
        (_event, winnerId: number, loserId: number) =>
            ranksChanged(
                record(
                    `Picked ${fileLabel(winnerId)} over ${fileLabel(loserId)}`,
                    () => recordComparison(winnerId, loserId, rootPath ?? "all"),
                    { kind: "compare", winnerId, loserId },
                ),
            ),
    );

    // Placement (see placement.ts).
    ipcMain.handle(
        "placement:candidate",
        (
            _event,
            laneA: PoolFilter,
            laneB: PoolFilter,
            matches: number,
            opponentPool?: PoolFilter,
        ) =>
            getPlacementCandidate(
                pool(laneA),
                pool(laneB),
                matches,
                opponentPool && pool(opponentPool),
            ),
    );
    ipcMain.handle(
        "placement:count",
        (_event, laneA: PoolFilter, laneB: PoolFilter, matches: number) =>
            countPlacementCandidates(pool(laneA), pool(laneB), matches),
    );
    ipcMain.handle(
        "placement:bounds",
        (_event, fileId: number, p: PoolFilter, matches: number) =>
            initialPlacementBounds(fileId, pool(p), matches),
    );
    ipcMain.handle(
        "placement:opponent",
        (
            _event,
            fileId: number,
            p: PoolFilter,
            matches: number,
            bounds: PlacementBounds,
            recentIds: number[],
        ) => getPlacementOpponent(fileId, pool(p), matches, bounds, recentIds),
    );
    ipcMain.handle(
        "placement:record",
        (
            _event,
            placingId: number,
            opponentId: number,
            placingWon: boolean,
            p: PoolFilter,
            matches: number,
            bounds: PlacementBounds,
        ) =>
            ranksChanged(
                record(
                    placingWon
                        ? `Picked ${fileLabel(placingId)} over ${fileLabel(opponentId)}`
                        : `Picked ${fileLabel(opponentId)} over ${fileLabel(placingId)}`,
                    () =>
                        recordPlacement(
                            placingId,
                            opponentId,
                            placingWon,
                            pool(p),
                            matches,
                            bounds,
                            rootPath ?? "all",
                        ),
                    { kind: "placement", placingId, opponentId },
                ),
            ),
    );


    // tag manager

    ipcMain.handle(
        "create-tag",
        (_event, name: string, categoryId: number | null) => {
            // An existing tag is returned as is (upsert would move it into
            // this category).
            return (
                getTagByName(name) ??
                record(`Created tag ${quote(name.trim().toLowerCase())}`, () => upsertTag(name, categoryId))
            );
        },
    );

    ipcMain.handle("get-tag-usage", (_event, id: number) => getTagUsage(id));

    ipcMain.handle("count-missing-files", () => countMissingFiles());
    ipcMain.handle("get-library-ranks", () => getLibraryRanks());
    ipcMain.handle("delete-missing-files", () =>
        record((n) => (n > 0 ? `Removed ${plural(n, "missing file")}` : null), () => deleteMissingFiles()),
    );

    ipcMain.handle(
        "merge-tags",
        (_event, sourceId: number, targetId: number) => {
            const label = `Merged ${tagLabel(sourceId)} into ${tagLabel(targetId)}`;
            return record((res) => ((res as { ok?: boolean }).ok === false ? null : label), () =>
                mergeTags(sourceId, targetId),
            );
        },
    );

    const categoryLabel = (id: number | null) => {
        if (id == null) return "Uncategorized";
        const row = getDb().prepare(`SELECT name FROM tag_categories WHERE id = ?`).get(id) as { name: string } | undefined;
        return row?.name ?? "a category";
    };
    ipcMain.handle("set-tag-sweep", (_event, tagId: number, on: boolean) =>
        record(`${on ? "Offered" : "Stopped offering"} ${tagLabel(tagId)} in the tag pointer`, () =>
            setTagSweep(tagId, on),
        ),
    );
    ipcMain.handle(
        "set-category-tags-sweep",
        (_event, categoryId: number, on: boolean) =>
            record(`${on ? "Offered" : "Stopped offering"} ${categoryLabel(categoryId)} tags in the tag pointer`, () =>
                setCategoryTagsSweep(categoryId, on),
            ),
    );

    ipcMain.handle(
        "reorder-tags",
        (_event, categoryId: number | null, tagIds: number[]) =>
            record(`Reordered tags in ${categoryLabel(categoryId)}`, () =>
                reorderTags(categoryId, tagIds),
            ),
    );

    // Sweep's full screen: the window's own, so Esc reaches the page
    // (the browser's full screen always takes Esc for itself).
    ipcMain.handle("set-fullscreen", (event, on: boolean) => {
        BrowserWindow.fromWebContents(event.sender)?.setFullScreen(on);
    });

    ipcMain.handle("get-tag-implications", () => getTagImplications());

    ipcMain.handle(
        "preview-tag-implication",
        (_event, tagId: number, impliesId: number, action: "add" | "remove") =>
            previewTagImplication(tagId, impliesId, action),
    );

    ipcMain.handle(
        "add-tag-implication",
        (_event, tagId: number, impliesId: number) => {
            const label = `Linked ${tagLabel(tagId)} → ${tagLabel(impliesId)}`;
            return record((res) => ((res as { ok?: boolean }).ok === false ? null : label), () =>
                addTagImplication(tagId, impliesId),
            );
        },
    );

    ipcMain.handle(
        "remove-tag-implication",
        (_event, tagId: number, impliesId: number) =>
            record(`Unlinked ${tagLabel(tagId)} → ${tagLabel(impliesId)}`, () =>
                removeTagImplication(tagId, impliesId),
            ),
    );

    ipcMain.handle(
        "update-tag",
        (_event, id: number, name: string, categoryId: number | null) => {
            const beforeName = tagLabel(id);
            const beforeCat = (getDb().prepare(`SELECT category_id FROM tags WHERE id = ?`).get(id) as
                | { category_id: number | null }
                | undefined)?.category_id;
            const newName = quote(name.trim().toLowerCase());
            return record(
                (res) => {
                    if (!res.ok) return null;
                    if (beforeName !== newName) return `Renamed tag ${beforeName} to ${newName}`;
                    if (beforeCat !== categoryId) return `Moved ${newName} to ${categoryLabel(categoryId)}`;
                    return `Edited tag ${newName}`;
                },
                () => updateTag(id, name, categoryId),
            );
        },
    );

    ipcMain.handle("delete-tag", (_event, id: number) => {
        record(`Deleted tag ${tagLabel(id)}`, () => deleteTag(id));
    });

    ipcMain.handle("get-all-tag-categories", (_event) => {
        return getAllTagCategories();
    });

    ipcMain.handle(
        "create-tag-category",
        (_event, name: string, color: string, icon: string) => {
            return record(`Created category ${name.trim()}`, () => upsertTagCategory(name, color, icon));
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
                sweep?: number;
            },
        ) => {
            const before = categoryLabel(id);
            record(
                updates.name && updates.name.trim() !== before
                    ? `Renamed category ${before} to ${updates.name.trim()}`
                    : updates.sweep != null && Object.keys(updates).length === 1
                      ? `${updates.sweep ? "Offered" : "Stopped offering"} ${before} in the tag pointer`
                      : `Edited category ${before}`,
                () => updateTagCategory(id, updates),
            );
        },
    );

    ipcMain.handle("delete-tag-category", (_event, id: number) => {
        record(`Deleted category ${categoryLabel(id)}`, () => deleteTagCategory(id));
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

// The standard menus, except Edit's Undo/Redo: the page decides whether
// ⌘Z undoes typing (in a text field) or the app's history.
function setAppMenu(): void {
    const toPage = (action: "undo" | "redo") => () =>
        BrowserWindow.getAllWindows()[0]?.webContents.send("history:key", action);
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
            { role: "fileMenu" },
            {
                label: "Edit",
                submenu: [
                    { label: "Undo", accelerator: "CmdOrCtrl+Z", click: toPage("undo") },
                    { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: toPage("redo") },
                    { type: "separator" },
                    { role: "cut" },
                    { role: "copy" },
                    { role: "paste" },
                    { role: "pasteAndMatchStyle" },
                    { role: "delete" },
                    { role: "selectAll" },
                ],
            },
            { role: "viewMenu" },
            { role: "windowMenu" },
        ]),
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

/**
 * A file as a web stream for protocol responses. Handing a Node stream to
 * Response lets undici close it after the page has already cancelled the
 * request (a video swapped out mid-load, e.g. after rotating), which
 * throws "ReadableStream is already closed" in the main process. Here a
 * cancel stops the read, and nothing is enqueued or closed after that.
 */
function fileStream(
    filePath: string,
    range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
    let file: ReturnType<typeof createReadStream> | null = null;
    let finished = false;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            file = createReadStream(filePath, range);
            file.on("data", (chunk) => {
                if (finished) return;
                controller.enqueue(chunk as Buffer);
                // Backpressure: wait for pull() before reading more.
                if ((controller.desiredSize ?? 1) <= 0) file?.pause();
            });
            file.on("end", () => {
                if (finished) return;
                finished = true;
                controller.close();
            });
            file.on("error", (err) => {
                if (finished) return;
                finished = true;
                controller.error(err);
            });
        },
        pull() {
            file?.resume();
        },
        cancel() {
            finished = true;
            file?.destroy();
        },
    });
}

// media:// serves the library's files. Registered as a privileged scheme
// (before the app is ready) so Web Audio can read videos' sound: without
// CORS support, a video routed through Web Audio plays silence. stream:
// keeps range requests (seeking) working for video.
protocol.registerSchemesAsPrivileged([
    {
        scheme: "media",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
        },
    },
]);

// Any page may read media:// responses (the app's own pages only; it's a
// local scheme), so <video crossOrigin> can feed Web Audio.
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

app.whenReady().then(() => {
    protocol.handle("media", async (request) => {
        // Drop any ?query: it only versions the URL (so a rotated file isn't
        // served from cache), it isn't part of the path.
        const [url, query = ""] = request.url.replace("media://local", "").split("?");
        let filePath = decodeURIComponent(url);
        // An older version of a rotated video, still being streamed by the
        // player it's handing over from: serve those bytes, not the new file.
        const version = new URLSearchParams(query).get("v");
        if (rootPath && version && /^[0-9a-f]+$/i.test(version)) {
            const previous = previousVersionPath(rootPath, version, path.extname(filePath));
            if (existsSync(previous)) filePath = previous;
        }
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

                return new Response(fileStream(filePath, { start, end }), {
                    status: 206,
                    headers: {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": String(chunkSize),
                        "Content-Type": contentType,
                        ...CORS_HEADERS,
                    },
                });
            } else {
                return new Response(fileStream(filePath), {
                    status: 200,
                    headers: {
                        "Content-Length": String(fileSize),
                        "Content-Type": contentType,
                        "Accept-Ranges": "bytes",
                        ...CORS_HEADERS,
                    },
                });
            }
        } catch (err) {
            console.error("protocol error:", err);
            return new Response("Not found", { status: 404, headers: CORS_HEADERS });
        }
    });

    registerIpcHandlers();
    setAppMenu();
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
