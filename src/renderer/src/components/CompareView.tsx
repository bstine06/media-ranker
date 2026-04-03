import { useEffect, useState, useCallback, useRef } from "react";
import type { DbFile } from "../types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { useKeyboardShortcut } from "../hooks/useKeyboard";

// Held at module level so GC doesn't collect them before decode finishes
const preloadCache = new Map<string, HTMLImageElement>();

function preloadImage(url: string): void {
    if (preloadCache.has(url)) return;
    const img = new Image();
    img.src = url;
    preloadCache.set(url, img);
    // Clean up after decode so the cache doesn't grow forever
    img.decode().finally(() => preloadCache.delete(url));
}

async function preloadFile(rootPath: string, file: DbFile): Promise<void> {
    if (file.media_type === "video") return;
    // Preload full res (thumbnail is tiny and fast enough not to need it)
    preloadImage(toMediaUrl(rootPath, file.path));
}

export default function CompareView({
    rootPath,
    folderPrefixes,
}: {
    rootPath: string;
    folderPrefixes: string[] | null;
}): JSX.Element {
    const [pair, setPair] = useState<[DbFile, DbFile] | null>(null);
    const [loading, setLoading] = useState(true);
    const [comparing, setComparing] = useState(false);
    const [stats, setStats] = useState({ comparisons: 0 });
    const [hoveredSide, setHoveredSide] = useState<"a" | "b" | null>(null);

    const loadPair = useCallback(async () => {
        setLoading(true);
        const result = await window.api.getPair(folderPrefixes);
        setPair(result);
        setLoading(false);

        // Preload the next pair's full-res images in the background
        window.api.getPair(folderPrefixes).then((next) => {
            if (next) {
                preloadFile(rootPath, next[0]);
                preloadFile(rootPath, next[1]);
            }
        });
    }, [folderPrefixes, rootPath]);

    useEffect(() => {
        loadPair();
    }, [loadPair]);

    const handlePick = useCallback(
        async (winnerId: number, loserId: number) => {
            if (comparing) return;
            setComparing(true);
            setHoveredSide(null);
            await window.api.recordComparison(winnerId, loserId);
            setStats((s) => ({ comparisons: s.comparisons + 1 }));
            await loadPair();
            setComparing(false);
        },
        [comparing, loadPair],
    );

    const handleSkip = useCallback(() => {
        setHoveredSide(null);
        loadPair();
    }, [loadPair]);

    const handleLeft = useCallback(() => {
        setHoveredSide("a");
    }, []);

    const handleRight = useCallback(() => {
        setHoveredSide("b");
    }, []);

    const handleDown = useCallback(() => {
        if (!pair || comparing) return;
        const [a, b] = pair;
        if (hoveredSide === "a") {
            handlePick(a.id, b.id);
        } else {
            handlePick(b.id, a.id);
        }
    }, [pair, comparing, hoveredSide, handlePick]);

    useKeyboardShortcut({ key: "a", onKeyPressed: handleLeft });
    useKeyboardShortcut({ key: "d", onKeyPressed: handleRight });
    useKeyboardShortcut({ key: "s", onKeyPressed: handleDown });

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
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
                <h2 className="text-sm font-medium text-neutral-300">
                    Compare
                </h2>
                <div className="flex items-center gap-4">
                    <span className="text-xs text-neutral-600">
                        {stats.comparisons} comparisons this session
                    </span>
                    <button
                        onClick={handleSkip}
                        className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                    >
                        Skip →
                    </button>
                </div>
            </div>

            <div className="flex flex-1 gap-3 p-4 overflow-hidden">
                <CompareCard
                    file={a}
                    rootPath={rootPath}
                    onPick={() => handlePick(a.id, b.id)}
                    disabled={comparing}
                    forceHover={hoveredSide === "a"}
                    onMouseEnter={() => setHoveredSide("a")}
                    onMouseLeave={() => setHoveredSide(null)}
                />
                <CompareCard
                    file={b}
                    rootPath={rootPath}
                    onPick={() => handlePick(b.id, a.id)}
                    disabled={comparing}
                    forceHover={hoveredSide === "b"}
                    onMouseEnter={() => setHoveredSide("b")}
                    onMouseLeave={() => setHoveredSide(null)}
                />
            </div>
        </div>
    );
}

function LoadingCover(): JSX.Element {
    return (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-neutral-800">
    <div className="h-full bg-white/40 animate-[shimmer_1.5s_ease-in-out_infinite]" 
         style={{ width: '60%' }} />
  </div>
    );
}

function CompareCard({
    file,
    rootPath,
    onPick,
    disabled,
    forceHover,
    onMouseEnter,
    onMouseLeave,
}: {
    file: DbFile;
    rootPath: string;
    onPick: () => void;
    disabled: boolean;
    forceHover: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}): JSX.Element {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const [fullLoaded, setFullLoaded] = useState(false);
    const [mouseHover, setMouseHover] = useState(false);
    const hovered = forceHover || mouseHover;
    const isVideo = file.media_type === "video";
    const isGif = file.media_type === "gif";
    const fullUrl = toMediaUrl(rootPath, file.path);

    useEffect(() => {
        setThumbUrl(null);
        setFullLoaded(false);

        window.api.getThumbnailPath(file.content_hash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [file.content_hash]);

    // LoadingCover shows until full res is done
    const showLoadingCover = !isVideo && !isGif && !fullLoaded;

    return (
        <div
            className={`relative flex flex-1 flex-col overflow-hidden rounded-xl border-2 transition-all cursor-pointer
                ${
                    disabled
                        ? "border-neutral-800 opacity-60"
                        : hovered
                          ? "border-white"
                          : "border-neutral-700"
                }`}
            onClick={onPick}
            onMouseEnter={() => {
                setMouseHover(true);
                onMouseEnter();
            }}
            onMouseLeave={() => {
                setMouseHover(false);
                onMouseLeave();
            }}
        >
            <div className="relative flex-1 overflow-hidden bg-neutral-900">
                {isVideo ? (
                    <video
                        key={fullUrl}
                        src={fullUrl}
                        className="h-full w-full object-contain"
                        muted={!hovered}
                        loop
                        playsInline
                        autoPlay
                    />
                ) : (
                    <>
                        {/* Blurred thumbnail shown instantly */}
                        {thumbUrl && (
                            <img
                                src={thumbUrl}
                                alt={file.filename}
                                className="absolute inset-0 h-full w-full object-contain transition-opacity duration-300"
                                style={{
                                    filter: "blur(8px)",
                                    transform: "scale(1.0)",
                                    opacity: fullLoaded ? 0 : 1,
                                }}
                            />
                        )}
                        {/* Full res fades in once loaded */}
                        <img
                            src={fullUrl}
                            alt={file.filename}
                            className="relative h-full w-full object-contain transition-opacity duration-300"
                            style={{ opacity: fullLoaded ? 1 : 0 }}
                            onLoad={() => setFullLoaded(true)}
                        />
                        {/* LoadingCover overlay while waiting for full res */}
                        {showLoadingCover && <LoadingCover />}
                    </>
                )}

                {isVideo && (
                    <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                        ▶
                    </div>
                )}
                {isGif && (
                    <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                        GIF
                    </div>
                )}
            </div>

            <div className="shrink-0 border-t border-neutral-800 bg-neutral-900 px-4 py-3">
                <p className="truncate text-sm font-medium text-white">
                    {file.filename}
                </p>
                <p className="text-xs text-neutral-500">
                    {Math.round(file.elo_score)} pts · {file.comparison_count}{" "}
                    comparisons
                </p>
            </div>
        </div>
    );
}
