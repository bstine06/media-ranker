// A video baked in place is overwritten at the same path, but a player may
// still be streaming the old version (it keeps playing until the new one is
// ready). Its URL carries the old content hash (?v=…), so for a minute the
// old bytes stay reachable under that hash: a hard link (no copy, same
// volume) in the thumbnails folder, which the media:// handler serves for
// that hash.

import { join, extname } from "path";
import { link, readdir, stat, unlink } from "fs/promises";

const PREVIOUS_VERSION_TTL_MS = 60_000;

export function previousVersionPath(rootPath: string, hash: string, ext: string): string {
    return join(rootPath, "_thumbnails", `.prev-${hash}${ext.toLowerCase()}`);
}

export async function keepPreviousVersion(rootPath: string, src: string, hash: string): Promise<void> {
    const dir = join(rootPath, "_thumbnails");
    // Leftovers from earlier swaps (e.g. the app quit before cleanup).
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
    // its source early.
    if (!(await link(src, keep).then(() => true, () => false))) return;
    setTimeout(() => unlink(keep).catch(() => {}), PREVIOUS_VERSION_TTL_MS);
}
