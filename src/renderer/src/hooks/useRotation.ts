import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { DbFile } from "@renderer/shared/types/types";
import {
    previewTurns,
    rotateLeft as rotateInStore,
    rotationVersion,
    saveRotation,
    subscribeRotation,
} from "@renderer/lib/rotationStore";

/**
 * Rotate-left for whatever file is on screen (single file view, Browse
 * scroll, a Compare card).
 *
 * The preview is shared by every view (lib/rotationStore): a file turned
 * here turns in every copy of it on screen at once. Presses turn the preview
 * at once; the file is saved once pressing stops (or on leaving it), so
 * several presses make one save and one Trash item. `onSaved` gets the new
 * version (same record, new content hash) and how many quarter turns it was
 * turned, so the caller can swap it in; MediaPlayer then hands a playing
 * video over at the same moment instead of restarting it.
 */
export function useRotation(
    currentFile: DbFile | null,
    rootPath: string,
    onSaved: (file: DbFile, turns: number) => void,
): { turns: (file: DbFile) => number; rotateLeft: () => void } {
    // Re-render when any preview changes.
    const version = useSyncExternalStore(subscribeRotation, rotationVersion);
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    const rotateLeft = useCallback(() => {
        if (!currentFile) return;
        rotateInStore(currentFile, rootPath, (f, t) => onSavedRef.current(f, t));
    }, [currentFile, rootPath]);

    // Leaving the file (or the view) saves right away.
    useEffect(() => {
        const id = currentFile?.id;
        return () => {
            if (id != null) void saveRotation(id);
        };
    }, [currentFile?.id]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const turns = useCallback((file: DbFile) => previewTurns(file), [version]);

    return { turns, rotateLeft };
}
