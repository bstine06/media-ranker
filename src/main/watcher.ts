// main/watcher.ts
import chokidar, { FSWatcher } from "chokidar";
import { join, relative, extname, basename } from "path";
import { statSync, existsSync } from "fs";
import { BrowserWindow } from "electron";
import {
    upsertFile,
    getFileByPath,
    getFileByHash,
    deleteFileByPath,
    getFilesByPathPrefix,
    renameFolderPaths,
    markFileMissing,
    getFileByPathAny,
    getFileByHashAny,
    setFileStatus,
    getFolderByPath,
    upsertFolder,
    deleteFolderByPath,
    renameFolderPath,
    applyFolderTagsToFile,
    updateFileFolderAndPath,
    type DbFile,
} from "./db";
import {
    generateSizedImage,
    getMediaType,
    ensureDir,
    hashFile,
    type MediaType,
} from "./scanner";
import { saveRootPath, INTERNAL_NAMES } from "./config";
import { unlink } from "fs/promises";
import { pendingAppRenames } from "./index";

const RENAME_WINDOW_MS = 2000;
const watchers = new Map<string, FSWatcher>();

export const ignoredPaths = new Set<string>();

// Always grab the current, live window rather than closing over a reference
// that may later point to a destroyed BrowserWindow (e.g. after the window
// is closed and recreated via app.on("activate") on macOS).
function getActiveWindow(): BrowserWindow | null {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.isDestroyed() ? win : null;
}

// Pending unlinks: hash -> { relativePath, timer }
// Populated when unlink fires first (Windows / Linux ordering)
const pendingUnlinks = new Map<
    string,
    {
        relativePath: string;
        timer: ReturnType<typeof setTimeout>;
    }
>();

// Pending adds: hash -> { relativePath, filename, mtime, mediaType, timer }
// Populated when add fires first (macOS ordering)
const pendingAdds = new Map<
    string,
    {
        relativePath: string;
        filename: string;
        mtime: number;
        mediaType: "photo" | "gif" | "video";
        timer: ReturnType<typeof setTimeout>;
    }
>();

// Pending folder unlinks: oldRelativeDir -> timer
// Populated when unlinkDir fires first (Windows / Linux ordering)
const pendingDirUnlinks = new Map<
    string,
    {
        timer: ReturnType<typeof setTimeout>;
    }
>();

// Pending folder adds: dirName -> { newRelativeDir, timer }
// Populated when addDir fires first (macOS ordering)
const pendingDirAdds = new Map<
    string,
    {
        newRelativeDir: string;
        timer: ReturnType<typeof setTimeout>;
    }
>();

async function waitUntilFileStable(
    filePath: string,
    intervalMs = 200,
    maxWaitMs = 300_000,
): Promise<void> {
    let lastSize = -1;
    let waited = 0;
    while (waited < maxWaitMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        waited += intervalMs;
        try {
            const { size } = statSync(filePath);
            if (size === lastSize && size > 0) return;
            lastSize = size;
        } catch {
            // file might not be visible yet, keep waiting
        }
    }
    throw new Error(`File never stabilized: ${filePath}`);
}

export function watchFolder(rootPath: string, _win: BrowserWindow): void {
    if (watchers.has(rootPath)) return;

    const thumbDir = join(rootPath, "_thumbnails");
    ensureDir(thumbDir);

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Folders are top-level, as in the scanner and in-app moves: a file
    // anywhere under "cats/" belongs to "cats". null = library root.
    function topFolderId(relativePath: string): number | null {
        const parts = relativePath.split(/[\\/]/);
        if (parts.length < 2) return null;
        const top = parts[0];
        return (getFolderByPath(top) ?? upsertFolder(top, top)).id;
    }

    // A tracked file moved on disk (Finder, another app): point the record at
    // the new path, file it under the folder it's in now, and give it that
    // folder's tags, the same as moving it inside the app.
    function commitFileMove(
        record: DbFile,
        relativePath: string,
        mtime: number,
    ): void {
        const folderId = topFolderId(relativePath);
        updateFileFolderAndPath(
            record.content_hash,
            relativePath,
            basename(relativePath),
            mtime,
            folderId,
        );
        if (folderId != null && folderId !== record.folder_id) {
            applyFolderTagsToFile(record.id, folderId);
        }
    }

    // A file's thumbnail is deleted when it goes missing, so one coming back
    // (restored from the Trash, moved back in) needs it rebuilt. No-op when
    // the thumbnail is still there.
    async function ensureThumbnail(
        filePath: string,
        hash: string,
        mediaType: MediaType,
    ): Promise<void> {
        await generateSizedImage(
            filePath,
            join(thumbDir, `${hash}.jpg`),
            400,
            mediaType,
        ).catch((err) => console.warn("Thumbnail failed for", filePath, err));
    }

    // Rewrites all DB records under oldRelativeDir to newRelativeDir and
    // emits media:renamed for each affected file.
    function commitFolderRename(
        oldRelativeDir: string,
        newRelativeDir: string,
    ): void {
        const affected = getFilesByPathPrefix(oldRelativeDir); // fetch before rewriting
        renameFolderPaths(oldRelativeDir, newRelativeDir); // single atomic UPDATE
        renameFolderPath(oldRelativeDir, newRelativeDir);
        for (const record of affected) {
            const newRelativePath =
                newRelativeDir + record.path.slice(oldRelativeDir.length);
            getActiveWindow()?.webContents.send("media:renamed", {
                oldRelativePath: record.path,
                relativePath: newRelativePath,
                hash: record.content_hash,
                mediaType: record.media_type,
            });
        }
        getActiveWindow()?.webContents.send("folder:renamed", {
            oldRelativePath: oldRelativeDir,
            relativePath: newRelativeDir,
        });
    }

    const watcher = chokidar.watch(rootPath, {
        ignored: (filePath: string) => {
            if (ignoredPaths.has(filePath)) return true;
            const seg = filePath.replace(rootPath, "").split(/[\\/]/);
            // Ignore dot-files/folders (system files, .DS_Store, .git, etc.)
            if (seg.some((s) => s.startsWith("."))) return true;
            // Ignore only known internal app paths, not all underscore-prefixed names
            if (seg.some((s) => INTERNAL_NAMES.has(s))) return true;
            return false;
        },
        persistent: true,
        ignoreInitial: true,
    });

    // ── File added ────────────────────────────────────────────────────────────
    watcher.on("add", async (filePath) => {
        const mediaType = getMediaType(extname(filePath));
        if (!mediaType) return;

        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
            filePath,
            setTimeout(async () => {
                debounceTimers.delete(filePath);
                try {
                    await waitUntilFileStable(filePath);
                    // Library closed / switched while we waited.
                    if (watchers.get(rootPath) !== watcher) return;

                    const stat = statSync(filePath);
                    const relativePath = relative(rootPath, filePath);
                    const hash = await hashFile(filePath);

                    // ── Case 1: unlink fired first (Windows/Linux) ──────────────────
                    const pendingUnlink = pendingUnlinks.get(hash);
                    if (pendingUnlink) {
                        clearTimeout(pendingUnlink.timer);
                        pendingUnlinks.delete(hash);
                        const moved = getFileByHashAny(hash);
                        if (moved) commitFileMove(moved, relativePath, stat.mtimeMs);
                        getActiveWindow()?.webContents.send("media:renamed", {
                            oldRelativePath: pendingUnlink.relativePath,
                            relativePath,
                            hash,
                            mediaType,
                        });
                        return;
                    }

                    const existingRecord = getFileByHashAny(hash);

                    // ── Case 2: file returning from trash (same path, was missing) ───
                    if (
                        existingRecord?.status === "missing" &&
                        existingRecord.path === relativePath
                    ) {
                        await ensureThumbnail(filePath, hash, mediaType);
                        setFileStatus(hash, "active");
                        getActiveWindow()?.webContents.send("media:added", {
                            relativePath,
                            hash,
                            mediaType,
                        });

                        return;
                    }

                    // ── Case 3: add fires first (macOS rename) ───────────────────────
                    if (
                        existingRecord &&
                        existingRecord.path !== relativePath
                    ) {
                        const timer = setTimeout(async () => {
                          try {
                            pendingAdds.delete(hash);
                            // No unlink arrived and the original is still
                            // there: this is a copy (e.g. Finder's Duplicate),
                            // not a move. Leave the record on the original.
                            if (
                                existingRecord.status === "active" &&
                                existsSync(join(rootPath, existingRecord.path))
                            ) {
                                return;
                            }
                            commitFileMove(existingRecord, relativePath, stat.mtimeMs);
                            if (existingRecord.status === "missing") {
                                await ensureThumbnail(filePath, hash, mediaType);
                                setFileStatus(hash, "active");
                                getActiveWindow()?.webContents.send("media:added", {
                                    relativePath,
                                    hash,
                                    mediaType,
                                });
                            } else {
                                getActiveWindow()?.webContents.send("media:renamed", {
                                    oldRelativePath: existingRecord.path,
                                    relativePath,
                                    hash,
                                    mediaType,
                                });
                            }
                          } catch (err) {
                            console.error("Watcher failed to process:", filePath, err);
                          }
                        }, RENAME_WINDOW_MS);

                        pendingAdds.set(hash, {
                            relativePath,
                            filename: basename(filePath),
                            mtime: stat.mtimeMs,
                            mediaType,
                            timer,
                        });
                        return;
                    }

                    // ── Case 4: genuinely new file ───────────────────────────────────
                    const thumbPath = join(thumbDir, `${hash}.jpg`);
                    await generateSizedImage(
                        filePath,
                        thumbPath,
                        400,
                        mediaType,
                    ).catch(() => {});

                    const inserted = upsertFile({
                        content_hash: hash,
                        path: relativePath,
                        filename: basename(filePath),
                        media_type: mediaType,
                        mtime: stat.mtimeMs,
                        size: stat.size,
                        status: "active",
                        missing_since: null,
                        folder_id: topFolderId(relativePath),
                    });
                    if (inserted.folder_id != null) {
                        applyFolderTagsToFile(inserted.id, inserted.folder_id);
                    }

                    getActiveWindow()?.webContents.send("media:added", {
                        relativePath,
                        hash,
                        mediaType,
                    });
                } catch (err) {
                    console.error("Watcher failed to process:", filePath, err);
                }
            }, 500),
        );
    });

    // ── File removed ──────────────────────────────────────────────────────────
    watcher.on("unlink", (filePath) => {
        const relativePath = relative(rootPath, filePath);
        const record = getFileByPathAny(relativePath);

        if (!record) return;
        if (record.status === "missing") return;

        // ── Case 1: add fired first (macOS) ─────────────────────────────────
        const pendingAdd = pendingAdds.get(record.content_hash);
        if (pendingAdd) {
            clearTimeout(pendingAdd.timer);
            pendingAdds.delete(record.content_hash);
            commitFileMove(record, pendingAdd.relativePath, pendingAdd.mtime);
            getActiveWindow()?.webContents.send("media:renamed", {
                oldRelativePath: relativePath,
                relativePath: pendingAdd.relativePath,
                hash: record.content_hash,
                mediaType: pendingAdd.mediaType,
            });
            return;
        }

        // ── Case 2: unlink fires first (Windows/Linux) ──────────────────────
        const { content_hash } = record;
        const timer = setTimeout(() => {
            try {
                pendingUnlinks.delete(content_hash);
                markFileMissing(relativePath);
                unlink(join(thumbDir, `${content_hash}.jpg`)).catch((err) => {
                    if (err.code !== "ENOENT") {
                        console.error(
                            "Failed to delete thumbnail:",
                            content_hash,
                            err,
                        );
                    }
                });
                getActiveWindow()?.webContents.send("media:removed", { relativePath });
            } catch (err) {
                console.error("Failed to process file removal:", relativePath, err);
            }
        }, RENAME_WINDOW_MS);

        pendingUnlinks.set(content_hash, { relativePath, timer });
    });

    // ── Folder removed ────────────────────────────────────────────────────────
    watcher.on("unlinkDir", (dirPath) => {
        const oldRelativeDir = relative(rootPath, dirPath);

        // Root folder itself was renamed/moved — signal the frontend to reset
        if (oldRelativeDir === "") {
            saveRootPath(null);
            getActiveWindow()?.webContents.send("library:invalid");
            return;
        }

        if (pendingAppRenames.has(dirPath)) {
            pendingAppRenames.delete(dirPath);
            return;
        }

        const dirName = basename(dirPath);

        // ── Case 1: addDir fired first (macOS) ──────────────────────────────
        // A pending add exists for this dirname — pair it up and commit.
        const pendingAdd = pendingDirAdds.get(dirName);
        if (pendingAdd) {
            clearTimeout(pendingAdd.timer);
            pendingDirAdds.delete(dirName);
            commitFolderRename(oldRelativeDir, pendingAdd.newRelativeDir);
            return;
        }

        // ── Case 2: unlinkDir fires first (Windows/Linux) ───────────────────
        // Hold the delete and wait to see if a matching addDir arrives.
        const timer = setTimeout(() => {
            try {
                pendingDirUnlinks.delete(oldRelativeDir);
                deleteFolderByPath(oldRelativeDir);
                const affected = getFilesByPathPrefix(oldRelativeDir);
                for (const record of affected) {
                    markFileMissing(record.path);
                    unlink(join(thumbDir, `${record.content_hash}.jpg`)).catch(
                        (err) => {
                            if (err.code !== "ENOENT") {
                                console.error(
                                    "Failed to delete thumbnail:",
                                    record.content_hash,
                                    err,
                                );
                            }
                        },
                    );
                    getActiveWindow()?.webContents.send("media:removed", {
                        relativePath: record.path,
                    });
                }
                getActiveWindow()?.webContents.send("folder:removed", {
                    relativePath: oldRelativeDir,
                });
            } catch (err) {
                console.error("Failed to process folder removal:", oldRelativeDir, err);
            }
        }, RENAME_WINDOW_MS);

        pendingDirUnlinks.set(oldRelativeDir, { timer });
    });

    // ── Folder added ──────────────────────────────────────────────────────────
    watcher.on("addDir", (dirPath) => {
        const newRelativeDir = relative(rootPath, dirPath);

        // Ignore the root itself which fires on watcher init.
        if (newRelativeDir === "") return;

        // Bail early if this is a rename from the app, managed at the ipc handler
        if (pendingAppRenames.has(dirPath)) {
            pendingAppRenames.delete(dirPath);
            return; // IPC handler already took care of it
        }

        const dirName = basename(dirPath);

        // ── Case 1: unlinkDir fired first (Windows/Linux) ───────────────────
        // Find a pending unlink whose dirname matches — that's our rename pair.
        for (const [oldRelativeDir, pending] of pendingDirUnlinks) {
            if (basename(oldRelativeDir) === dirName) {
                clearTimeout(pending.timer);
                pendingDirUnlinks.delete(oldRelativeDir);
                commitFolderRename(oldRelativeDir, newRelativeDir);
                return;
            }
        }

        // ── Case 2: addDir fires first (macOS) ──────────────────────────────
        // Hold off and wait for the matching unlinkDir. If none arrives within
        // the window it's a genuinely new folder; individual `add` events for
        // its contents will handle any files inside.
        const timer = setTimeout(() => {
            try {
                pendingDirAdds.delete(dirName);
                upsertFolder(newRelativeDir, dirName);
                getActiveWindow()?.webContents.send("folder:added", {
                    relativePath: newRelativeDir,
                });
            } catch (err) {
                console.error("Failed to process folder add:", newRelativeDir, err);
            }
        }, RENAME_WINDOW_MS);

        pendingDirAdds.set(dirName, { newRelativeDir, timer });
    });

    watcher.on("error", (err) => console.error("Watcher error:", err));

    watchers.set(rootPath, watcher);
}

export async function unwatchFolder(rootPath: string): Promise<void> {
    const w = watchers.get(rootPath);
    if (w) {
        await w.close();
        watchers.delete(rootPath);
    }
}

export async function unwatchAll(): Promise<void> {
    for (const [path, w] of watchers) {
        await w.close();
        watchers.delete(path);
    }
    // Drop rename-detection timers still pending from the old library, so
    // they don't fire against whatever library is opened next.
    for (const pending of [pendingUnlinks, pendingAdds, pendingDirUnlinks, pendingDirAdds]) {
        for (const { timer } of pending.values()) clearTimeout(timer);
        pending.clear();
    }
}