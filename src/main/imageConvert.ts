// main/imageConvert.ts
// Turning any supported still image into a JPEG, for thumbnails and for the
// display copies of formats Chromium can't show (HEIC, TIFF).

import { execFile } from "child_process";
import { promisify } from "util";
import { extname } from "path";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

export function ffmpegBin(): string {
    // Packaged builds run ffmpeg from app.asar.unpacked (see asarUnpack).
    return ffmpegPath!.replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
}

// sharp's bundled libheif reads AVIF but not HEVC-coded HEIC (iPhone photos),
// so those go through macOS's built-in converter.
export function needsSips(ext: string): boolean {
    const e = ext.toLowerCase();
    return e === ".heic" || e === ".heif";
}

async function sipsToJpeg(src: string, out: string, width?: number): Promise<void> {
    if (process.platform !== "darwin") {
        throw new Error(`HEIC is only supported on macOS: ${src}`);
    }
    const args = ["-s", "format", "jpeg", "-s", "formatOptions", "90"];
    if (width) args.push("--resampleWidth", String(width));
    await execFileAsync("sips", [...args, src, "--out", out]);
}

async function ffmpegToJpeg(src: string, out: string, width?: number): Promise<void> {
    const args = ["-v", "error", "-i", src, "-vframes", "1", "-q:v", "3"];
    if (width) args.push("-vf", `scale=${width}:-2`);
    await execFileAsync(ffmpegBin(), [...args, "-y", out]);
}

/**
 * Writes the first frame of an image to `out` as an upright JPEG, `width`
 * pixels wide (full size if omitted).
 */
export async function imageToJpeg(src: string, out: string, width?: number): Promise<void> {
    if (needsSips(extname(src))) return sipsToJpeg(src, out, width);
    try {
        // rotate() with no angle applies the EXIF orientation, as browsers do.
        let img = sharp(src).rotate();
        if (width) img = img.resize({ width });
        await img.jpeg({ quality: 90 }).toFile(out);
    } catch {
        // sharp can't read BMP, among others; ffmpeg can.
        await ffmpegToJpeg(src, out, width);
    }
}
