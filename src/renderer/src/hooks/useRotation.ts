import { useCallback, useEffect, useRef, useState } from "react";
import type { DbFile } from "@renderer/shared/types/types";
import { toMediaUrl } from "@renderer/lib/media";
import { preloadImage } from "@renderer/lib/imageCache";

/**
 * Rotate-left for whatever file is on screen (single file view, Discover,
 * a Compare card).
 *
 * Clicks turn the preview at once; the file is saved once clicking stops
 * (or on leaving it), so several clicks make one save and one Trash item.
 * `onSaved` gets the new version (same record, new content hash) and how
 * many quarter turns it was turned, so the caller can swap it in; MediaPlayer then hands a playing video over at
 * the same moment instead of restarting it.
 */
export function useRotation(
    currentFile: DbFile | null,
    rootPath: string,
    onSaved: (file: DbFile, turns: number) => void,
): { turns: (fileId: number) => number; rotateLeft: () => void } {
    const [preview, setPreview] = useState<{ id: number; turns: number }>({
        id: -1,
        turns: 0,
    });
    const queuedRef = useRef<{ file: DbFile; turns: number } | null>(null);
    const savingRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    const saveRotation = useCallback(async (): Promise<void> => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const queued = queuedRef.current;
        if (!queued || savingRef.current) return;
        queuedRef.current = null;
        const { file, turns } = queued;
        const dropPreview = () =>
            setPreview((p) =>
                p.id === file.id ? { ...p, turns: p.turns - turns } : p,
            );
        if (turns % 4 === 0) {
            dropPreview(); // full circle: nothing to save
            return;
        }
        savingRef.current = true;
        try {
            const updated = await window.api.rotateFile(file.path, turns);
            // Have the new image decoded before it replaces the preview, so
            // the swap is seamless.
            if (updated.media_type !== "video") {
                await Promise.race([
                    preloadImage(
                        toMediaUrl(rootPath, updated.path, updated.content_hash),
                    ),
                    new Promise((r) => setTimeout(r, 1500)),
                ]);
            }
            onSavedRef.current(updated, turns);
            dropPreview();
            // Clicked again while saving: carry those on to the new version.
            // (A plain read: TS narrowed the ref to null above, but clicks
            // during the await can have set it again.)
            const again = queuedRef.current as typeof queued | null;
            if (again?.file.id === file.id) {
                queuedRef.current = { ...again, file: updated };
            }
        } catch (err) {
            console.error("Rotate failed:", err);
            dropPreview();
        } finally {
            savingRef.current = false;
        }
        if (queuedRef.current) saveRotation();
    }, [rootPath]);

    const rotateLeft = useCallback(() => {
        if (!currentFile) return;
        const queued = queuedRef.current;
        queuedRef.current = {
            file: queued?.file.id === currentFile.id ? queued.file : currentFile,
            turns: (queued?.file.id === currentFile.id ? queued.turns : 0) + 1,
        };
        setPreview((p) => ({
            id: currentFile.id,
            turns: (p.id === currentFile.id ? p.turns : 0) + 1,
        }));
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(saveRotation, 900);
    }, [currentFile, saveRotation]);

    // Leaving the file (or the view) saves right away.
    const saveRotationRef = useRef(saveRotation);
    saveRotationRef.current = saveRotation;
    useEffect(() => {
        return () => {
            saveRotationRef.current();
        };
    }, [currentFile?.id]);

    const turns = useCallback(
        (fileId: number) => (preview.id === fileId ? preview.turns : 0),
        [preview],
    );

    return { turns, rotateLeft };
}
