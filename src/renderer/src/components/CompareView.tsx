import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { DbFile, DbTag, View } from "../shared/types/types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { useKeyboardShortcut } from "../hooks/useKeyboard";
import { useSettings } from "../contexts/SettingsContext";
import { MediaPlayer } from "./MediaPlayer";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { showInFolder } from "@renderer/lib/filesystem";
import { TagPill } from "./TagPill";
import {
    useKingOfHill,
    type KingState,
} from "@renderer/contexts/KingOfHillContext";
import SingleFileView from "./SingleFileView";

// Held at module level so GC doesn't collect them before decode finishes
const preloadCache = new Map<string, HTMLImageElement>();

function preloadImage(url: string): void {
    if (preloadCache.has(url)) return;
    const img = new Image();
    img.src = url;
    preloadCache.set(url, img);
    img.decode().finally(() => preloadCache.delete(url));
}

async function preloadFile(rootPath: string, file: DbFile): Promise<void> {
    if (file.media_type === "video") return;
    preloadImage(toMediaUrl(rootPath, file.path));
}

function xToScore(x: number, width: number, side: "a" | "b"): number {
    // For card A: left edge = far (score 3), right edge = near center (score 1)
    // For card B: right edge = far (score 3), left edge = near center (score 1)
    const fraction = x / width; // 0 = left edge, 1 = right edge
    const distFromInner = side === "a" ? 1 - fraction : fraction;
    // distFromInner: 0 = inner edge (near center of view) = score 1
    //                1 = outer edge (far from center)      = score 3
    if (distFromInner < 1 / 3) return 1;
    if (distFromInner < 2 / 3) return 2;
    return 3;
}

interface PickFlash {
    key: number;
    winnerName: string;
    winnerRank: { before: number; after: number };
    loserName: string;
    loserRank: { before: number; after: number };
    dethroned?: { name: string; streak: number };
}

function RankChange({
    name,
    rank,
}: {
    name: string;
    rank: { before: number; after: number };
}): JSX.Element {
    const delta = rank.before - rank.after; // positive = moved up
    const color =
        delta > 0
            ? "text-emerald-400"
            : delta < 0
              ? "text-rose-400"
              : "text-neutral-400";
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "•";
    return (
        <div className="flex items-center gap-2 min-w-0">
            <span className={`${color} shrink-0`}>{arrow}</span>
            <span className="truncate text-neutral-300 max-w-[14rem]">
                {name}
            </span>
            <span className={`${color} shrink-0 tabular-nums`}>
                {delta === 0
                    ? `#${rank.after}`
                    : `#${rank.before} → #${rank.after}`}
            </span>
        </div>
    );
}

function PickFlashBanner({ flash }: { flash: PickFlash }): JSX.Element {
    return (
        <div className="pointer-events-none absolute left-1/2 top-12 z-30 -translate-x-1/2 animate-[fadeInOut_2.2s_ease-in-out_forwards]">
            <div className="flex flex-col items-center gap-1 rounded-xl border border-neutral-700 bg-neutral-900/95 px-4 py-2.5 text-xs shadow-2xl backdrop-blur">
                {flash.dethroned && (
                    <div className="mb-1 text-sm font-semibold text-amber-300">
                        👑 Dethroned! {flash.dethroned.name} held the hill for{" "}
                        {flash.dethroned.streak} win
                        {flash.dethroned.streak === 1 ? "" : "s"}
                    </div>
                )}
                <RankChange name={flash.winnerName} rank={flash.winnerRank} />
                <RankChange name={flash.loserName} rank={flash.loserRank} />
            </div>
        </div>
    );
}

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
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
    const [stats, setStats] = useState({ comparisons: 0 });
    const [hoveredSide, setHoveredSide] = useState<"a" | "b" | null>(null);
    const [score, setScore] = useState(0);
    const [inspectedFile, setInspectedFile] = useState<DbFile | null>(null);

    const { activeTags, tagMode } = useTags();
    const { rootPath, folderPrefixes, setActiveFolder } = useFolders();

    const MAX_SCORE = 3;

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

    const [flash, setFlash] = useState<PickFlash | null>(null);
    useEffect(() => {
        if (!flash) return;
        const t = setTimeout(() => setFlash(null), flash.dethroned ? 3500 : 2200);
        return () => clearTimeout(t);
    }, [flash]);

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

    const handlePick = useCallback(
        async (winnerId: number, loserId: number, margin: number) => {
            if (comparing || !pair) return;
            setComparing(true);
            setHoveredSide(null);
            setScore(0);
            const res = await window.api.recordComparison(
                winnerId,
                loserId,
                margin,
            );
            setStats((s) => ({ comparisons: s.comparisons + 1 }));

            let nextKing = kingRef.current;
            let dethroned: PickFlash["dethroned"];
            if (res && nextKing) {
                if (winnerId === nextKing.file.id) {
                    nextKing = {
                        ...nextKing,
                        file: res.winner,
                        streak: nextKing.streak + 1,
                    };
                } else if (loserId === nextKing.file.id) {
                    dethroned = {
                        name: nextKing.file.filename,
                        streak: nextKing.streak,
                    };
                    // The old king shouldn't come straight back as challenger.
                    recentChallengersRef.current = [
                        nextKing.file.id,
                        ...recentChallengersRef.current,
                    ].slice(0, 10);
                    nextKing = {
                        file: res.winner,
                        streak: 1,
                        side: pair[0].id === winnerId ? "a" : "b",
                    };
                }
                kingRef.current = nextKing;
                setKing(nextKing);
            }

            if (res) {
                setFlash({
                    key: Date.now(),
                    winnerName: res.winner.filename,
                    winnerRank: res.winnerRank,
                    loserName: res.loser.filename,
                    loserRank: res.loserRank,
                    dethroned,
                });
            }

            await loadPair(nextKing);
            setComparing(false);
        },
        [comparing, pair, loadPair, setKing],
    );

    const handleSkip = useCallback(() => {
        setHoveredSide(null);
        setScore(0);
        loadPair();
    }, [loadPair]);

    const handleLeft = useCallback(() => {
        if (hoveredSide === "a" && score < MAX_SCORE) {
            setScore((s) => s + 1);
        } else if (hoveredSide === null) {
            setScore((s) => s + 1);
            setHoveredSide("a");
        } else if (hoveredSide === "b") {
            if (score === 1) {
                setScore(0);
                setHoveredSide(null);
            } else {
                setScore((s) => s - 1);
            }
        }
    }, [hoveredSide, score]);

    const handleRight = useCallback(() => {
        if (hoveredSide === "b" && score < MAX_SCORE) {
            setScore((s) => s + 1);
        } else if (hoveredSide === null) {
            setScore((s) => s + 1);
            setHoveredSide("b");
        } else if (hoveredSide === "a") {
            if (score === 1) {
                setScore(0);
                setHoveredSide(null);
            } else {
                setScore((s) => s - 1);
            }
        }
    }, [hoveredSide, score]);

    const handleDown = useCallback(() => {
        if (!pair || comparing || hoveredSide === null) return;
        const [a, b] = pair;
        if (hoveredSide === "a") {
            handlePick(a.id, b.id, score);
        } else {
            handlePick(b.id, a.id, score);
        }
        setScore(0);
    }, [pair, comparing, hoveredSide, score, handlePick]);

    useKeyboardShortcut({
        key: "a",
        onKeyPressed: handleLeft,
        enabled: active,
    });
    useKeyboardShortcut({
        key: "d",
        onKeyPressed: handleRight,
        enabled: active,
    });
    useKeyboardShortcut({
        key: "s",
        onKeyPressed: handleDown,
        enabled: active,
    });

    if (loading) {
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
            {flash && <PickFlashBanner key={flash.key} flash={flash} />}
            {king && (
                <div className="flex shrink-0 items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs">
                    <span className="font-semibold text-amber-300">
                        👑 King of the Hill
                    </span>
                    <span className="truncate text-amber-100/80 max-w-[40%]">
                        {king.file.filename}
                    </span>
                    <span className="text-amber-200">
                        {king.streak === 0
                            ? "defending…"
                            : `${king.streak} win${king.streak === 1 ? "" : "s"}`}
                        {king.streak >= 5 && " 🔥"}
                    </span>
                    <button
                        onClick={endKing}
                        className="rounded-md border border-amber-500/40 px-2 py-0.5 text-amber-200 hover:bg-amber-500/20 transition-colors"
                    >
                        Exit
                    </button>
                </div>
            )}
            <div className="flex flex-col p-2 overflow-hidden flex-1 min-h-0">
                <ScoreBar
                    score={score}
                    leader={hoveredSide}
                    onSegmentHover={(newLeader, newScore) => {
                        setHoveredSide(newLeader);
                        setScore(newScore);
                    }}
                    onSegmentLeave={() => {
                        setHoveredSide(null);
                        setScore(0);
                    }}
                    onSegmentClick={handleDown}
                />
                <div
                    className="flex flex-1 overflow-hidden min-h-0"
                    onMouseLeave={() => {
                        setScore(0);
                        setHoveredSide(null);
                    }}
                >
                    <CompareCard
                        file={a}
                        side="a"
                        rootPath={rootPath!}
                        disabled={comparing || !active}
                        hoveredSide={hoveredSide}
                        onScoreHover={(leader, s) => {
                            setHoveredSide(leader);
                            setScore(s);
                        }}
                        onScoreLeave={() => {
                            setScore(0);
                            setHoveredSide(null);
                        }}
                        onCommit={handleDown}
                        onInspectFile={() => {
                            setInspectedFile(a);
                        }}
                        isKing={king?.file.id === a.id}
                        onCrown={() => crown(a, "a")}
                        onGoToFolder={() => {
                            const folderName = a.path.split("/")[0];
                            setActiveFolder(folderName);
                            setView("browse");
                        }}
                    />
                    <div className="w-8" />
                    <CompareCard
                        file={b}
                        side="b"
                        rootPath={rootPath!}
                        disabled={comparing || !active}
                        hoveredSide={hoveredSide}
                        onScoreHover={(leader, s) => {
                            setHoveredSide(leader);
                            setScore(s);
                        }}
                        onScoreLeave={() => {
                            setScore(0);
                            setHoveredSide(null);
                        }}
                        onCommit={handleDown}
                        onInspectFile={() => {
                            setInspectedFile(b);
                        }}
                        isKing={king?.file.id === b.id}
                        onCrown={() => crown(b, "b")}
                        onGoToFolder={() => {
                            const folderName = b.path.split("/")[0];
                            setActiveFolder(folderName);
                            setView("browse");
                        }}
                    />
                </div>
            </div>
        </div>
    );
}

function ScoreBar({
    score,
    leader,
    onSegmentHover,
    onSegmentLeave,
    onSegmentClick,
}: {
    score: number;
    leader: "a" | "b" | null;
    onSegmentHover: (leader: "a" | "b" | null, score: number) => void;
    onSegmentLeave: () => void;
    onSegmentClick: () => void;
}): JSX.Element {
    const totalSegments = 6;

    const isLit = (index: number): boolean => {
        if (leader === "a") return index < 3 && index >= 3 - score;
        if (leader === "b") return index >= 3 && index < 3 + score;
        return false;
    };

    const segmentToState = (i: number) => {
        if (i < 3) return { leader: "a" as const, score: 3 - i };
        return { leader: "b" as const, score: i - 2 };
    };

    const scoreToColor = [
        "",
        "bg-neutral-300",
        "bg-neutral-200",
        "bg-neutral-100",
    ];

    return (
        <div
            className="flex justify-center w-full"
            onMouseLeave={onSegmentLeave}
        >
            {/* Left group: only the leftmost segment gets a left-rounded cap */}
            {Array.from({ length: totalSegments / 2 }, (_, i) => {
                const isLast = i === totalSegments / 2 - 1;
                return (
                    <div
                        key={i}
                        className={`h-3 w-1/6 cursor-pointer ${isLit(i) ? scoreToColor[score] : "bg-neutral-700"} transition-color duration-100 ${i === 0 ? "rounded-tl-full" : ""} ${isLast ? "rounded-tr-full" : ""}`}
                        onMouseEnter={() => {
                            const { leader, score } = segmentToState(i);
                            onSegmentHover(leader, score);
                        }}
                        onClick={onSegmentClick}
                    />
                );
            })}
            <div className="w-8 shrink-0" />
            {/* Right group: only the rightmost segment gets a right-rounded cap */}
            {Array.from({ length: totalSegments / 2 }, (_, i) => {
                const index = i + totalSegments / 2;
                const isLast = i === totalSegments / 2 - 1;
                return (
                    <div
                        key={index}
                        className={`h-3 w-1/6 cursor-pointer ${isLit(index) ? scoreToColor[score] : "bg-neutral-700"} transition-color duration-100 ${i === 0 ? "rounded-tl-full" : ""} ${isLast ? "rounded-tr-full" : ""}`}
                        onMouseEnter={() => {
                            const { leader, score } = segmentToState(index);
                            onSegmentHover(leader, score);
                        }}
                        onClick={onSegmentClick}
                    />
                );
            })}
        </div>
    );
}

function CompareCard({
    file,
    side,
    rootPath,
    disabled,
    hoveredSide,
    onScoreHover,
    onScoreLeave,
    onCommit,
    onInspectFile,
    onGoToFolder,
    isKing,
    onCrown,
}: {
    file: DbFile;
    side: "a" | "b";
    rootPath: string;
    disabled: boolean;
    hoveredSide: "a" | "b" | null;
    onScoreHover: (leader: "a" | "b" | null, score: number) => void;
    onScoreLeave: () => void;
    onCommit: () => void;
    onInspectFile: (file: DbFile) => void;
    onGoToFolder: (folderPath: string) => void;
    isKing: boolean;
    onCrown: () => void;
}): JSX.Element {
    const focusTagInput = useRef<(() => void) | null>(null);
    const hovered = hoveredSide === side;

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            onScoreHover(side, xToScore(relX, rect.width, side));
        },
        [side, onScoreHover],
    );

    return (
        <div
            className={`relative flex flex-1 flex-col overflow-hidden rounded-xl rounded-t-none border-2 transition-all
                ${
                    disabled
                        ? "border-neutral-800 opacity-60"
                        : isKing
                          ? hovered
                              ? "border-amber-300"
                              : "border-amber-500/70"
                          : hovered
                            ? "border-neutral-500"
                            : "border-neutral-700"
                }`}
            onMouseEnter={() => focusTagInput.current?.()}
        >
            <MediaPlayer
                file={file}
                rootPath={rootPath}
                disabled={disabled}
                muted={!hovered || disabled}
                onClick={disabled ? undefined : onCommit}
                onMouseMove={handleMouseMove}
                className="flex-1"
                clickToPauseEnabled={false}
            />

            <div className="shrink-0 border-t border-neutral-800 bg-neutral-900 px-4 py-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <p
                        className="cursor-pointer truncate text-sm font-medium text-neutral-300 hover:text-white transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            onInspectFile(file);
                        }}
                    >
                        {file.filename}
                    </p>
                    <p className="text-xs text-neutral-500">
                        {Math.round(file.elo_score)} pts ·{" "}
                        {file.comparison_count} comparisons
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {isKing ? (
                        <span className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300">
                            👑 King
                        </span>
                    ) : (
                        <button
                            className="rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:border-amber-500/60 hover:text-amber-300 transition-colors"
                            title="Keep this file on screen in King of the Hill mode"
                            onClick={(e) => {
                                e.stopPropagation();
                                onCrown();
                            }}
                        >
                            👑 Crown
                        </button>
                    )}
                    <button
                        className="rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors"
                        onClick={() => onGoToFolder(file.path.split("/")[0])}
                    >
                        Go to folder
                    </button>
                </div>
            </div>
        </div>
    );
}
