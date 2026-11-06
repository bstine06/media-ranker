// main/displayCopy.ts
// Full-size JPEG copies of images Chromium can't decode (HEIC, TIFF), which
// the media:// handler serves in their place. Kept in the OS temp folder,
// keyed by path, size and mtime so an edited file gets a fresh copy.

import { app } from "electron";
import { createHash } from "crypto";
import { existsSync, mkdirSync, statSync } from "fs";
import { rename, unlink } from "fs/promises";
import { join } from "path";
import { imageToJpeg } from "./imageConvert";

const inFlight = new Map<string, Promise<string>>();

function cacheDir(): string {
    const dir = join(app.getPath("temp"), "media-ranker-display");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

export function getDisplayCopy(filePath: string): Promise<string> {
    const { size, mtimeMs } = statSync(filePath);
    const key = createHash("sha1").update(`${filePath}|${size}|${mtimeMs}`).digest("hex");
    const out = join(cacheDir(), `${key}.jpg`);
    if (existsSync(out)) return Promise.resolve(out);

    let pending = inFlight.get(key);
    if (!pending) {
        // Written under a temp name so a half-written copy is never served.
        const tmp = `${out}.${process.pid}.tmp.jpg`;
        pending = imageToJpeg(filePath, tmp)
            .then(() => rename(tmp, out))
            .then(() => out)
            .catch(async (err) => {
                await unlink(tmp).catch(() => {});
                throw err;
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
    }
    return pending;
}
