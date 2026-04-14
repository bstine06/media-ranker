import React, { useState, useRef, useEffect, useCallback } from "react";
import { DbFile, DbTag } from "../shared/types/types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { TagPanel } from "./TagPanel";

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── FileReplacer ─────────────────────────────────────────────────────────────

function FileReplacer({
    file,
    onReplaced,
}: {
    file: DbFile;
    onReplaced: (updated: DbFile) => void;
}): JSX.Element {
    const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">(
        "idle",
    );

    async function handleReplace() {
        const newPath = await window.api.openFile([
            "jpg",
            "jpeg",
            "png",
            "gif",
            "mp4",
            "mov",
            "m4v",
        ]);
        if (!newPath) return;
        setStatus("busy");
        try {
            const updated = await window.api.fileReplace(file.path, newPath);
            setStatus("done");
            onReplaced(updated);
        } catch (err) {
            console.error(err);
            setStatus("error");
        }
    }

    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        if (e.dataTransfer.files.length !== 1) return;
        const newPath = (e.dataTransfer.files[0] as any).path as string;
        if (!newPath) return;
        setStatus("busy");
        window.api
            .fileReplace(file.path, newPath)
            .then((updated) => {
                setStatus("done");
                onReplaced(updated);
            })
            .catch((err) => {
                console.error(err);
                setStatus("error");
            });
    }

    const label = {
        idle: "Drop file or click here",
        busy: "Replacing…",
        done: "Replaced!",
        error: "Failed — try again",
    }[status];
    const border = {
        idle: "border-neutral-700",
        busy: "border-yellow-600",
        done: "border-green-600",
        error: "border-red-600",
    }[status];

    return (
        <div className="w-56 border-r border-neutral-800">
            <div
                className={`cursor-pointer flex flex-col gap-0 p-2 m-2 bg-neutral-900 text-center rounded-xl border-2 border-dashed hover:bg-neutral-800 hover:border-neutral-500 ${border}`}
                onClick={status === "busy" ? undefined : handleReplace}
                onDragOver={(e) => e.preventDefault()}
                onDrop={status === "busy" ? undefined : handleDrop}
            >
                <h1 className="text-neutral-400 text-sm font-bold">
                    Replace File
                </h1>
                <p className="text-neutral-500 text-xs">{label}</p>
            </div>
        </div>
    );
}

// ── FileView ─────────────────────────────────────────────────────────────────

export default function FileView({
    file: initialFile,
    rootPath,
    onBack,
}: {
    file: DbFile;
    rootPath: string;
    onBack: () => void;
}): JSX.Element {
    const [currentFile, setCurrentFile] = useState<DbFile>(initialFile);
    useEffect(() => {
        setCurrentFile(initialFile);
    }, [initialFile.content_hash, initialFile.filename, initialFile.path]);

    const isVideo = currentFile.media_type === "video";
    const fullUrl = toMediaUrl(rootPath, currentFile.path);

    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const [fullLoaded, setFullLoaded] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Video state
    const videoRef = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [scrubbing, setScrubbing] = useState(false);

    // Zoom/pan
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const isPanning = useRef(false);
    const lastPointer = useRef({ x: 0, y: 0 });
    const zoomRef = useRef(zoom);
    useEffect(() => {
        zoomRef.current = zoom;
    }, [zoom]);

    useEffect(() => {
        setThumbUrl(null);
        setFullLoaded(false);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        window.api
            .getThumbnailPath(currentFile.content_hash)
            .then((absPath) => {
                if (absPath) setThumbUrl(toThumbnailUrl(absPath));
            });
    }, [currentFile.content_hash]);

    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }, []);

    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", handler);
        return () => document.removeEventListener("fullscreenchange", handler);
    }, []);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (
                document.activeElement?.tagName === "INPUT" ||
                document.activeElement?.tagName === "TEXTAREA"
            )
                return;

            if (e.key === "f" || e.key === "F") toggleFullscreen();
            if (isVideo && videoRef.current) {
                if (e.key === " ") {
                    e.preventDefault();
                    videoRef.current.paused
                        ? videoRef.current.play()
                        : videoRef.current.pause();
                }
                if (e.key === "ArrowLeft")
                    videoRef.current.currentTime = Math.max(
                        0,
                        videoRef.current.currentTime - 5,
                    );
                if (e.key === "ArrowRight")
                    videoRef.current.currentTime = Math.min(
                        videoRef.current.duration,
                        videoRef.current.currentTime + 5,
                    );
            }
            if (e.key === "Escape" && zoom > 1) {
                setZoom(1);
                setPan({ x: 0, y: 0 });
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isVideo, toggleFullscreen, zoom]);

    useEffect(() => {
        if (!isVideo) return;
        let rafId: number;
        const tick = () => {
            if (videoRef.current && !scrubbing) {
                setCurrentTime(videoRef.current.currentTime);
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, [isVideo, scrubbing]);

    const handleScrubChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const t = parseFloat(e.target.value);
            setCurrentTime(t);
            if (videoRef.current) videoRef.current.currentTime = t;
        },
        [],
    );

    const togglePlay = useCallback(() => {
        if (!videoRef.current) return;
        videoRef.current.paused
            ? videoRef.current.play()
            : videoRef.current.pause();
    }, []);

    const mediaAreaRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = mediaAreaRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = -e.deltaY * 0.01;
                setZoom((z) => {
                    const next = Math.max(1, Math.min(8, z + delta * z));
                    if (next === 1) setPan({ x: 0, y: 0 });
                    return next;
                });
            } else if (zoomRef.current > 1) {
                e.preventDefault();
                setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
            }
        };
        el.addEventListener("wheel", handler, { passive: false });
        return () => el.removeEventListener("wheel", handler);
    }, []);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            if (zoom <= 1) return;
            isPanning.current = true;
            lastPointer.current = { x: e.clientX, y: e.clientY };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        },
        [zoom],
    );

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!isPanning.current) return;
        const dx = e.clientX - lastPointer.current.x;
        const dy = e.clientY - lastPointer.current.y;
        lastPointer.current = { x: e.clientX, y: e.clientY };
        setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    }, []);

    const handlePointerUp = useCallback(() => {
        isPanning.current = false;
    }, []);

    const mediaStyle: React.CSSProperties = {
        transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
        transformOrigin: "center center",
        cursor: zoom > 1 ? "grab" : "default",
    };

    const handleShowInFolder = (e: React.MouseEvent) => {
        e.stopPropagation();
        // file.path is relative, so reconstruct the absolute path
        window.api.showInFolder(`${rootPath}/${initialFile.path}`);
    };

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <button
                        onClick={onBack}
                        className="shrink-0 text-neutral-500 hover:text-neutral-200 transition-colors"
                        title="Back"
                    >
                        <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15.75 19.5L8.25 12l7.5-7.5"
                            />
                        </svg>
                    </button>
                    <h2
                        className="cursor-pointer text-sm font-medium text-neutral-300 truncate"
                        onClick={handleShowInFolder}
                        title={"Show in Finder"}
                    >
                        {currentFile.filename}
                    </h2>
                </div>
                <div className="flex items-center gap-3">
                    {zoom > 1 && (
                        <button
                            onClick={() => {
                                setZoom(1);
                                setPan({ x: 0, y: 0 });
                            }}
                            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                        >
                            {Math.round(zoom * 100)}% · Reset
                        </button>
                    )}
                    <button
                        onClick={toggleFullscreen}
                        className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                        title="Fullscreen (F)"
                    >
                        {isFullscreen ? "⊠ Exit fullscreen" : "⊡ Fullscreen"}
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="flex flex-1 overflow-hidden">
                

                <div className="flex flex-1 flex-col overflow-hidden bg-black">
                    <div
                        ref={mediaAreaRef}
                        className="relative flex flex-1 items-center justify-center overflow-hidden"
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                    >
                        {isVideo ? (
                            <video
                                ref={videoRef}
                                key={fullUrl}
                                src={fullUrl}
                                style={mediaStyle}
                                className="max-h-full max-w-full object-contain select-none"
                                loop
                                playsInline
                                autoPlay
                                onLoadedMetadata={() => {
                                    if (videoRef.current)
                                        setDuration(videoRef.current.duration);
                                }}
                                onPlay={() => setPlaying(true)}
                                onPause={() => setPlaying(false)}
                                onClick={togglePlay}
                            />
                        ) : (
                            <>
                                {thumbUrl && (
                                    <img
                                        src={thumbUrl}
                                        alt={currentFile.filename}
                                        className="absolute inset-0 h-full w-full object-contain transition-opacity duration-500"
                                        style={{
                                            opacity:
                                                thumbUrl && !fullLoaded ? 1 : 0,
                                        }}
                                    />
                                )}
                                <img
                                    src={fullUrl}
                                    alt={currentFile.filename}
                                    style={{
                                        ...mediaStyle,
                                        opacity: fullLoaded ? 1 : 0,
                                    }}
                                    className="max-h-full max-w-full object-contain select-none transition-opacity duration-300"
                                    onLoad={() => setFullLoaded(true)}
                                    draggable={false}
                                />
                            </>
                        )}

                        {!isVideo && zoom === 1 && fullLoaded && (
                            <div className="absolute bottom-3 right-3 text-xs text-neutral-700 pointer-events-none select-none">
                                Pinch to zoom · scroll to pan
                            </div>
                        )}
                    </div>

                    {isVideo && (
                        <div className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-4 py-2 flex items-center gap-3">
                            <button
                                onClick={togglePlay}
                                className="text-white text-base w-6 h-6 flex items-center justify-center hover:text-neutral-300 transition-colors shrink-0"
                            >
                                {playing ? "⏸" : "▶"}
                            </button>
                            <span className="text-xs text-neutral-400 tabular-nums shrink-0">
                                {formatTime(currentTime)} /{" "}
                                {formatTime(duration)}
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={duration || 0}
                                step={0.01}
                                value={currentTime}
                                onChange={handleScrubChange}
                                onMouseDown={() => {
                                    setScrubbing(true);
                                    videoRef.current?.pause();
                                }}
                                onMouseUp={() => setScrubbing(false)}
                                className="flex-1"
                                style={{
                                    accentColor: "white",
                                    cursor: "pointer",
                                }}
                            />
                        </div>
                    )}

                    <div className="shrink-0 border-t border-neutral-800 px-5 py-2 flex items-center gap-4">
                        <p className="text-xs text-neutral-500">
                            {Math.round(currentFile.elo_score)} pts
                        </p>
                        <p className="text-xs text-neutral-500">
                            {currentFile.comparison_count} comparisons
                        </p>
                        <p className="text-xs text-neutral-600 uppercase tracking-wide">
                            {currentFile.media_type}
                        </p>
                    </div>
                </div>
                <div className="flex flex-col justify-between">
                    <TagPanel file={currentFile} />
                    <FileReplacer
                        file={currentFile}
                        onReplaced={setCurrentFile}
                    />
                </div>
            </div>
        </div>
    );
}
