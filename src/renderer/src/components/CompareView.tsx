import {
    useEffect,
    useState,
    useCallback,
    useRef,
    useMemo,
} from "react";
import type { DbFile, DbTag, View } from "../shared/types/types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { preloadImage } from "../lib/imageCache";
import { MediaPlayer, type MediaControls } from "./MediaPlayer";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { showInFolder } from "@renderer/lib/filesystem";
import { TagPill } from "./TagPill";
import { CrownIcon } from "./icons/CrownIcon";
import { FolderIcon } from "./icons/FolderIcon";
import {
    useKingOfHill,
    type KingState,
} from "@renderer/contexts/KingOfHillContext";
import SingleFileView from "./SingleFileView";

async function preloadFile(rootPath: string, file: DbFile): Promise<void> {
    if (file.media_type === "video") return;
    preloadImage(toMediaUrl(rootPath, file.path));
}

type Side = "a" | "b";

// After a new pair appears, ignore S this long so an extra keypress meant
// for the last round doesn't pick on the new one.
const PICK_LOCKOUT_MS = 175;

// The info bar slides in when the cursor is within this many px of a card's top.
const INFO_BAR_ZONE_PX = 88;

// How many picks W can step back through.
const UNDO_LIMIT = 5;

interface UndoEntry {
    comparisonId: number;
    pair: [DbFile, DbFile];
    focus: Side;
    king: KingState | null;
    recentChallengers: number[];
}

export default function CompareView({
    active,
    setView,
}: {
    active: boolean;
    setView: (view: View) => void;
}): JSX.Element {
    const [pair, setPair] = useState<[DbFile, DbFile] | null>(null);
    const [loading, setLoading] = useState(true);
    const [comparing, setComparing] = useState(false);
    // Always one side focused: it has sound and gets Space / Q / E.
    // Starts on the left, then follows whichever side won the last round.
    const [focus, setFocus] = useState<Side>("a");
    const [inspectedFile, setInspectedFile] = useState<DbFile | null>(null);

    const undoStackRef = useRef<UndoEntry[]>([]);
    const pairShownAtRef = useRef(0);
    const controlsA = useRef<MediaControls | null>(null);
    const controlsB = useRef<MediaControls | null>(null);

    const { activeTags, tagMode } = useTags();
    const { rootPath, folderPrefixes, setActiveFolder } = useFolders();

    const tagKey = useMemo(
        () => [...activeTags].sort().join(","),
        [activeTags],
    );

    // Next pair, fetched + preloaded in the background. Tagged with the filter
    // state it was fetched under so it's discarded if filters change.
    const prefetchedRef = useRef<{
        key: string;
        pair: [DbFile, DbFile];
    } | null>(null);

    // ── King of the Hill ────────────────────────────────────────────────────
    const { king, crown, setKing, endKing } = useKingOfHill();
    // loadPair reads the king from here so it doesn't need to be recreated
    // (and re-triggered) every time the king's streak/score changes.
    const kingRef = useRef<KingState | null>(king);
    kingRef.current = king;
    // Challengers the king has faced recently, so it doesn't see repeats.
    const recentChallengersRef = useRef<number[]>([]);

    const loadPair = useCallback(
        async (k: KingState | null = kingRef.current) => {
            const tagList = activeTags.size > 0 ? [...activeTags] : null;
            const filterKey = JSON.stringify([
                folderPrefixes,
                tagKey,
                tagMode,
                rootPath,
                k?.file.id ?? null,
            ]);

            const fetchNext = async (): Promise<[DbFile, DbFile] | null> => {
                if (!k) {
                    return window.api.getPair(folderPrefixes, tagList, tagMode);
                }
                const challenger = await window.api.getChallenger(
                    k.file.id,
                    folderPrefixes,
                    tagList,
                    tagMode,
                    recentChallengersRef.current,
                );
                if (!challenger) return null;
                return k.side === "a"
                    ? [k.file, challenger]
                    : [challenger, k.file];
            };

            const prefetched = prefetchedRef.current;
            prefetchedRef.current = null;

            let result: [DbFile, DbFile] | null;
            if (prefetched && prefetched.key === filterKey) {
                result = prefetched.pair;
                // Use the king's latest score, not the one from prefetch time.
                if (k) {
                    result =
                        k.side === "a"
                            ? [k.file, result[1]]
                            : [result[0], k.file];
                }
            } else {
                setLoading(true);
                result = await fetchNext();
            }

            // King vanished (deleted/missing) or no challengers left: drop
            // back to normal mode rather than showing an empty screen.
            if (k && !result) {
                endKing();
                kingRef.current = null;
                return loadPair(null);
            }

            if (k && result) {
                const challenger = k.side === "a" ? result[1] : result[0];
                recentChallengersRef.current = [
                    challenger.id,
                    ...recentChallengersRef.current.filter(
                        (id) => id !== challenger.id,
                    ),
                ].slice(0, 10);
            }

            setPair(result);
            setLoading(false);

            fetchNext().then((next) => {
                if (!next) return;
                // Don't queue up the exact pair we're showing right now.
                const showing = result ? [result[0].id, result[1].id] : [];
                if (
                    showing.includes(next[0].id) &&
                    showing.includes(next[1].id)
                ) {
                    return;
                }
                prefetchedRef.current = { key: filterKey, pair: next };
                preloadFile(rootPath!, next[0]);
                preloadFile(rootPath!, next[1]);
            });
        },
        [folderPrefixes, rootPath, tagKey, tagMode, endKing],
    );

    useEffect(() => {
        loadPair();
    }, [loadPair]);

    // A king crowned from elsewhere (Browse / Discover) isn't on screen yet,
    // so pull up a matchup for it. Crowning a card that's already showing,
    // or a challenger taking the hill, keeps the current pair.
    useEffect(() => {
        if (!king) return;
        if (pair?.some((f) => f.id === king.file.id)) return;
        loadPair(king);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [king?.file.id]);

    useEffect(() => {
        pairShownAtRef.current = performance.now();
    }, [pair]);

    const handlePick = useCallback(
        async (winnerSide: Side) => {
            if (comparing || !pair) return;
            const winner = winnerSide === "a" ? pair[0] : pair[1];
            const loser = winnerSide === "a" ? pair[1] : pair[0];
            setComparing(true);
            const kingBefore = kingRef.current;
            const recentBefore = recentChallengersRef.current;
            const res = await window.api.recordComparison(winner.id, loser.id);

            if (res) {
                undoStackRef.current = [
                    ...undoStackRef.current,
                    {
                        comparisonId: res.comparisonId,
                        pair,
                        focus,
                        king: kingBefore,
                        recentChallengers: recentBefore,
                    },
                ].slice(-UNDO_LIMIT);
            }

            let nextKing = kingRef.current;
            if (res && nextKing) {
                if (winner.id === nextKing.file.id) {
                    nextKing = {
                        ...nextKing,
                        file: res.winner,
                        streak: nextKing.streak + 1,
                    };
                } else if (loser.id === nextKing.file.id) {
                    // The old king shouldn't come straight back as challenger.
                    recentChallengersRef.current = [
                        nextKing.file.id,
                        ...recentChallengersRef.current,
                    ].slice(0, 10);
                    nextKing = {
                        file: res.winner,
                        streak: 1,
                        side: winnerSide,
                    };
                }
                kingRef.current = nextKing;
                setKing(nextKing);
            }

            await loadPair(nextKing);
            setFocus(winnerSide);
            setComparing(false);
        },
        [comparing, pair, focus, loadPair, setKing],
    );

    // Rolls back the last pick and puts that matchup back on screen.
    const handleUndo = useCallback(async () => {
        if (comparing) return;
        const entry = undoStackRef.current.at(-1);
        if (!entry) return;
        setComparing(true);
        const [a, b] = entry.pair;
        const fresh = await window.api.undoComparison(entry.comparisonId, [
            a.id,
            b.id,
        ]);
        undoStackRef.current = undoStackRef.current.slice(0, -1);
        if (fresh && fresh[0] && fresh[1]) {
            const restored: [DbFile, DbFile] = [fresh[0], fresh[1]];
            let k = entry.king;
            if (k) {
                const kingFile = restored.find((f) => f.id === k!.file.id);
                if (kingFile) k = { ...k, file: kingFile };
            }
            recentChallengersRef.current = entry.recentChallengers;
            kingRef.current = k;
            setKing(k);
            setPair(restored);
            setFocus(entry.focus);
        }
        setComparing(false);
    }, [comparing, setKing]);

    // S: the focused side wins.
    const submit = useCallback(() => {
        if (comparing || !pair) return;
        if (performance.now() - pairShownAtRef.current < PICK_LOCKOUT_MS)
            return;
        handlePick(focus);
    }, [comparing, pair, focus, handlePick]);

    const keysEnabled = active && !inspectedFile;

    useEffect(() => {
        if (!keysEnabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const el = document.activeElement as HTMLElement | null;
            if (
                el?.tagName === "INPUT" ||
                el?.tagName === "TEXTAREA" ||
                el?.isContentEditable
            )
                return;

            const controls =
                focus === "a" ? controlsA.current : controlsB.current;

            // Physical keys, so it's WASD-shaped on any keyboard layout.
            switch (e.code) {
                case "KeyA":
                case "KeyD":
                    e.preventDefault();
                    setFocus(e.code === "KeyA" ? "a" : "b");
                    break;
                case "KeyS":
                    e.preventDefault();
                    if (e.repeat) return;
                    submit();
                    break;
                case "KeyW":
                    e.preventDefault();
                    if (e.repeat) return;
                    handleUndo();
                    break;
                case "KeyQ":
                case "KeyE":
                    e.preventDefault();
                    controls?.step(e.code === "KeyQ" ? -1 : 1);
                    break;
                case "Space":
                    e.preventDefault();
                    if (e.repeat) return;
                    controls?.togglePlay();
                    break;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [keysEnabled, focus, submit, handleUndo]);

    // Only blank the screen on the very first load. Swapping in a new pair
    // keeps the cards mounted, so a video that stays on screen (the king)
    // isn't torn down and reloaded.
    if (loading && !pair) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Loading…
            </div>
        );
    }

    if (!pair) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Not enough files to compare. Add more media to your library.
            </div>
        );
    }

    const [a, b] = pair;


    if (inspectedFile) {
        return (<SingleFileView
            onClose={() => setInspectedFile(null)}
            file={inspectedFile}
            active={active}
            setView={setView}
        />)
    }

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden">
            <div className="flex flex-1 min-h-0 overflow-hidden bg-black">
                    <CompareCard
                        file={a}
                        side="a"
                        rootPath={rootPath!}
                        disabled={!active}
                        focused={focus === "a"}
                        controlsRef={controlsA}
                        onFocus={() => setFocus("a")}
                        onPick={() => handlePick("a")}
                        onInspectFile={() => {
                            setInspectedFile(a);
                        }}
                        isKing={king?.file.id === a.id}
                        streak={king?.streak ?? 0}
                        onCrown={() => crown(a, "a")}
                        onUncrown={endKing}
                        onGoToFolder={() => {
                            const folderName = a.path.split("/")[0];
                            setActiveFolder(folderName);
                            setView("browse");
                        }}
                    />
                    <div className="w-px shrink-0 bg-neutral-800" />
                    <CompareCard
                        file={b}
                        side="b"
                        rootPath={rootPath!}
                        disabled={!active}
                        focused={focus === "b"}
                        controlsRef={controlsB}
                        onFocus={() => setFocus("b")}
                        onPick={() => handlePick("b")}
                        onInspectFile={() => {
                            setInspectedFile(b);
                        }}
                        isKing={king?.file.id === b.id}
                        streak={king?.streak ?? 0}
                        onCrown={() => crown(b, "b")}
                        onUncrown={endKing}
                        onGoToFolder={() => {
                            const folderName = b.path.split("/")[0];
                            setActiveFolder(folderName);
                            setView("browse");
                        }}
                    />
            </div>
        </div>
    );
}

function CompareCard({
    file,
    side,
    rootPath,
    disabled,
    focused,
    controlsRef,
    onFocus,
    onPick,
    onInspectFile,
    onGoToFolder,
    isKing,
    streak,
    onCrown,
    onUncrown,
}: {
    file: DbFile;
    side: Side;
    rootPath: string;
    disabled: boolean;
    focused: boolean;
    controlsRef: React.MutableRefObject<MediaControls | null>;
    onFocus: () => void;
    onPick: () => void;
    onInspectFile: (file: DbFile) => void;
    onGoToFolder: (folderPath: string) => void;
    isKing: boolean;
    streak: number;
    onCrown: () => void;
    onUncrown: () => void;
}): JSX.Element {
    // Only real mouse movement takes focus. The browser can fire mousemove
    // when the content under a resting cursor changes (a new pair loading),
    // which must not override the keyboard's focus.
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const last = lastPointRef.current;
            lastPointRef.current = { x: e.screenX, y: e.screenY };
            if (!last || (last.x === e.screenX && last.y === e.screenY)) return;
            if (!focused) onFocus();
        },
        [focused, onFocus],
    );

    // When this side gets a new file, the old player stays on top until the
    // new one has a frame to show, so the cut never passes through black.
    const [outgoing, setOutgoing] = useState<DbFile | null>(null);
    const [prevFile, setPrevFile] = useState(file);
    if (file.id !== prevFile.id) {
        // Mid-swap already? The outgoing one is still what's visible.
        setOutgoing(outgoing ?? prevFile);
        setPrevFile(file);
    } else if (file !== prevFile) {
        setPrevFile(file); // same file, fresh scores
    }
    const incomingReady = useCallback(() => setOutgoing(null), []);
    // Don't hold the old one forever if the new one never loads.
    useEffect(() => {
        if (!outgoing) return;
        const t = setTimeout(incomingReady, 1500);
        return () => clearTimeout(t);
    }, [outgoing, incomingReady]);

    const [showBar, setShowBar] = useState(false);
    // Bar pieces fade together; only shown pieces catch the mouse, and the
    // bar itself lets clicks through so they still pick.
    const fade = showBar
        ? "opacity-100 pointer-events-auto"
        : "opacity-0 pointer-events-none";

    return (
        <div
            data-side={side}
            className={`relative flex min-w-0 flex-1 flex-col overflow-hidden transition-opacity ${disabled ? "opacity-60" : ""}`}
            onMouseMove={(e) => {
                const top = e.currentTarget.getBoundingClientRect().top;
                setShowBar(e.clientY - top < INFO_BAR_ZONE_PX);
            }}
            onMouseLeave={() => setShowBar(false)}
        >
            {/* Keyed siblings in one list, so the old player is the same
                instance it was a moment ago (not remounted) while it covers
                the swap. */}
            <div className="relative min-h-0 flex-1">
                {[outgoing, file].map((f) => {
                    if (!f) return null;
                    const isOutgoing = f === outgoing;
                    return (
                        <div
                            key={f.id}
                            className={`absolute inset-0 ${isOutgoing ? "pointer-events-none z-10" : ""}`}
                        >
                            {isOutgoing ? (
                                <MediaPlayer
                                    file={f}
                                    rootPath={rootPath}
                                    disabled
                                    muted
                                    className="h-full w-full"
                                    clickToPauseEnabled={false}
                                    keyboardEnabled={false}
                                />
                            ) : (
                                <MediaPlayer
                                    file={f}
                                    rootPath={rootPath}
                                    disabled={disabled}
                                    muted={!focused || disabled}
                                    onClick={disabled ? undefined : onPick}
                                    onMouseMove={handleMouseMove}
                                    onReady={incomingReady}
                                    className="h-full w-full"
                                    clickToPauseEnabled={false}
                                    keyboardEnabled={false}
                                    controlsRef={controlsRef}
                                />
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Focus marker: a thin line across the top of the focused side. */}
            <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 bg-white/80 transition-opacity duration-100 ${focused && !disabled ? "opacity-100" : "opacity-0"}`}
            />

            {/* Info bar: overlays the top of the media while hovered. */}
            <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-150 ${showBar ? "opacity-100" : "opacity-0"}`}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 px-3 pt-2.5">
                <div
                    className={`min-w-0 transition-opacity duration-150 ${fade}`}
                >
                    <p
                        className="cursor-pointer truncate text-sm font-medium text-white/90 drop-shadow hover:text-white transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            onInspectFile(file);
                        }}
                    >
                        {file.filename}
                    </p>
                    <p className="text-xs text-white/60 drop-shadow">
                        {Math.round(file.elo_score)} pts ·{" "}
                        {file.comparison_count} comparisons
                        {isKing && streak > 0 && ` · ${streak} in a row`}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    {/* The king's crown stays visible even with the bar hidden. */}
                    <button
                        className={`rounded-md p-1.5 drop-shadow transition-all duration-150 ${
                            isKing
                                ? "pointer-events-auto opacity-100 text-amber-300 hover:text-amber-200"
                                : `${fade} text-white/60 hover:text-white`
                        }`}
                        title={isKing ? "Stop keeping on screen" : "Keep on screen"}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (isKing) onUncrown();
                            else onCrown();
                        }}
                    >
                        <CrownIcon className="h-4 w-4" />
                    </button>
                    <button
                        className={`rounded-md p-1.5 text-white/60 drop-shadow hover:text-white transition-all duration-150 ${fade}`}
                        title="Go to folder"
                        onClick={(e) => {
                            e.stopPropagation();
                            onGoToFolder(file.path.split("/")[0]);
                        }}
                    >
                        <FolderIcon className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}
