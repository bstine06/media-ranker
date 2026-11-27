import { isTyping, claimSpaceAndTab } from "@renderer/lib/keys";
import { useCallback, useEffect, useRef, useState } from "react";
import { DbFile } from "@renderer/shared/types/types";

export type SlotResolver = (dir: "up" | "down", cursor: number) => Promise<DbFile | null>;

export interface ScrollSlotsState {
    slotFiles: [DbFile | null, DbFile | null];
    slotTransforms: [string, string];
    slotTransitions: [string, string];
    frontSlot: 0 | 1;
    videoRef0: React.RefObject<HTMLVideoElement>;
    videoRef1: React.RefObject<HTMLVideoElement>;
    currentFile: DbFile | null;
    cursor: number;
    setCursor: (i: number) => void;
    navigate: (dir: "up" | "down", file?: DbFile) => void;
    /** Swap in a fresh record for a file already showing (e.g. after a turn). */
    replaceFile: (file: DbFile) => void;
}

/** A step's slide: the same glide as a pass's lane. */
const GLIDE_MS = 280;
const GLIDE_EASE = "cubic-bezier(0.25, 0.8, 0.3, 1)";

export function useScrollSlots({
    initialFile,
    resolver,
    active,
}: {
    initialFile: DbFile | null;
    resolver: SlotResolver;
    active: boolean;
}): ScrollSlotsState {
    const lockedRef = useRef(false);
    const [cursor, setCursor] = useState(0);
    const [frontSlot, setFrontSlot] = useState<0 | 1>(0);
    const [slotFiles, setSlotFiles] = useState<[DbFile | null, DbFile | null]>(
        [initialFile, null]
    );
    const [slotTransforms, setSlotTransforms] = useState<[string, string]>(
        ["translateX(0)", "translateX(100%)"]
    );
    const [slotTransitions, setSlotTransitions] = useState<[string, string]>(
        ["none", "none"]
    );

    const videoRef0 = useRef<HTMLVideoElement>(null);
    const videoRef1 = useRef<HTMLVideoElement>(null);
    const videoRefs = [videoRef0, videoRef1];

    // A step slides left or right, one file on screen at a time ("down":
    // the next, coming in from the right; "up": the previous, from the
    // left). `file`: slide that file in instead of asking
    // the resolver for the next one. Asked for mid-slide, it waits for the
    // slide to end (the file on screen was removed: it mustn't be dropped);
    // a plain step mid-slide is ignored as before.
    const pendingRef = useRef<{ dir: "up" | "down"; file: DbFile } | null>(null);
    const navigateRef = useRef<(dir: "up" | "down", file?: DbFile) => void>(() => {});
    const navigate = useCallback(async (dir: "up" | "down", file?: DbFile) => {
        if (lockedRef.current) {
            if (file) pendingRef.current = { dir, file };
            return;
        }

        lockedRef.current = true;
        videoRefs[frontSlot].current?.pause();

        const incoming = file ?? (await resolver(dir, cursor));
        if (!incoming) {
            lockedRef.current = false;
            return;
        }

        const backSlot = frontSlot === 0 ? 1 : 0;
        const offScreenY = dir === "down" ? "translateX(100%)" : "translateX(-100%)";
        const exitY = dir === "down" ? "translateX(-100%)" : "translateX(100%)";

        setSlotFiles((prev) => {
            const next = [...prev] as [DbFile | null, DbFile | null];
            next[backSlot] = incoming;
            return next;
        });
        setSlotTransitions(["none", "none"]);
        setSlotTransforms((prev) => {
            const next = [...prev] as [string, string];
            next[backSlot] = offScreenY;
            return next;
        });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setSlotTransitions([`transform ${GLIDE_MS}ms ${GLIDE_EASE}`, `transform ${GLIDE_MS}ms ${GLIDE_EASE}`]);
                setSlotTransforms((prev) => {
                    const next = [...prev] as [string, string];
                    next[frontSlot] = exitY;
                    next[backSlot] = "translateX(0)";
                    return next;
                });
                setTimeout(() => {
                    setFrontSlot(backSlot as 0 | 1);
                    setSlotTransitions(["none", "none"]);
                    videoRefs[backSlot].current?.play();
                    lockedRef.current = false;
                    setCursor((c) => dir === "down" ? c + 1 : c - 1);
                    const pending = pendingRef.current;
                    pendingRef.current = null;
                    if (pending) setTimeout(() => navigateRef.current(pending.dir, pending.file), 0);
                }, GLIDE_MS + 20);
            });
        });
    }, [frontSlot, resolver]);
    navigateRef.current = navigate;

    // Keyboard
    useEffect(() => {
        if (!active) return;
        // 3 next, 1 previous, as in a pass (Space is the tag pointer's).
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
            if (e.code === "Digit3") {
                e.preventDefault();
                if (!e.repeat) navigate("down");
            } else if (e.code === "Digit1") {
                e.preventDefault();
                if (!e.repeat) navigate("up");
            }
        };
        window.addEventListener("keydown", onKey);
        const releaseSpaceAndTab = claimSpaceAndTab();
        return () => {
            window.removeEventListener("keydown", onKey);
            releaseSpaceAndTab();
        };
    }, [active, navigate]);

    // Play/pause on active
    useEffect(() => {
        if (active) videoRefs.forEach((r) => r.current?.play());
        else videoRefs.forEach((r) => r.current?.pause());
    }, [active]);

    const replaceFile = useCallback((file: DbFile) => {
        setSlotFiles((prev) => [
            prev[0]?.id === file.id ? file : prev[0],
            prev[1]?.id === file.id ? file : prev[1],
        ]);
    }, []);

    // The slots hold snapshots of their records, so refetch them whenever
    // something may have changed underneath: scores (a Compare pick, an
    // undo), content or rotation (and their undo), or the path (a Finder
    // rename the watcher followed, a move and its undo).
    const slotFilesRef = useRef(slotFiles);
    slotFilesRef.current = slotFiles;
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const refresh = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const ids = slotFilesRef.current.flatMap((f) => (f ? [f.id] : []));
                if (ids.length === 0) return;
                window.api
                    .getFilesByIds(ids)
                    .then((fresh: DbFile[]) => {
                        const byId = new Map(fresh.map((f) => [f.id, f]));
                        setSlotFiles((prev) => {
                            const next = prev.map((f) => {
                                const n = f ? byId.get(f.id) : undefined;
                                if (!f || !n) return f;
                                const same =
                                    n.path === f.path &&
                                    n.filename === f.filename &&
                                    n.content_hash === f.content_hash &&
                                    n.rotation === f.rotation &&
                                    n.elo_score === f.elo_score;
                                return same ? f : n;
                            }) as [DbFile | null, DbFile | null];
                            return next[0] === prev[0] && next[1] === prev[1] ? prev : next;
                        });
                    })
                    .catch(() => {});
            }, 50);
        };
        const onUpdated = ({ file }: { file: DbFile | undefined }) => {
            if (file) replaceFile(file);
        };
        const offs = [
            window.api.onRanksChanged(refresh),
            window.api.onMediaRenamed(refresh),
            window.api.onMediaUpdated(onUpdated),
            window.api.onHistoryApplied(refresh),
        ];
        return () => {
            offs.forEach((off) => off());
            if (timer) clearTimeout(timer);
        };
    }, [replaceFile]);

    return {
        replaceFile,
        slotFiles,
        slotTransforms,
        slotTransitions,
        frontSlot,
        videoRef0,
        videoRef1,
        currentFile: slotFiles[frontSlot],
        cursor,
        setCursor,
        navigate,
    };
}