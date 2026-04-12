import { useSettings } from "@renderer/contexts/SettingsContext";
import {
    formatFileSize,
    toMediaUrl,
    toThumbnailUrl,
} from "@renderer/lib/media";
import { DbFile } from "@renderer/shared/types/types";
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { TagPanel } from "./FileView";
import { MediaPlayer } from "./MediaPlayer";
import { mergeRefs } from "@renderer/lib/refs";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { FolderIcon } from "./icons/FolderIcon";

const preloadCache = new Map<string, HTMLImageElement>();

function preloadImage(url: string): Promise<void> {
    if (preloadCache.has(url)) return Promise.resolve();
    const img = new Image();
    img.src = url;
    preloadCache.set(url, img);
    return img.decode().catch(() => {});
}

// ── Single slide ─────────────────────────────────────────────────────────────

const MediaSlide = React.forwardRef<
    HTMLVideoElement,
    { file: DbFile; rootPath: string; disabled: boolean }
>(({ file, rootPath, disabled }, ref) => {
    const localRef = useRef<HTMLVideoElement>(null);
    const handleClick = useCallback(() => {
        localRef.current?.paused
            ? localRef.current.play()
            : localRef.current!.pause();
    }, []);
    return (
        <div className="relative flex h-full w-full flex-col bg-black">
            <MediaPlayer
                file={file}
                rootPath={rootPath}
                muted={false}
                className="h-full w-full"
                onClick={handleClick}
                disabled={disabled}
            />
        </div>
    );
});

// ── Main view ────────────────────────────────────────────────────────────────

export default function ScrollView({
    rootPath,
    folderPrefixes,
    active,
    onInspectFile,
    activeTags,
    tagMode,
    onGoToFolder,
}: {
    rootPath: string;
    folderPrefixes: string[] | null;
    active: boolean;
    onInspectFile: (file: DbFile) => void;
    activeTags: Set<string>;
    tagMode: "and" | "or";
    onGoToFolder: (folderPath: string) => void;
}): JSX.Element {
    const [history, setHistory] = useState<DbFile[]>([]);
    const [cursor, setCursor] = useState(0);
    const [loading, setLoading] = useState(true);
    const [transitioning, setTransitioning] = useState(false);
    // "up" | "down" — which direction the slide is animating out
    const [slideDir, setSlideDir] = useState<"up" | "down">("down");

    const [folderProfileHash, setFolderProfileHash] = useState<string | null>(
        null,
    );

    const prefetchRef = useRef<DbFile | null>(null);
    // gate: ignore navigate calls while animation is in flight
    const lockedRef = useRef(false);

    const tagKey = useMemo(
        () => [...activeTags].sort().join(","),
        [activeTags],
    );

    const { scrollTime } = useSettings();

    const currentFolder = history[cursor]?.path.split("/")[0] ?? null;

    const folderPrefixesRef = useRef(folderPrefixes);
    const activeTagsRef = useRef(activeTags);
    const tagModeRef = useRef(tagMode);

    useEffect(() => {
        folderPrefixesRef.current = folderPrefixes;
    }, [folderPrefixes]);
    useEffect(() => {
        activeTagsRef.current = activeTags;
    }, [activeTags]);
    useEffect(() => {
        tagModeRef.current = tagMode;
    }, [tagMode]);

    useEffect(() => {
        if (!currentFolder) return;
        const load = async () => {
            try {
                const raw = await window.api.readFolderMetadata(currentFolder);
                setFolderProfileHash(raw.profileImage ?? null);
            } catch {
                setFolderProfileHash(null);
            }
        };
        load();
    }, [currentFolder]);

    // ── Slide state — track both current and previous for overlap transition ─────
    const [prevCursor, setPrevCursor] = useState<number | null>(null);
    const [exitReady, setExitReady] = useState(false);

    const currentVideoRef = useRef<HTMLVideoElement>(null);

    const [frontSlot, setFrontSlot] = useState<0 | 1>(0);
    const [slotFiles, setSlotFiles] = useState<[DbFile | null, DbFile | null]>([
        null,
        null,
    ]);
    const [slotTransforms, setSlotTransforms] = useState<[string, string]>([
        "translateY(0)",
        "translateY(100%)",
    ]);
    const [slotTransitions, setSlotTransitions] = useState<[string, string]>([
        "none",
        "none",
    ]);

    const videoRef0 = useRef<HTMLVideoElement>(null);
    const videoRef1 = useRef<HTMLVideoElement>(null);
    const videoRefs = [videoRef0, videoRef1];

    const scrollTimeRef = useRef(scrollTime);
    useEffect(() => {
        scrollTimeRef.current = scrollTime;
    }, [scrollTime]);

    // ── fetch ─────────────────────────────────────────────────────────────────

    const fetchOne = useCallback(
        async (exclude: DbFile[] = []): Promise<DbFile | null> => {
            const tags = activeTagsRef.current;
            const tagList = tags.size > 0 ? [...tags] : null;
            const excludeIds = exclude.map((f) => f.id);
            let file = await window.api.getRandomFile(
                folderPrefixesRef.current,
                tagList,
                tagModeRef.current,
                excludeIds,
            );
            if (!file) {
                file = await window.api.getRandomFile(
                    folderPrefixesRef.current,
                    tagList,
                    tagModeRef.current,
                    [],
                );
            }
            if (file && file.media_type !== "video") {
                preloadImage(toMediaUrl(rootPath, file.path));
            }
            return file;
        },
        [rootPath], // rootPath is the only thing that should trigger a real reset
    );

    const fetchOneRef = useRef(fetchOne);
    useEffect(() => {
        fetchOneRef.current = fetchOne;
    }, [fetchOne]);

    useEffect(() => {
        prefetchRef.current = null;
    }, [tagKey, tagMode, folderPrefixes]);

    // ── initial load ──────────────────────────────────────────────────────────

    // Hard reset only when rootPath changes (or on mount)
    useEffect(() => {
        setLoading(true);
        prefetchRef.current = null;
        setHistory([]);
        setCursor(0);

        fetchOne([]).then((file) => {
            if (!file) {
                setLoading(false);
                return;
            }
            setSlotFiles([file, null]);
            setSlotTransforms(["translateY(0)", "translateY(100%)"]);
            setSlotTransitions(["none", "none"]);
            setFrontSlot(0);
            setCursor(0);
            setHistory([file]);
            setLoading(false);
            fetchOne([file]).then((f) => {
                prefetchRef.current = f;
            });
        });
    }, [rootPath]); // ← only hard reset on rootPath change

    // Soft reset on filter changes — just bust the prefetch cache
    useEffect(() => {
        prefetchRef.current = null;
    }, [folderPrefixes, tagKey, tagMode]);

    const hasNoFiles = !loading && history.length === 0;

    // watch for the "no files" state and re-trigger the bootstrap 
    // when filters change, only in this specific case
    useEffect(() => {
        if (!hasNoFiles) return;
        prefetchRef.current = null;

        fetchOne([]).then((file) => {
            if (!file) return;
            setSlotFiles([file, null]);
            setSlotTransforms(["translateY(0)", "translateY(100%)"]);
            setSlotTransitions(["none", "none"]);
            setFrontSlot(0);
            setCursor(0);
            setHistory([file]);
            fetchOne([file]).then((f) => {
                prefetchRef.current = f;
            });
        });
    }, [folderPrefixes, tagKey, tagMode]);

    useEffect(() => {
    const unsub = window.api.onMediaRenamed(({ oldRelativePath, relativePath }) => {
        if (prefetchRef.current?.path === oldRelativePath) {
            prefetchRef.current = {
                ...prefetchRef.current,
                path: relativePath,
                filename: relativePath.split("/").pop() ?? prefetchRef.current.filename,
            };
        }
    });
    return () => unsub();
}, []);


    // ── navigation ────────────────────────────────────────────────────────────

    const navigate = useCallback(
        async (dir: "up" | "down") => {
            if (lockedRef.current) return;
            if (dir === "up" && cursor === 0) return;
            lockedRef.current = true;

            // 1. Pause the front slot's video immediately
            videoRefs[frontSlot].current?.pause();

            // 2. Resolve the next file
            let nextHistory = history;
            let nextCursor = cursor;
            if (dir === "down") {
                if (cursor + 1 < history.length) {
                    nextCursor = cursor + 1;
                } else {
                    const candidate = prefetchRef.current;
                    prefetchRef.current = null;
                    const isDupe =
                        candidate && history.some((f) => f.id === candidate.id);
                    const next = isDupe
                        ? await fetchOneRef.current(history)
                        : (candidate ?? (await fetchOneRef.current(history)));
                    if (!next) {
                        lockedRef.current = false;
                        return;
                    }
                    nextHistory = [...history, next];
                    nextCursor = nextHistory.length - 1;
                    setHistory(nextHistory);
                    fetchOneRef.current(nextHistory).then((f) => {
                        prefetchRef.current = f;
                    });
                }
            } else {
                nextCursor = cursor - 1;
            }
            setCursor(nextCursor);

            const backSlot = frontSlot === 0 ? 1 : 0;
            const incoming = nextHistory[nextCursor];
            const offScreenY =
                dir === "down" ? "translateY(100%)" : "translateY(-100%)";
            const exitY =
                dir === "down" ? "translateY(-100%)" : "translateY(100%)";

            // 3. Load the next file into the back slot, snap it off-screen (no transition)
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

            // 4. One rAF to let the browser paint the back slot at its off-screen position,
            //    then animate both slots simultaneously
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setSlotTransitions([
                        `transform ${scrollTimeRef.current}ms cubic-bezier(0.4,0,0.2,1)`,
                        `transform ${scrollTimeRef.current}ms cubic-bezier(0.4,0,0.2,1)`,
                    ]);
                    setSlotTransforms((prev) => {
                        const next = [...prev] as [string, string];
                        next[frontSlot] = exitY; // current flies out
                        next[backSlot] = "translateY(0)"; // incoming flies in
                        return next;
                    });

                    setTimeout(() => {
                        setFrontSlot(backSlot as 0 | 1);
                        setSlotTransitions(["none", "none"]);
                        videoRefs[backSlot].current?.play();
                        lockedRef.current = false;
                    }, scrollTimeRef.current + 20);
                });
            });
        },
        [cursor, history, frontSlot],
    );

    const wheelLatchRef = useRef(false);
    const wheelCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wheelHistoryRef = useRef<{ delta: number; time: number }[]>([]);

    /** Least-squares slope of delta magnitude over time (ms).
     *  Positive = accelerating, Negative = decelerating (inertia) */
    function computeSlope(history: { delta: number; time: number }[]): number {
        const n = history.length;
        if (n < 2) return 0;
        const meanX = history.reduce((s, p) => s + p.time, 0) / n;
        const meanY = history.reduce((s, p) => s + p.delta, 0) / n;
        const num = history.reduce(
            (s, p) => s + (p.time - meanX) * (p.delta - meanY),
            0,
        );
        const den = history.reduce((s, p) => s + (p.time - meanX) ** 2, 0);
        return den === 0 ? 0 : num / den;
    }

    const handleWheel = useCallback(
        (e: React.WheelEvent) => {
            if (lockedRef.current) return;

            const absDelta = Math.abs(e.deltaY);
            if (absDelta < 10) return;

            const now = performance.now();

            // Keep a rolling 120ms window of recent events
            wheelHistoryRef.current.push({ delta: absDelta, time: now });
            wheelHistoryRef.current = wheelHistoryRef.current.filter(
                (p) => now - p.time < 120,
            );

            const slope = computeSlope(wheelHistoryRef.current);

            // Slide the cooldown — release latch once events stop arriving
            if (wheelCooldownRef.current)
                clearTimeout(wheelCooldownRef.current);
            wheelCooldownRef.current = setTimeout(() => {
                wheelLatchRef.current = false;
                wheelHistoryRef.current = [];
            }, 60);

            if (wheelLatchRef.current) return;

            // Only fire if slope is clearly positive (genuine acceleration)
            if (slope < 0.5) return;

            wheelLatchRef.current = true;
            navigate(e.deltaY > 0 ? "down" : "up");
        },
        [navigate],
    );

    // ── keyboard ──────────────────────────────────────────────────────────────

    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight")
                navigate("down");
            if (e.key === "ArrowUp" || e.key === "ArrowLeft") navigate("up");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, navigate]);

    // Play / pause all media when component becomes in/active
    useEffect(() => {
        if (active) {
            console.log("scrollview active ", active);
            videoRefs.forEach((vRef) => vRef.current?.play());
        } else {
            videoRefs.forEach((vRef) => vRef.current?.pause());
        }
    }, [active]);

    // ── render ────────────────────────────────────────────────────────────────

    const currentFile = history[cursor] ?? null;

    const [enterOffset, setEnterOffset] = useState<string | null>(null);

    // When cursor changes, set the enter offset then clear it next frame
    const prevCursorRef = useRef(cursor);
    useEffect(() => {
        if (prevCursorRef.current === cursor) return;
        const movingDown = cursor > prevCursorRef.current;
        prevCursorRef.current = cursor;
        // new slide starts off-screen in the opposite direction of travel
        setEnterOffset(movingDown ? "100%" : "-100%");
        requestAnimationFrame(() => {
            requestAnimationFrame(() => setEnterOffset(null));
        });
    }, [cursor]);

    if (loading)
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-500">
                Loading…
            </div>
        );
    if (!currentFile)
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-500">
                No files found
            </div>
        );

    return (
        <div className="relative flex min-h-0 flex-1">
            <div className="relative flex min-h-0 flex-1 flex-col flex-[4]">
                {/* Media area */}
                <div
                    className="relative min-h-0 flex-1 overflow-hidden"
                    onWheel={handleWheel}
                >
                    {([0, 1] as const).map((slot) => (
                        <div
                            key={slot}
                            className="absolute inset-0"
                            style={{
                                transform: slotTransforms[slot],
                                transition: slotTransitions[slot],
                                zIndex: slot === frontSlot ? 2 : 1,
                            }}
                        >
                            {slotFiles[slot] && (
                                <MediaSlide
                                    file={slotFiles[slot]!}
                                    rootPath={rootPath}
                                    ref={videoRefs[slot]}
                                    disabled={!active || slot != frontSlot}
                                />
                            )}
                        </div>
                    ))}
                </div>

                {/* Nav buttons — full overlay so whole media area triggers hover */}
                <div className="absolute inset-0 z-10 flex items-center justify-end pr-4 pointer-events-none">
                    <div className="flex flex-col gap-2 opacity-0 hover:opacity-100 duration-500 pointer-events-auto">
                        <button
                            onClick={() => navigate("up")}
                            disabled={cursor === 0}
                            className="rounded-full bg-neutral-800 p-2 text-white disabled:opacity-20 hover:bg-black/80"
                        >
                            ▲
                        </button>
                        <button
                            onClick={() => navigate("down")}
                            className="rounded-full bg-neutral-800 p-2 text-white hover:bg-black/80"
                        >
                            ▼
                        </button>
                    </div>
                </div>
            </div>
            <div className="w-56">
                {/* File info */}
                <div className="flex flex-col gap-1 px-3 py-2 border-b border-neutral-800 text-sm">
                    <div
                        className="cursor-pointer flex items-center gap-2 px-3 py-2 border-b border-neutral-800"
                        onClick={() =>
                            {const folderName = currentFile.path.split("/")[0];
                            console.log(folderName)
                            onGoToFolder(folderName)
                            }
                        }
                    >
                        {folderProfileHash ? (
                            <ThumbnailImage
                                contentHash={folderProfileHash}
                                className="w-6 h-6 rounded-full shrink-0"
                            />
                        ) : (
                            <div className="bg-neutral-700 rounded-full shrink-0">
                                <FolderIcon className="w-4 h-4 m-1 text-neutral-500" />
                            </div>
                        )}
                        <span
                            className="text-neutral-400 text-sm truncate"
                            title={currentFile?.path}
                        >
                            {currentFile?.path?.split("/")[0] ?? "—"}
                        </span>
                    </div>
                    <span
                        className="text-neutral-200 font-medium break-all"
                        title={currentFile?.filename}
                        style={{ overflowWrap: "break-word", hyphens: "none" }}
                    >
                        {currentFile?.filename ?? "—"}
                    </span>
                    <span className="text-neutral-500 text-xs">
                        {currentFile?.size != null
                            ? formatFileSize(currentFile.size)
                            : "—"}
                    </span>
                </div>
                <TagPanel file={currentFile} />
            </div>
        </div>
    );
}
