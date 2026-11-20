// Rotating a library file in place. Writes a rotated copy next to the
// thumbnails (same volume as the library, so the final rename is a plain
// move, and a folder the watcher ignores), then swaps it in over the
// original with replaceTrackedFile. The file keeps its record, score and
// tags. The old version goes to the undo holding folder (returned), so the
// rotation can be undone exactly (re-rotating an image re-encodes it).

import { execFile } from "child_process";
import { promisify } from "util";
import { join, extname, basename } from "path";
import { link, readdir, stat, unlink } from "fs/promises";
import sharp from "sharp";
import { getFileByPath } from "./db";
import { holdingPath } from "./undo";
import { ensureDir } from "./scanner";
import { replaceTrackedFile } from "./replaceFile";
import { ffmpegBin, needsSips } from "./imageConvert";

const execFileAsync = promisify(execFile);

// ── Previous version ────────────────────────────────────────────────────────
// A rotated video is overwritten at the same path, but a player may still be
// streaming the old version (it keeps playing until the new one is ready).
// Its URL carries the old content hash (?v=…), so for a minute the old bytes
// stay reachable under that hash: a hard link (no copy, same volume) in the
// thumbnails folder, which the media:// handler serves for that hash.

const PREVIOUS_VERSION_TTL_MS = 60_000;

export function previousVersionPath(rootPath: string, hash: string, ext: string): string {
    return join(rootPath, "_thumbnails", `.prev-${hash}${ext.toLowerCase()}`);
}

async function keepPreviousVersion(rootPath: string, src: string, hash: string): Promise<void> {
    const dir = join(rootPath, "_thumbnails");
    // Leftovers from earlier rotations (e.g. the app quit before cleanup).
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
        names
            .filter((n) => n.startsWith(".prev-"))
            .map(async (n) => {
                const p = join(dir, n);
                const s = await stat(p).catch(() => null);
                if (s && Date.now() - s.mtimeMs > PREVIOUS_VERSION_TTL_MS) {
                    await unlink(p).catch(() => {});
                }
            }),
    );
    const keep = previousVersionPath(rootPath, hash, extname(src));
    // Without a hard link (some file systems) the old player just loses
    // its source early, as before.
    if (!(await link(src, keep).then(() => true, () => false))) return;
    setTimeout(() => unlink(keep).catch(() => {}), PREVIOUS_VERSION_TTL_MS);
}

// The rotation already set on a video, counter-clockwise degrees ("displaymatrix:
// rotation of -90.00 degrees" in ffmpeg's stream info). 0 when there is none.
async function currentVideoRotation(filePath: string): Promise<number> {
    // `ffmpeg -i` with no output exits non-zero but prints the info we need.
    const stderr = await execFileAsync(ffmpegBin(), ["-hide_banner", "-i", filePath])
        .then((r) => r.stderr)
        .catch((e: { stderr?: string }) => e.stderr ?? "");
    const m = /rotation of (-?[\d.]+) degrees/.exec(stderr);
    return m ? parseFloat(m[1]) : 0;
}

/**
 * Rotates the file `quarterTurns` × 90° to the left (counter-clockwise).
 * Videos: lossless, by setting the rotation flag players honor (no
 * re-encode). Images: the pixels are rotated and re-saved; animated GIFs stay
 * animated.
 */
export async function rotateTrackedFile(
    rootPath: string,
    relPath: string,
    quarterTurns: number,
    ignoredPaths: Set<string>,
    runDb: (fn: () => void) => void = (fn) => fn(),
): Promise<string | null> {
    const turns = ((quarterTurns % 4) + 4) % 4;
    if (turns === 0) return null;

    const file = getFileByPath(relPath);
    if (!file) throw new Error(`File not tracked: ${relPath}`);

    const src = join(rootPath, relPath);
    const ext = extname(relPath).toLowerCase();
    const tmpDir = join(rootPath, "_thumbnails");
    ensureDir(tmpDir);
    const tmp = join(tmpDir, `.rotating-${file.id}-${Date.now()}${ext}`);

    try {
        if (file.media_type === "video") {
            const rotation = (await currentVideoRotation(src)) + 90 * turns;
            await execFileAsync(ffmpegBin(), [
                "-v", "error",
                // Replaces (doesn't add to) any existing rotation, hence the sum.
                "-display_rotation:v:0", String(rotation),
                "-i", src,
                "-map", "0",
                "-c", "copy",
                "-y", tmp,
            ]);
        } else if (ext === ".svg") {
            throw new Error("SVG files can't be rotated");
        } else if (needsSips(ext) || ext === ".bmp") {
            // sharp can't write these (or read HEIC); macOS's sips can.
            // sips also turns clockwise.
            if (process.platform !== "darwin") {
                throw new Error(`Rotating ${ext} files is only supported on macOS`);
            }
            await execFileAsync("sips", ["-r", String(360 - 90 * turns), src, "--out", tmp]);
        } else {
            // sharp turns clockwise; left by `turns` = clockwise by 360 - 90·turns.
            const clockwise = 360 - 90 * turns;
            const animated = ext === ".gif" || ext === ".webp";
            const meta = await sharp(src).metadata();
            // An EXIF orientation must be applied first, or it would be
            // applied again on top of our rotation when the file is shown.
            const upright =
                meta.orientation && meta.orientation !== 1
                    ? await sharp(src, { animated }).rotate().toBuffer()
                    : src;
            let img = sharp(upright, { animated }).rotate(clockwise);
            if (upright === src) img = img.withMetadata();
            if ([".jpg", ".jpeg", ".jpe", ".jfif"].includes(ext)) img = img.jpeg({ quality: 95 });
            else if (ext === ".png" || ext === ".apng") img = img.png();
            else if (ext === ".webp") img = img.webp({ quality: 95 });
            else if (ext === ".gif") img = img.gif();
            else if (ext === ".avif") img = img.avif({ quality: 80 });
            else if (ext === ".tif" || ext === ".tiff") img = img.tiff();
            await img.toFile(tmp);
        }

        if (file.media_type === "video") {
            await keepPreviousVersion(rootPath, src, file.content_hash);
        }
        // The old version's thumbnail stays: undo brings that version back.
        // The original is another version of a file that stays: it's
        // deleted at quit, not sent to the Trash.
        const held = await holdingPath(basename(relPath), { discard: true });
        await replaceTrackedFile(rootPath, relPath, tmp, ignoredPaths, { hold: held }, runDb);
        return held;
    } finally {
        // Gone already if the swap happened; cleans up after a failure.
        await unlink(tmp).catch(() => {});
    }
}
