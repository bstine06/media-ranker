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
    // left). `file`: slide that file in instead of asking the resolver for
    // the next one. A step asked for mid-slide cuts that slide short (it
    // jumps to its end) and starts at once, so quick presses move as fast as
    // they come. One asked for while the next file is still being looked up
    // waits for its slide to start (latest wins).
    const frontRef = useRef(frontSlot);
    frontRef.current = frontSlot;
    const cursorRef = useRef(cursor);
    cursorRef.current = cursor;
    // The slide under way: ends it now (as its timer would).
    const finishRef = useRef<(() => void) | null>(null);
    const pendingRef = useRef<{ dir: "up" | "down"; file?: DbFile } | null>(null);
    const navigateRef = useRef<(dir: "up" | "down", file?: DbFile) => void>(() => {});
    const navigate = useCallback(async (dir: "up" | "down", file?: DbFile) => {
        if (finishRef.current) finishRef.current();
        if (lockedRef.current) {
            pendingRef.current = { dir, file };
            return;
        }

        lockedRef.current = true;
        const frontSlot = frontRef.current;
        videoRefs[frontSlot].current?.pause();

        const incoming = file ?? (await resolver(dir, cursorRef.current));
        if (!incoming) {
            lockedRef.current = false;
            pendingRef.current = null;
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
                const finish = () => {
                    clearTimeout(timer);
                    finishRef.current = null;
                    frontRef.current = backSlot;
                    setFrontSlot(backSlot as 0 | 1);
                    // No transition: a slide cut short jumps to its end.
                    setSlotTransitions(["none", "none"]);
                    videoRefs[backSlot].current?.play();
                    lockedRef.current = false;
                    cursorRef.current += dir === "down" ? 1 : -1;
                    setCursor((c) => (dir === "down" ? c + 1 : c - 1));
                };
                const timer = setTimeout(finish, GLIDE_MS + 20);
                finishRef.current = finish;
                // A step asked for while this one was being set up: now.
                const pending = pendingRef.current;
                pendingRef.current = null;
                if (pending) setTimeout(() => navigateRef.current(pending.dir, pending.file), 0);
            });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resolver]);
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