import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { DbFile, DbTag, View } from "../shared/types/types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { useKeyboardShortcut } from "../hooks/useKeyboard";
import { useSettings } from "../contexts/SettingsContext";
import { MediaPlayer } from "./MediaPlayer";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { showInFolder } from "@renderer/lib/filesystem";

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

    const { activeTags, tagMode } = useTags();
    const { rootPath, folderPrefixes, setActiveFolder } = useFolders();

    const MAX_SCORE = 3;

    const tagKey = useMemo(
        () => [...activeTags].sort().join(","),
        [activeTags],
    );

    const loadPair = useCallback(async () => {
        setLoading(true);
        const tagList = activeTags.size > 0 ? [...activeTags] : null;
        const result = await window.api.getPair(
            folderPrefixes,
            tagList,
            tagMode,
        );
        setPair(result);
        setLoading(false);

        window.api.getPair(folderPrefixes, tagList, tagMode).then((next) => {
            if (next) {
                preloadFile(rootPath!, next[0]);
                preloadFile(rootPath!, next[1]);
            }
        });
    }, [folderPrefixes, rootPath, tagKey, tagMode]);

    useEffect(() => {
        loadPair();
    }, [loadPair]);

    const handlePick = useCallback(
        async (winnerId: number, loserId: number, margin: number) => {
            if (comparing) return;
            setComparing(true);
            setHoveredSide(null);
            setScore(0);
            await window.api.recordComparison(winnerId, loserId, margin);
            setStats((s) => ({ comparisons: s.comparisons + 1 }));
            await loadPair();
            setComparing(false);
        },
        [comparing, loadPair],
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

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
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
                            showInFolder(rootPath!, a.path)
                        }}
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
                            showInFolder(rootPath!, b.path)
                        }}
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
                ${disabled ? "border-neutral-800 opacity-60" : hovered ? "border-neutral-500" : "border-neutral-700"}`}
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
            />

            <InlineTagEditor
                file={file}
                onFocusInput={(fn) => {
                    focusTagInput.current = fn;
                }}
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
                <button
                    className="shrink-0 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors"
                    onClick={() => onGoToFolder(file.path.split("/")[0])}
                >
                    Go to folder
                </button>
            </div>
        </div>
    );
}

function InlineTagEditor({
    file,
    onFocusInput,
}: {
    file: DbFile;
    onFocusInput?: (fn: () => void) => void;
}): JSX.Element {
    const [tags, setTags] = useState<DbTag[]>([]);
    const [input, setInput] = useState("");
    const [allTags, setAllTags] = useState<DbTag[]>([]);
    const [focused, setFocused] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
    const [expanded, setExpanded] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        window.api.getTags(file.id).then(setTags);
        window.api.getAllTags().then(setAllTags);
    }, [file.id]);

    // Expose focus function to parent for T hotkey
    useEffect(() => {
        onFocusInput?.(() => inputRef.current?.focus());
    }, [onFocusInput]);

    // Suggestions in natural order — we reverse only at render time
    const filtered = input.trim()
    ? allTags
          .filter(
              (t) =>
                  t.name.toLowerCase().includes(input.toLowerCase()) &&
                  !tags.some((existing) => existing.id === t.id),
          )
          .slice(0, 6)
    : [];

    // visibleSuggestions matches what's rendered: reversed (bottom = closest to input)
    const visibleSuggestions = [...filtered].reverse();

    useEffect(() => {
        setHighlightedIndex(-1);
    }, [input]);

    const addTag = useCallback(
        async (tag: string) => {
            const trimmed = tag.trim().toLowerCase();
            if (!trimmed) return;
            if (tags.some((t) => t.name === trimmed)) {
                setInput("");
                setHighlightedIndex(-1);
                return;
            }
            const updated = await window.api.addTag(file.id, trimmed);
            setTags(updated);
            setAllTags((prev) =>
                prev.some((t) => t.name === trimmed)
                    ? prev
                    : [...prev, updated[updated.length - 1]],
            );
            setInput("");
            setHighlightedIndex(-1);
        },
        [file.id, tags],
    );

    const removeTag = useCallback(
        async (tag: string) => {
            const updated = await window.api.removeTag(file.id, tag);
            setTags(updated);
        },
        [file.id],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            const num = visibleSuggestions.length;

            if (e.key === "ArrowUp") {
                // Up = move toward top of list visually (away from input)
                e.preventDefault();
                setHighlightedIndex((i) => (i < 0 ? num - 1 : i - 1));
            } else if (e.key === "ArrowDown") {
                // Down = move toward bottom of list visually (toward input)
                e.preventDefault();
                highlightedIndex === num - 1
                    ? setHighlightedIndex(-1)
                    : setHighlightedIndex((i) => (i >= num - 1 ? 0 : i + 1));
            } else if (e.key === "Tab") {
                if (
                    highlightedIndex >= 0 &&
                    visibleSuggestions[highlightedIndex]
                ) {
                    e.preventDefault();
                    setInput(visibleSuggestions[highlightedIndex].name);
                    setHighlightedIndex(-1);
                }
            } else if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                if (
                    highlightedIndex >= 0 &&
                    visibleSuggestions[highlightedIndex]
                ) {
                    addTag(visibleSuggestions[highlightedIndex].name);
                } else {
                    addTag(input);
                }
            } else if (e.key === "Escape") {
                if (highlightedIndex >= 0) {
                    setHighlightedIndex(-1);
                } else {
                    inputRef.current?.blur();
                }
            }
        },
        [visibleSuggestions, highlightedIndex, input, addTag],
    );

    const chipsPerRow = 3;
    const maxVisible = 2 * chipsPerRow;
    const showExpand = !expanded && tags.length > maxVisible;
    const visibleTags = expanded ? tags : tags.slice(0, maxVisible);

    return (
        <div className="flex flex-col gap-2 px-3 py-2 border-t border-neutral-800 bg-neutral-950">
            {/* Tag chips — max 2 rows with expand option */}
            <div className="flex flex-wrap gap-1.5">
                {visibleTags.map((tag) => (
                    <span
                        key={tag.id}
                        className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300 text-xs"
                    >
                        {tag.name}
                        <button
                            onClick={() => removeTag(tag.name)}
                            className="text-neutral-600 hover:text-neutral-300 transition-colors leading-none"
                        >
                            ×
                        </button>
                    </span>
                ))}
                {showExpand && (
                    <button
                        onClick={() => setExpanded(true)}
                        className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-500 text-xs hover:text-neutral-300 transition-colors"
                    >
                        +{tags.length - maxVisible} more
                    </button>
                )}
                {expanded && tags.length > maxVisible && (
                    <button
                        onClick={() => setExpanded(false)}
                        className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-500 text-xs hover:text-neutral-300 transition-colors"
                    >
                        less
                    </button>
                )}
            </div>

            {/* Input + suggestions */}
            <div className="relative">
                {focused && visibleSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 bottom-full mb-1 bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden z-10 shadow-lg">
                        {visibleSuggestions.map((tag, i) => (
                            <button
                                key={tag.id}
                                onMouseDown={() => addTag(tag.name)}
                                onMouseEnter={() => setHighlightedIndex(i)}
                                onMouseLeave={() => setHighlightedIndex(-1)}
                                className={`w-full text-left px-3 py-1.5 text-xs transition-colors
                                    ${
                                        i === highlightedIndex
                                            ? "bg-neutral-700 text-white"
                                            : "text-neutral-300 hover:bg-neutral-800"
                                    }`}
                            >
                                {tag.name}
                            </button>
                        ))}
                    </div>
                )}
                <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setFocused(true)}
                    placeholder="Add tag…"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors"
                />
            </div>
        </div>
    );
}
