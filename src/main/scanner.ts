import { createHash } from "crypto";
import {
    createReadStream,
    readdirSync,
    statSync,
    existsSync,
    mkdirSync,
} from "fs";
import { access, unlink } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
    upsertFile,
    getFileByPath,
    getAllFiles,
    deleteFileByPath,
    getFileByHash,
    setFileStatus,
    updateFilePath,
    markFileMissing,
    getFileByPathAny,
    getFileByHashAny,
    DbFolder,
    upsertFolder,
    updateFileFolderAndPath,
    normalizeFolderIds,
    dropDirectTagsCoveredByFolder,
} from "./db";
import { getMediaType, type MediaType } from "./formats";
import { ffmpegBin, imageToJpeg } from "./imageConvert";
import { INTERNAL_NAMES } from "./config";
import { BrowserWindow } from "electron";

const execFileAsync = promisify(execFile);

export { getMediaType } from "./formats";
export type { MediaType } from "./formats";

export interface ScannedFile {
    absolutePath: string;
    relativePath: string;
    filename: string;
    mediaType: MediaType;
    folderRelPath: string | null; // null = root-level file
}

export interface ScanResult {
    scanned: number;
    added: number;
    updated: number;
    skipped: number;
    unsupported: number;
    resurrected: number; // was computed but never surfaced
}

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}

export interface FolderMetadata {
    description: string;
}

export function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

export function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) mkdirSync(dirPath);
}

// Helper to ensure a thumbnail exists, generating it if not
async function ensureThumbnail(
    thumbDir: string,
    hash: string,
    absolutePath: string,
    filename: string,
    mediaType: MediaType,
): Promise<void> {
    const thumbPath = join(thumbDir, `${hash}.jpg`);
    try {
        await access(thumbPath); // already exists, nothing to do
    } catch {
        await generateSizedImage(absolutePath, thumbPath, 400, mediaType).catch(
            (e) => {
                console.warn(`Thumbnail failed for ${filename}:`, e);
            },
        );
    }
}

export async function generateSizedImage(
    filePath: string,
    outPath: string,
    width: number,
    mediaType: MediaType,
): Promise<void> {
    if (existsSync(outPath)) return;
    if (mediaType !== "video") return imageToJpeg(filePath, outPath, width);

    await execFileAsync(ffmpegBin(), [
        "-ss",
        "00:00:01",
        "-i",
        filePath,
        "-vframes",
        "1",
        "-vf",
        `scale=${width}:-2`,
        "-q:v",
        "3",
        "-y",
        outPath,
    ]);
}

function walkDir(dirPath: string, rootPath: string): ScannedFile[] {
    const results: ScannedFile[] = [];

    let entries: string[];
    try {
        entries = readdirSync(dirPath);
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (entry.startsWith(".") || INTERNAL_NAMES.has(entry)) continue;

        const absPath = join(dirPath, entry);
        let stat;
        try {
            stat = statSync(absPath);
        } catch {
            continue;
        }

        if (stat.isDirectory()) {
            results.push(...walkDir(absPath, rootPath));
        } else if (stat.isFile()) {
            const mediaType = getMediaType(extname(entry));
            if (!mediaType) continue;
            results.push({
                absolutePath: absPath,
                relativePath: relative(rootPath, absPath),
                filename: basename(entry),
                mediaType,
                folderRelPath: relative(rootPath, dirPath) || null,
            });
        }
    }

    return results;
}

export async function scanFolder(
    rootPath: string,
    win: BrowserWindow,
): Promise<ScanResult> {
    const files = walkDir(rootPath, rootPath);
    const thumbDir = join(rootPath, "_thumbnails");
    ensureDir(thumbDir);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let unsupported = 0;
    let resurrected = 0;

    const scannedHashes = new Map<string, string>();

    const getFolderId = (f: ScannedFile): number | null => {
        if (!f.folderRelPath) return null;
        // take only the first path segment
        const topLevel = f.folderRelPath.split("/")[0];
        return folderCache.get(topLevel)?.id ?? null;
    };

    const folderCache = new Map<string, DbFolder>();
    function walkFolders(dirPath: string) {
        const entries = readdirSync(rootPath);
        for (const entry of entries) {
            if (entry.startsWith(".") || INTERNAL_NAMES.has(entry)) continue;
            const absPath = join(rootPath, entry);
            try {
                if (statSync(absPath).isDirectory()) {
                    const folder = upsertFolder(entry, entry); // relative path is just the name
                    folderCache.set(entry, folder);
                }
            } catch {
                continue;
            }
        }
    }
    walkFolders(rootPath);

    let i = 0;
    for (const file of files) {
        if (!win.isDestroyed()) win.webContents.send("process:message-sent", {
            message: `${file.relativePath}`,
            progress: [++i, files.length],
        });
        try {
            const stat = statSync(file.absolutePath);
            const mtime = stat.mtimeMs;
            const size = stat.size;

            const existingByPath = getFileByPathAny(file.relativePath);

            let hash: string;
            if (
                existingByPath &&
                existingByPath.mtime === mtime &&
                existingByPath.size === size
            ) {
                hash = existingByPath.content_hash;
                scannedHashes.set(hash, file.relativePath);

                // Resurrected via path+mtime match (the early-continue branch)
                if (existingByPath.status === "missing") {
                    setFileStatus(hash, "active");
                    resurrected++;
                } else {
                    skipped++;
                }
                // Runs for both active-skipped and resurrected — cheap no-op if thumb exists
                await ensureThumbnail(
                    thumbDir,
                    hash,
                    file.absolutePath,
                    file.filename,
                    file.mediaType,
                );
                continue;
            } else {
                hash = await hashFile(file.absolutePath);
            }

            scannedHashes.set(hash, file.relativePath);

            const existingByHash = getFileByHashAny(hash);

            if (!existingByHash) {
                const thumbPath = join(thumbDir, `${hash}.jpg`);
                await generateSizedImage(
                    file.absolutePath,
                    thumbPath,
                    400,
                    file.mediaType,
                ).catch((e) => {
                    console.warn(`Thumbnail failed for ${file.filename}:`, e);
                });

                const inserted = upsertFile({
                    content_hash: hash,
                    path: file.relativePath,
                    filename: file.filename,
                    media_type: file.mediaType,
                    mtime,
                    size,
                    status: "active",
                    missing_since: null,
                    folder_id: getFolderId(file),
                });
                added++;
                //Resurrected/moved via hash match
            } else if (
                existingByHash.path !== file.relativePath ||
                existingByHash.status === "missing"
            ) {
                const newFolderId = getFolderId(file);
                updateFileFolderAndPath(
                    hash,
                    file.relativePath,
                    file.filename,
                    mtime,
                    newFolderId,
                );
                setFileStatus(hash, "active");
                await ensureThumbnail(
                    thumbDir,
                    hash,
                    file.absolutePath,
                    file.filename,
                    file.mediaType,
                );

                if (existingByHash.status === "missing") resurrected++;
                else updated++;
                // Content-changed file (same path, new hash, already upserted)
            } else if (
                existingByPath &&
                (existingByPath.mtime !== mtime || existingByPath.size !== size)
            ) {
                upsertFile({
                    content_hash: hash,
                    path: file.relativePath,
                    filename: file.filename,
                    media_type: file.mediaType,
                    mtime,
                    size,
                    status: "active",
                    missing_since: null,
                    folder_id: getFolderId(file),
                });
                await ensureThumbnail(
                    thumbDir,
                    hash,
                    file.absolutePath,
                    file.filename,
                    file.mediaType,
                );
                updated++;
            }
        } catch (err) {
            console.error(`Failed to process ${file.absolutePath}:`, err);
            unsupported++;
        }
    }

    // Files skipped above (unchanged on disk) keep whatever folder_id they
    // had; fix any that drifted (e.g. a subfolder moved between folders in
    // Finder), then apply the one-source rule for folder tags.
    normalizeFolderIds();
    dropDirectTagsCoveredByFolder();

    // Mark missing and delete thumbnails for anything not seen on disk
    const allDbFiles = getAllFiles();
    for (const dbFile of allDbFiles) {
        const isOnDisk = scannedHashes.has(dbFile.content_hash);

        if (!isOnDisk && dbFile.status === "active") {
            // Newly missing this scan
            markFileMissing(dbFile.path);
            unlink(join(thumbDir, `${dbFile.content_hash}.jpg`)).catch(
                (err) => {
                    if (err.code !== "ENOENT")
                        console.error(
                            "Failed to delete thumbnail:",
                            dbFile.content_hash,
                            err,
                        );
                },
            );
        } else if (!isOnDisk && dbFile.status === "missing") {
            // Already missing from a prior scan — thumbnail may still be lingering
            unlink(join(thumbDir, `${dbFile.content_hash}.jpg`)).catch(
                (err) => {
                    if (err.code !== "ENOENT")
                        console.error(
                            "Failed to delete stale thumbnail:",
                            dbFile.content_hash,
                            err,
                        );
                },
            );
        }
    }

    console.log(
        `Scan complete: ${files.length} on disk, +${added} new, ~${updated} updated, ` +
            `↑${resurrected} resurrected, ${skipped} skipped, ${unsupported} failed`,
    );
    return {
        scanned: files.length,
        added,
        updated,
        skipped,
        unsupported,
        resurrected,
    };
}

export function getSubfolders(rootPath: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(rootPath);
    } catch {
        return [];
    }

    return entries.filter((entry) => {
        if (entry.startsWith(".") || INTERNAL_NAMES.has(entry)) return false;
        try {
            return statSync(join(rootPath, entry)).isDirectory();
        } catch {
            return false;
        }
    });
}

export function getFolderTree(rootPath: string): FolderNode[] {
    function walk(dirPath: string): FolderNode[] {
        let entries: string[];
        try {
            entries = readdirSync(dirPath);
        } catch {
            return [];
        }

        const nodes: FolderNode[] = [];
        for (const entry of entries) {
            if (entry.startsWith(".") || INTERNAL_NAMES.has(entry)) continue;
            const absPath = join(dirPath, entry);
            try {
                if (statSync(absPath).isDirectory()) {
                    nodes.push({
                        name: entry,
                        relativePath: relative(rootPath, absPath),
                        children: walk(absPath),
                    });
                }
            } catch {
                continue;
            }
        }
        return nodes;
    }

    return walk(rootPath);
}

export function getThumbnailPath(rootPath: string, hash: string): string {
    return join(rootPath, "_thumbnails", `${hash}.jpg`);
}
