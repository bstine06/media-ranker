import { createHash } from "crypto";
import {
    createReadStream,
    readdirSync,
    statSync,
    existsSync,
    mkdirSync,
} from "fs";
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
} from "./db";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp"]);
const GIF_EXTS = new Set([".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v"]);

export type MediaType = "photo" | "gif" | "video";

export interface ScannedFile {
    absolutePath: string;
    relativePath: string;
    filename: string;
    mediaType: MediaType;
}

export interface ScanResult {
    scanned: number;
    added: number;
    updated: number;
    skipped: number;
    unsupported: number;
}

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}

export interface FolderMetadata {
    description: string;
}

export function getMediaType(ext: string): MediaType | null {
    const e = ext.toLowerCase();
    if (PHOTO_EXTS.has(e)) return "photo";
    if (GIF_EXTS.has(e)) return "gif";
    if (VIDEO_EXTS.has(e)) return "video";
    return null;
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

export async function generateSizedImage(
    filePath: string,
    outPath: string,
    width: number,
    mediaType: MediaType,
): Promise<void> {
    if (existsSync(outPath)) return;
    const bin = ffmpegPath!; // path to bundled ffmpeg

    if (mediaType === "video") {
        await execFileAsync(bin, [
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
    } else {
        await execFileAsync(bin, [
            "-i",
            filePath,
            "-vf",
            `scale=${width}:-2`,
            "-vframes",
            "1",
            "-q:v",
            "3",
            "-y",
            outPath,
        ]);
    }
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
        if (entry.startsWith(".") || entry.startsWith("_")) continue;

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
            const ext = extname(entry);
            const mediaType = getMediaType(ext);
            if (!mediaType) continue;

            results.push({
                absolutePath: absPath,
                relativePath: relative(rootPath, absPath),
                filename: basename(entry),
                mediaType,
            });
        }
    }

    return results;
}

export async function scanFolder(rootPath: string): Promise<ScanResult> {
    const files = walkDir(rootPath, rootPath);
    const thumbDir = join(rootPath, "_thumbnails");
    ensureDir(thumbDir);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let unsupported = 0;
    let resurrected = 0;

    // hash -> relativePath for everything found on disk this scan
    const scannedHashes = new Map<string, string>();

    for (const file of files) {
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

                // Still need to resurrect if missing, even without rehashing
                if (existingByPath.status === "missing") {
                    setFileStatus(hash, "active");
                    resurrected++;
                } else {
                    skipped++;
                }
                continue; // ← don't fall through to the hash-based checks below
            } else {
                hash = await hashFile(file.absolutePath);
            }

            scannedHashes.set(hash, file.relativePath);

            const existingByHash = getFileByHashAny(hash);
            // ... rest of the checks unchanged

            if (!existingByHash) {
                // Genuinely new file — generate thumb and insert
                const thumbPath = join(thumbDir, `${hash}.jpg`);
                await generateSizedImage(
                    file.absolutePath,
                    thumbPath,
                    400,
                    file.mediaType,
                ).catch((e) => {
                    console.warn(`Thumbnail failed for ${file.filename}:`, e);
                });

                upsertFile({
                    content_hash: hash,
                    path: file.relativePath,
                    filename: file.filename,
                    media_type: file.mediaType,
                    mtime,
                    size,
                    status: "active",
                    missing_since: null,
                });
                added++;
            } else if (
                existingByHash.path !== file.relativePath ||
                existingByHash.status === "missing"
            ) {
                // Known file that moved, was renamed, or is being resurrected after a
                // parent folder rename — update path and mark active, tags survive
                updateFilePath(hash, file.relativePath, file.filename, mtime);
                setFileStatus(hash, "active");

                if (existingByHash.status === "missing") resurrected++;
                else updated++;
            } else if (
                existingByPath &&
                (existingByPath.mtime !== mtime || existingByPath.size !== size)
            ) {
                // Same path, but mtime/size changed — content update
                upsertFile({
                    content_hash: hash,
                    path: file.relativePath,
                    filename: file.filename,
                    media_type: file.mediaType,
                    mtime,
                    size,
                    status: "active",
                    missing_since: null,
                });
                updated++;
            }
            // else: active, same path, same hash — skipped++ already counted above
        } catch (err) {
            console.error(`Failed to process ${file.absolutePath}:`, err);
            unsupported++;
        }
    }

    // Anything not seen on disk this scan: mark missing, never hard-delete
    const allDbFiles = getAllFiles();
for (const dbFile of allDbFiles) {
    if (dbFile.status === "missing") {
        console.log("missing record:", dbFile.path, "in scannedHashes?", scannedHashes.has(dbFile.content_hash));
    }
    if (!scannedHashes.has(dbFile.content_hash) && dbFile.status === "active") {
        markFileMissing(dbFile.path);
    }
}

    console.log(
        `Scan complete: ${files.length} on disk, +${added} new, ~${updated} updated, ↑${resurrected} resurrected, ${skipped} skipped, ${unsupported} failed`,
    );
    return { scanned: files.length, added, updated, skipped, unsupported };
}

export function getSubfolders(rootPath: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(rootPath);
    } catch {
        return [];
    }

    return entries.filter((entry) => {
        if (entry.startsWith(".") || entry.startsWith("_")) return false;
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
            if (entry.startsWith(".") || entry.startsWith("_")) continue;
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
