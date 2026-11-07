import { DbTag } from "@renderer/shared/types/types";
import { useCallback, useEffect, useState } from "react";

// A file's tags (own and inherited), shared by everything showing them at
// once (the tag panel and the quick tag bar), so a change made in one shows
// in the other straight away.

type Listener = (fileId: number, tags: DbTag[]) => void;
const listeners = new Set<Listener>();

/** Tell every view showing this file's tags about its new list. */
export function publishFileTags(fileId: number, tags: DbTag[]): void {
    listeners.forEach((l) => l(fileId, tags));
}

export function useFileTags(fileId: number | null): {
    tags: DbTag[];
    /** Replace the list (after an add/remove call returned the new one). */
    setTags: (tags: DbTag[]) => void;
    addTag: (name: string) => Promise<DbTag[]>;
    removeTag: (name: string) => Promise<DbTag[]>;
} {
    const [tags, setLocal] = useState<DbTag[]>([]);

    useEffect(() => {
        setLocal([]);
        if (fileId == null) return;
        let live = true;
        // A change published while loading is newer than the load.
        let changed = false;
        const listener: Listener = (id, next) => {
            if (id !== fileId) return;
            changed = true;
            setLocal(next);
        };
        listeners.add(listener);
        window.api.getTags(fileId).then((loaded) => {
            if (live && !changed) setLocal(loaded);
        });
        return () => {
            live = false;
            listeners.delete(listener);
        };
    }, [fileId]);

    const setTags = useCallback(
        (next: DbTag[]) => {
            if (fileId != null) publishFileTags(fileId, next);
        },
        [fileId],
    );

    const addTag = useCallback(
        async (name: string) => {
            if (fileId == null) return [];
            const next = await window.api.addTag(fileId, name);
            publishFileTags(fileId, next);
            return next;
        },
        [fileId],
    );

    const removeTag = useCallback(
        async (name: string) => {
            if (fileId == null) return [];
            const next = await window.api.removeTag(fileId, name);
            publishFileTags(fileId, next);
            return next;
        },
        [fileId],
    );

    return { tags, setTags, addTag, removeTag };
}
