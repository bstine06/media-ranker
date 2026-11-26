// Rotation previews, shared by every view: a file turned anywhere (R in the
// file view, on a Compare card…) turns in every copy of it on screen at
// once, including one that's hidden for an inspection, so swapping between
// copies never shows it the old way round.
//
// Presses turn the preview straight away; the file is saved once pressing
// stops (or on leaving it), once, by whichever view asked. Its new version
// (same record, new content hash) then reaches every view as usual
// (media:updated), and the saver gets it through `onSaved`.
//
// Turns are kept per version (content hash): a copy still showing the old
// version keeps its full preview turn until it swaps; the new version
// already has the saved turns in it, so it only gets the presses made since.

import type { DbFile } from "@renderer/shared/types/types";
import { toMediaUrl } from "@renderer/lib/media";
import { preloadImage } from "@renderer/lib/imageCache";

type OnSaved = (file: DbFile, turns: number) => void;

/** Per file id: preview quarter turns per content hash. */
const previews = new Map<number, Map<string, number>>();
/** Per file id: what's waiting to be saved. */
const queued = new Map<number, { file: DbFile; turns: number; rootPath: string; onSaved: OnSaved }>();
const saving = new Set<number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let version = 0;

const notify = () => {
    version++;
    for (const l of listeners) l();
};

export function subscribeRotation(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export const rotationVersion = (): number => version;

/** The preview turns for this copy of a file (its version). */
export function previewTurns(file: DbFile): number {
    return previews.get(file.id)?.get(file.content_hash) ?? 0;
}

const addTurns = (id: number, hash: string, by: number) => {
    let byHash = previews.get(id);
    if (!byHash) previews.set(id, (byHash = new Map()));
    const next = (byHash.get(hash) ?? 0) + by;
    if (next === 0) byHash.delete(hash);
    else byHash.set(hash, next);
    if (byHash.size === 0) previews.delete(id);
};

/** Turn `file` a quarter left (preview now, saved once pressing stops). */
export function rotateLeft(file: DbFile, rootPath: string, onSaved: OnSaved): void {
    addTurns(file.id, file.content_hash, 1);
    const q = queued.get(file.id);
    queued.set(file.id, { file: q?.file ?? file, turns: (q?.turns ?? 0) + 1, rootPath, onSaved });
    notify();
    const t = timers.get(file.id);
    if (t) clearTimeout(t);
    timers.set(file.id, setTimeout(() => void saveRotation(file.id), 900));
}

/** Save now whatever is waiting for this file (leaving it, or the timer). */
export async function saveRotation(id: number): Promise<void> {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    const q = queued.get(id);
    if (!q || saving.has(id)) return;
    queued.delete(id);
    const { file, turns, rootPath, onSaved } = q;
    const oldHash = file.content_hash;
    if (turns % 4 === 0) {
        addTurns(id, oldHash, -turns); // full circle: nothing to save
        notify();
        return;
    }
    saving.add(id);
    try {
        const updated: DbFile = await window.api.rotateFile(file.path, turns);
        // Have the new image decoded before it replaces the preview, so the
        // swap is seamless.
        if (updated.media_type !== "video") {
            await Promise.race([
                preloadImage(toMediaUrl(rootPath, updated.path, updated.content_hash)),
                new Promise((r) => setTimeout(r, 1500)),
            ]);
        }
        // The new version has these turns in it; presses made since carry
        // over to it. Copies still on the old version keep their turn until
        // they swap (then the old entry goes).
        const since = (previews.get(id)?.get(oldHash) ?? 0) - turns;
        if (since !== 0) addTurns(id, updated.content_hash, since);
        onSaved(updated, turns);
        setTimeout(() => {
            previews.get(id)?.delete(oldHash);
            if (previews.get(id)?.size === 0) previews.delete(id);
            notify();
        }, 3000);
        notify();
        const again = queued.get(id);
        if (again) queued.set(id, { ...again, file: updated });
    } catch (err) {
        console.error("Rotate failed:", err);
        addTurns(id, oldHash, -turns);
        notify();
    } finally {
        saving.delete(id);
    }
    if (queued.has(id)) void saveRotation(id);
}
