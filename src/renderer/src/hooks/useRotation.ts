import { useCallback } from "react";
import type { DbFile } from "@renderer/shared/types/types";

/**
 * Rotate-left for whatever file is on screen (the file view, a Compare
 * card). Rotation is a setting on the file (`file.rotation`, quarter turns):
 * one press adds a turn in the library at once (one undo entry), and the
 * fresh record reaches every view (media:updated), which draws it turned.
 * The file itself is untouched.
 */
export function useRotation(currentFile: DbFile | null): { rotateLeft: () => void } {
    const id = currentFile?.id;
    const rotateLeft = useCallback(() => {
        if (id == null) return;
        window.api.turnFile(id).catch((err: unknown) => console.error("Rotate failed:", err));
    }, [id]);
    return { rotateLeft };
}
