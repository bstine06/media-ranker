// Baking a file's edits into the file itself. Edits (for now: the rotation
// setting, quarter turns counter-clockwise) live in the library and are only
// drawn by the app; Bake writes them into the file, so other programs see
// them too, then resets them (the file now carries them).
//
// Lossless wherever the format allows it:
//   - JPEG: the EXIF orientation tag is set (composed with any already
//     there); the picture data is copied as it is.
//   - MP4 / MOV / M4V / QT / 3GP: the display-rotation flag (stream copy).
//   - PNG, BMP, TIFF: the pixels are turned and saved losslessly.
// Otherwise the file is re-saved, losing a little quality (the renderer
// warns first): a JPEG with EXIF data but no orientation tag, WebP, AVIF,
// HEIC, GIF (re-coloured per frame), WebM / OGV (re-encoded).
// Not possible: SVG, animated WebP, animated PNG.
//
// The original goes to the undo holding folder (one undo puts it and the
// edits back); it reaches the Trash when its entry leaves the history.

import { execFile } from "child_process";
import { promisify } from "util";
import { open, readFile, writeFile, unlink } from "fs/promises";
import { basename, extname, join } from "path";
import sharp from "sharp";
import type { DbFile } from "./db";
import { holdingPath } from "./undo";
import { ensureDir } from "./scanner";
import { replaceTrackedFile } from "./replaceFile";
import { ffmpegBin, needsSips } from "./imageConvert";

const execFileAsync = promisify(execFile);

const JPEG = [".jpg", ".jpeg", ".jpe", ".jfif"];
const FLAG_VIDEO = [".mp4", ".m4v", ".mov", ".qt", ".3gp"];

export type BakePlan =
    | { ok: true; lossy: false }
    | { ok: true; lossy: true }
    | { ok: false; reason: string };

// ── JPEG orientation ────────────────────────────────────────────────────────

/** Where a JPEG's EXIF orientation value sits, or why it can't be set in place. */
type JpegExif =
    | { kind: "tag"; offset: number; littleEndian: boolean; value: number }
    | { kind: "no-exif"; insertAt: number }
    | { kind: "no-tag" }
    | { kind: "bad" };

function findJpegOrientation(buf: Buffer): JpegExif {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { kind: "bad" };
    let p = 2;
    let afterApp0 = 2;
    while (p + 4 <= buf.length && buf[p] === 0xff) {
        const marker = buf[p + 1];
        // Start of scan / end of image: no more header segments.
        if (marker === 0xda || marker === 0xd9) break;
        const len = buf.readUInt16BE(p + 2);
        const body = p + 4;
        if (marker === 0xe0) afterApp0 = p + 2 + len;
        if (marker === 0xe1 && buf.toString("latin1", body, body + 6) === "Exif\0\0") {
            const tiff = body + 6;
            const order = buf.toString("latin1", tiff, tiff + 2);
            if (order !== "II" && order !== "MM") return { kind: "bad" };
            const le = order === "II";
            const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
            const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
            const ifd0 = tiff + u32(tiff + 4);
            if (ifd0 + 2 > buf.length) return { kind: "bad" };
            const count = u16(ifd0);
            for (let i = 0; i < count; i++) {
                const e = ifd0 + 2 + i * 12;
                if (e + 12 > buf.length) return { kind: "bad" };
                if (u16(e) === 0x0112) {
                    // SHORT, one value, held in the entry itself.
                    if (u16(e + 2) !== 3) return { kind: "no-tag" };
                    return { kind: "tag", offset: e + 8, littleEndian: le, value: u16(e + 8) };
                }
            }
            return { kind: "no-tag" };
        }
        p += 2 + len;
    }
    return { kind: "no-exif", insertAt: afterApp0 };
}

// EXIF orientation as (mirrored, clockwise quarter turns): the stored image
// is mirrored left-right first, then turned clockwise, to be shown.
const ORIENT: Record<number, [boolean, number]> = {
    1: [false, 0], 6: [false, 1], 3: [false, 2], 8: [false, 3],
    2: [true, 0], 7: [true, 1], 4: [true, 2], 5: [true, 3],
};
function orientationValue(mirrored: boolean, cw: number): number {
    for (const [v, [m, k]] of Object.entries(ORIENT)) if (m === mirrored && k === cw) return Number(v);
    return 1;
}
/** The orientation after turning what's shown `ccw` quarter turns left. */
function composeOrientation(current: number, ccw: number): number {
    const [m, k] = ORIENT[current] ?? ORIENT[1];
    return orientationValue(m, (k + 4 - (ccw % 4)) % 4);
}

/** A minimal EXIF segment holding only an orientation. */
function exifSegment(orientation: number): Buffer {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write("MM", 0, "latin1");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8); // one entry
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12); // SHORT
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    tiff.writeUInt32BE(0, 22); // no next IFD
    const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xffe1, 0);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
}

async function readHead(path: string, bytes = 256 * 1024): Promise<Buffer> {
    const fh = await open(path, "r");
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** How baking this file would go. */
export async function bakePlan(file: DbFile, absPath: string): Promise<BakePlan> {
    const ext = extname(file.path).toLowerCase();
    if (file.media_type === "video") {
        return FLAG_VIDEO.includes(ext) ? { ok: true, lossy: false } : { ok: true, lossy: true };
    }
    if (ext === ".svg") return { ok: false, reason: "SVG files can't be baked." };
    if (JPEG.includes(ext)) {
        const exif = findJpegOrientation(await readHead(absPath));
        if (exif.kind === "tag" || exif.kind === "no-exif") return { ok: true, lossy: false };
        return { ok: true, lossy: true };
    }
    if (ext === ".png" || ext === ".apng" || ext === ".webp") {
        const meta = await sharp(absPath).metadata();
        if ((meta.pages ?? 1) > 1) {
            return { ok: false, reason: `Animated ${ext === ".webp" ? "WebP" : "PNG"} files can't be baked.` };
        }
        return ext === ".webp" ? { ok: true, lossy: true } : { ok: true, lossy: false };
    }
    if (ext === ".bmp" || ext === ".tif" || ext === ".tiff") return { ok: true, lossy: false };
    // HEIC, AVIF, GIF.
    return { ok: true, lossy: true };
}

// ── Writing ─────────────────────────────────────────────────────────────────

// The rotation already set on a video, counter-clockwise degrees. 0 if none.
async function currentVideoRotation(filePath: string): Promise<number> {
    const stderr = await execFileAsync(ffmpegBin(), ["-hide_banner", "-i", filePath])
        .then((r) => r.stderr)
        .catch((e: { stderr?: string }) => e.stderr ?? "");
    const m = /rotation of (-?[\d.]+) degrees/.exec(stderr);
    return m ? parseFloat(m[1]) : 0;
}

/** ffmpeg filter turning `ccw` quarter turns left. */
function turnFilter(ccw: number): string {
    return ccw === 1 ? "transpose=2" : ccw === 2 ? "hflip,vflip" : "transpose=1";
}

/** Writes `src` turned `ccw` quarter turns left to `out`. */
export async function writeTurned(src: string, out: string, ccw: number, ext: string, mediaType: DbFile["media_type"]): Promise<void> {
    if (mediaType === "video") {
        if (FLAG_VIDEO.includes(ext)) {
            const rotation = (await currentVideoRotation(src)) + 90 * ccw;
            await execFileAsync(ffmpegBin(), [
                "-v", "error",
                // Replaces (doesn't add to) any existing rotation, hence the sum.
                "-display_rotation:v:0", String(rotation),
                "-i", src, "-map", "0", "-c", "copy", "-y", out,
            ]);
            return;
        }
        // WebM / OGV: re-encoded, sound copied.
        const codec = ext === ".webm"
            ? ["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-row-mt", "1"]
            : ["-c:v", "libtheora", "-q:v", "9"];
        await execFileAsync(ffmpegBin(), [
            "-v", "error", "-i", src, "-map", "0", "-vf", turnFilter(ccw), ...codec, "-c:a", "copy", "-y", out,
        ], { maxBuffer: 16 * 1024 * 1024 });
        return;
    }
    if (JPEG.includes(ext)) {
        const buf = await readFile(src);
        const exif = findJpegOrientation(buf);
        if (exif.kind === "tag") {
            const next = composeOrientation(exif.value, ccw);
            if (exif.littleEndian) buf.writeUInt16LE(next, exif.offset);
            else buf.writeUInt16BE(next, exif.offset);
            await writeFile(out, buf);
            return;
        }
        if (exif.kind === "no-exif") {
            const seg = exifSegment(composeOrientation(1, ccw));
            await writeFile(out, Buffer.concat([buf.subarray(0, exif.insertAt), seg, buf.subarray(exif.insertAt)]));
            return;
        }
        // EXIF without an orientation tag: re-saved (lossy, warned first).
    }
    if (ext === ".gif") {
        // Every frame turned; each frame gets its own exact palette, no dithering.
        await execFileAsync(ffmpegBin(), [
            "-v", "error", "-i", src,
            "-filter_complex",
            `[0:v]${turnFilter(ccw)},split[a][b];[a]palettegen=stats_mode=single:reserve_transparent=1[p];[b][p]paletteuse=new=1:dither=none`,
            // Each frame keeps its own timing.
            "-fps_mode", "passthrough", "-loop", "0", "-y", out,
        ]);
        return;
    }
    if (needsSips(ext) || ext === ".bmp") {
        if (process.platform !== "darwin") throw new Error(`Baking ${ext} files needs macOS.`);
        // sips turns clockwise.
        await execFileAsync("sips", ["-r", String(360 - 90 * ccw), src, "--out", out]);
        return;
    }
    // sharp turns clockwise. An EXIF orientation is applied first, so it isn't
    // applied again on top of the turn when the file is shown.
    const meta = await sharp(src).metadata();
    const upright = meta.orientation && meta.orientation !== 1 ? await sharp(src).rotate().toBuffer() : src;
    let img = sharp(upright).rotate(360 - 90 * ccw);
    if (upright === src) img = img.withMetadata();
    if (JPEG.includes(ext)) img = img.jpeg({ quality: 95 });
    else if (ext === ".png" || ext === ".apng") img = img.png();
    else if (ext === ".webp") img = img.webp({ quality: 95 });
    else if (ext === ".avif") img = img.avif({ quality: 80 });
    else if (ext === ".tif" || ext === ".tiff") img = img.tiff({ compression: "lzw" });
    await img.toFile(out);
}

/**
 * Bakes `file`'s edits into it: writes the turned file, puts it in place
 * (the original to the holding folder, returned), and resets the edits in
 * the same database update (`runDb`, recorded by the undo history).
 */
export async function bakeFile(
    rootPath: string,
    file: DbFile,
    ignoredPaths: Set<string>,
    runDb: (fn: () => void) => void,
): Promise<string> {
    const src = join(rootPath, file.path);
    const ext = extname(file.path).toLowerCase();
    const plan = await bakePlan(file, src);
    if (!plan.ok) throw new Error(plan.reason);
    const tmpDir = join(rootPath, "_thumbnails");
    ensureDir(tmpDir);
    const tmp = join(tmpDir, `.baking-${file.id}-${Date.now()}${ext}`);
    try {
        await writeTurned(src, tmp, file.rotation % 4, ext, file.media_type);
        const held = await holdingPath(basename(file.path));
        // replaceTrackedFile resets the rotation with the new content.
        await replaceTrackedFile(rootPath, file.path, tmp, ignoredPaths, { hold: held }, runDb);
        return held;
    } finally {
        await unlink(tmp).catch(() => {});
    }
}
