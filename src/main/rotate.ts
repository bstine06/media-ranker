// Rotating a library file in place. Writes a rotated copy next to the
// thumbnails (same volume as the library, so the final rename is a plain
// move, and a folder the watcher ignores), then swaps it in over the
// original with replaceTrackedFile. The file keeps its record, score and
// tags. The old version is overwritten, not trashed, so rotating doesn't
// fill the Trash.

import { execFile } from "child_process";
import { promisify } from "util";
import { join, extname } from "path";
import { unlink } from "fs/promises";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { getDb, getFileByPath } from "./db";
import { ensureDir } from "./scanner";
import { replaceTrackedFile } from "./replaceFile";

const execFileAsync = promisify(execFile);

function ffmpegBin(): string {
    // Packaged builds run ffmpeg from app.asar.unpacked (see asarUnpack).
    return ffmpegPath!.replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
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
): Promise<void> {
    const turns = ((quarterTurns % 4) + 4) % 4;
    if (turns === 0) return;

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
            if (ext === ".jpg" || ext === ".jpeg") img = img.jpeg({ quality: 95 });
            else if (ext === ".png") img = img.png();
            else if (ext === ".webp") img = img.webp({ quality: 95 });
            else if (ext === ".gif") img = img.gif();
            await img.toFile(tmp);
        }

        await replaceTrackedFile(rootPath, relPath, tmp, ignoredPaths, "overwrite");

        // The old version's thumbnail, unless an identical file still uses it.
        const stillUsed = getDb()
            .prepare(`SELECT 1 FROM files WHERE content_hash = ? LIMIT 1`)
            .get(file.content_hash);
        if (!stillUsed) {
            await unlink(join(tmpDir, `${file.content_hash}.jpg`)).catch(() => {});
        }
    } finally {
        // Gone already if the swap happened; cleans up after a failure.
        await unlink(tmp).catch(() => {});
    }
}
