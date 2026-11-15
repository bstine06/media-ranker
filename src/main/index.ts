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
    getFileIdsByFilter,
    addTagToFolder,
    getDb,
    updateEloScores,
    undoComparison,
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
    moveFileRecord,
    getRootFiles,
    countRootFiles,
    getTagUsage,
    mergeTags,
    addTagCheckSeconds,
    getTagCoverage,
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
    getLanePair,
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
import { watchFolder, unwatchAll, ignoredPaths } from "./watcher";
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
    const moveIntoFolder = async (
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
    };

    ipcMain.handle(
        "move-into-folder",
        (_event, absPaths: string[], targetFolder: string) =>
            moveIntoFolder(absPaths, targetFolder),
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

            if (mode === "unsort" && files.length > 0) {
                const { errors } = await moveIntoFolder(
                    files.map((f) => path.join(root, f.path)),
                    "",
                );
                if (errors.length > 0) {
                    return {
                        error:
                            `${errors.length} file${errors.length === 1 ? "" : "s"} couldn't be ` +
                            `moved to Unsorted, so the folder was kept. ${errors[0]}.`,
                    };
                }
            }

            try {
                if (existsSync(dirAbs)) await shell.trashItem(dirAbs);
            } catch (err) {
                console.error("Failed to trash folder:", dirAbs, err);
                return { error: "Couldn't move the folder to the Trash." };
            }

            if (mode === "trash") {
                for (const f of files) {
                    markFileMissingById(f.id);
                    win?.webContents.send("media:removed", { relativePath: f.path });
                }
            }
            deleteFolderTree(folderRelPath);
            win?.webContents.send("folder:removed", { relativePath: folderRelPath });
            return { ok: true };
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

    // Generous limit: the picker filters it for Sweep's lists (2 and 3).
    ipcMain.handle("get-related-tags", (_event, tagId: number) => getRelatedTags(tagId, 300));

    ipcMain.handle(
        "add-tag-check-seconds",
        (_event, tagId: number, entries: { fileId: number; seconds: number }[]) =>
            addTagCheckSeconds(tagId, entries),
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
    ipcMain.handle("feeds:create", (_event, name: string, tree: unknown) =>
        createFeed(name, tree),
    );
    ipcMain.handle("feeds:update", (_event, id: number, tree: unknown) =>
        updateFeedTree(id, tree),
    );
    ipcMain.handle("feeds:rename", (_event, id: number, name: string) =>
        renameFeed(id, name),
    );
    ipcMain.handle("feeds:delete", (_event, id: number) => deleteFeed(id));
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
    ipcMain.handle(
        "create-folder",
        async (
            _event,
            name: string,
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
        "get-lane-pair",
        (_event, laneA: PoolFilter, laneB: PoolFilter) => {
            return getLanePair(pool(laneA), pool(laneB));
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
            ranksChanged(recordComparison(winnerId, loserId, rootPath ?? "all")),
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
                recordPlacement(
                    placingId,
                    opponentId,
                    placingWon,
                    pool(p),
                    matches,
                    bounds,
                    rootPath ?? "all",
                ),
            ),
    );

    ipcMain.handle(
        "undo-comparison",
        (_event, comparisonId: number, fileIds: number[]) => {
            if (!undoComparison(comparisonId)) return null;
            ranksChanged(null);
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
            // An existing tag is returned as is (upsert would move it into
            // this category).
            return getTagByName(name) ?? upsertTag(name, categoryId);
        },
    );

    ipcMain.handle("get-tag-usage", (_event, id: number) => getTagUsage(id));

    ipcMain.handle("count-missing-files", () => countMissingFiles());
    ipcMain.handle("get-library-ranks", () => getLibraryRanks());
    ipcMain.handle("delete-missing-files", () => deleteMissingFiles());

    ipcMain.handle(
        "merge-tags",
        (_event, sourceId: number, targetId: number) => {
            return mergeTags(sourceId, targetId);
        },
    );

    ipcMain.handle("set-tag-sweep", (_event, tagId: number, on: boolean) =>
        setTagSweep(tagId, on),
    );
    ipcMain.handle(
        "set-category-tags-sweep",
        (_event, categoryId: number, on: boolean) => setCategoryTagsSweep(categoryId, on),
    );

    ipcMain.handle(
        "reorder-tags",
        (_event, categoryId: number | null, tagIds: number[]) =>
            reorderTags(categoryId, tagIds),
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
        (_event, tagId: number, impliesId: number) =>
            addTagImplication(tagId, impliesId),
    );

    ipcMain.handle(
        "remove-tag-implication",
        (_event, tagId: number, impliesId: number) =>
            removeTagImplication(tagId, impliesId),
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
            return upsertTagCategory(name, color, icon);
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
                    },
                });
            } else {
                return new Response(fileStream(filePath), {
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
