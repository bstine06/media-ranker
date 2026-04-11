// main/watcher.ts
import chokidar, { FSWatcher } from "chokidar";
import { join, relative, extname, basename } from "path";
import { statSync } from "fs";
import { BrowserWindow } from "electron";
import {
    upsertFile,
    getFileByPath,
    getFileByHash,
    deleteFileByPath,
    updateFilePath,
    getFilesByPathPrefix,
    renameFolderPaths,
    markFileMissing,
    getFileByPathAny,
    getFileByHashAny,
    setFileStatus,
} from "./db";
import {
    generateSizedImage,
    getMediaType,
    ensureDir,
    hashFile,
} from "./scanner";
import { saveRootPath } from "./config";

const RENAME_WINDOW_MS = 2000;
const watchers = new Map<string, FSWatcher>();

export const ignoredPaths = new Set<string>();

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

export function watchFolder(rootPath: string, win: BrowserWindow): void {
    if (watchers.has(rootPath)) return;

    const thumbDir = join(rootPath, "_thumbnails");
    ensureDir(thumbDir);

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Rewrites all DB records under oldRelativeDir to newRelativeDir and
    // emits media:renamed for each affected file.
    function commitFolderRename(
        oldRelativeDir: string,
        newRelativeDir: string,
    ): void {
        const affected = getFilesByPathPrefix(oldRelativeDir); // fetch before rewriting
        renameFolderPaths(oldRelativeDir, newRelativeDir); // single atomic UPDATE
        for (const record of affected) {
            const newRelativePath =
                newRelativeDir + record.path.slice(oldRelativeDir.length);
            win.webContents.send("media:renamed", {
                oldRelativePath: record.path,
                relativePath: newRelativePath,
                hash: record.content_hash,
                mediaType: record.media_type,
            });
        }
        win.webContents.send("folder:renamed", {
            oldRelativePath: oldRelativeDir,
            relativePath: newRelativeDir,
        });
    }

    const watcher = chokidar.watch(rootPath, {
        ignored: (filePath: string) => {
            if (ignoredPaths.has(filePath)) return true;
            const seg = filePath.replace(rootPath, "").split(/[\\/]/);
            return seg.some((s) => s.startsWith(".") || s.startsWith("_"));
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

                    const stat = statSync(filePath);
                    const relativePath = relative(rootPath, filePath);
                    const hash = await hashFile(filePath);

                    // ── Case 1: unlink fired first (Windows/Linux) ──────────────────
                    const pendingUnlink = pendingUnlinks.get(hash);
                    if (pendingUnlink) {
                        clearTimeout(pendingUnlink.timer);
                        pendingUnlinks.delete(hash);
                        updateFilePath(
                            hash,
                            relativePath,
                            basename(filePath),
                            stat.mtimeMs,
                        );
                        win.webContents.send("media:renamed", {
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
                        setFileStatus(hash, "active");
                        win.webContents.send("media:added", {
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
                        const timer = setTimeout(() => {
                            pendingAdds.delete(hash);
                            updateFilePath(
                                hash,
                                relativePath,
                                basename(filePath),
                                stat.mtimeMs,
                            );
                            if (existingRecord.status === "missing") {
                                setFileStatus(hash, "active");
                                win.webContents.send("media:added", {
                                    relativePath,
                                    hash,
                                    mediaType,
                                });
                            } else {
                                win.webContents.send("media:renamed", {
                                    oldRelativePath: existingRecord.path,
                                    relativePath,
                                    hash,
                                    mediaType,
                                });
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

                    upsertFile({
                        content_hash: hash,
                        path: relativePath,
                        filename: basename(filePath),
                        media_type: mediaType,
                        mtime: stat.mtimeMs,
                        size: stat.size,
                        status: "active",
                        missing_since: null,
                    });

                    win.webContents.send("media:added", {
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

        if (!record) {
            return;
        }

        if (record.status === "missing") return;

        // ── Case 1: add fired first (macOS) ─────────────────────────────────
        const pendingAdd = pendingAdds.get(record.content_hash);
        if (pendingAdd) {
            clearTimeout(pendingAdd.timer);
            pendingAdds.delete(record.content_hash);
            updateFilePath(
                record.content_hash,
                pendingAdd.relativePath,
                pendingAdd.filename,
                pendingAdd.mtime,
            );
            win.webContents.send("media:renamed", {
                oldRelativePath: relativePath,
                relativePath: pendingAdd.relativePath,
                hash: record.content_hash,
                mediaType: pendingAdd.mediaType,
            });
            return;
        }

        // ── Case 2: unlink fires first (Windows/Linux) ──────────────────────
        const timer = setTimeout(() => {
            pendingUnlinks.delete(record.content_hash);
            markFileMissing(relativePath);
            win.webContents.send("media:removed", { relativePath });
        }, RENAME_WINDOW_MS);

        pendingUnlinks.set(record.content_hash, { relativePath, timer });
    });

    // ── Folder removed ────────────────────────────────────────────────────────
    watcher.on("unlinkDir", (dirPath) => {
        const oldRelativeDir = relative(rootPath, dirPath);

        // Root folder itself was renamed/moved — signal the frontend to reset
        if (oldRelativeDir === "") {
            saveRootPath(null);
            win.webContents.send("library:invalid");
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
            pendingDirUnlinks.delete(oldRelativeDir);
            const affected = getFilesByPathPrefix(oldRelativeDir);
            for (const record of affected) {
                markFileMissing(record.path);
                win.webContents.send("media:removed", {
                    relativePath: record.path,
                });
            }
            win.webContents.send("folder:removed", {
                relativePath: oldRelativeDir,
            });
        }, RENAME_WINDOW_MS);

        pendingDirUnlinks.set(oldRelativeDir, { timer });
    });

    // ── Folder added ──────────────────────────────────────────────────────────
    watcher.on("addDir", (dirPath) => {
        const newRelativeDir = relative(rootPath, dirPath);

        // Ignore the root itself which fires on watcher init.
        if (newRelativeDir === "") return;

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
            pendingDirAdds.delete(dirName);
            win.webContents.send("folder:added", {
                relativePath: newRelativeDir,
            });
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
}
