import React, { useState, useRef, useEffect, useCallback } from "react";
import { DbFile } from "../types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Tag Panel ────────────────────────────────────────────────────────────────

function TagPanel({ file }: { file: DbFile }): JSX.Element {
    const [tags, setTags] = useState<string[]>([]);
    const [input, setInput] = useState("");
    const [allTags, setAllTags] = useState<string[]>([]);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Load tags for this file
    useEffect(() => {
        window.api.getTags(file.id).then(setTags);
    }, [file.id]);

    // Load all known tags for autocomplete
    useEffect(() => {
        window.api.getAllTags().then(setAllTags);
    }, []);

    const filtered = input.trim()
    ? allTags.filter(
          (t) =>
              t.toLowerCase().includes(input.toLowerCase()) &&
              !tags.includes(t),
      )
    : [];

    const addTag = useCallback(
        async (tag: string) => {
            const trimmed = tag.trim().toLowerCase();
            if (!trimmed || tags.includes(trimmed)) return;
            const updated = await window.api.addTag(file.id, trimmed);
            setTags(updated);
            setAllTags((prev) =>
                prev.includes(trimmed) ? prev : [...prev, trimmed],
            );
            setInput("");
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
            if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(input);
            } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
                removeTag(tags[tags.length - 1]);
            } else if (e.key === "Escape") {
                setInput("");
                inputRef.current?.blur();
            }
        },
        [input, tags, addTag, removeTag],
    );

    return (
        <div className="flex flex-col w-56 shrink-0 border-r border-neutral-800 bg-neutral-950 overflow-y-auto">
            <div className="px-4 py-3 border-b border-neutral-800">
                <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                    Tags
                </p>
            </div>

            {/* Tag chips */}
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {tags.map((tag) => (
                    <span
                        key={tag}
                        className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300 text-xs group"
                    >
                        {tag}
                        <button
                            onClick={() => removeTag(tag)}
                            className="text-neutral-600 hover:text-neutral-300 transition-colors leading-none"
                        >
                            ×
                        </button>
                    </span>
                ))}
            </div>

            {/* Input */}
            <div className="relative px-3 pt-2 pb-3">
                <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 150)}
                    placeholder="Add tag…"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors"
                />

                {/* Suggestions dropdown */}
                {focused && filtered.length > 0 && (
                    <div className="absolute left-3 right-3 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden z-10 shadow-lg">
                        {filtered.slice(0, 8).map((tag) => (
                            <button
                                key={tag}
                                onMouseDown={() => addTag(tag)}
                                className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="px-3 pb-2">
                <p className="text-xs text-neutral-700">
                    Enter or comma to add
                </p>
            </div>
        </div>
    );
}

// ── FileView ─────────────────────────────────────────────────────────────────

export default function FileView({
    file,
    rootPath,
}: {
    file: DbFile;
    rootPath: string;
}): JSX.Element {
    const isVideo = file.media_type === "video";
    const fullUrl = toMediaUrl(rootPath, file.path);

    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const [fullLoaded, setFullLoaded] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Video state
    const videoRef = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [scrubbing, setScrubbing] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Zoom/pan
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const isPanning = useRef(false);
    const lastPointer = useRef({ x: 0, y: 0 });

    useEffect(() => {
        setThumbUrl(null);
        setFullLoaded(false);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        window.api.getThumbnailPath(file.content_hash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [file.content_hash]);

    // Auto-hide video controls
    const resetControlsTimer = useCallback(() => {
        setShowControls(true);
        if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
        controlsTimerRef.current = setTimeout(
            () => setShowControls(false),
            2500,
        );
    }, []);

    useEffect(() => {
        if (isVideo) resetControlsTimer();
        return () => {
            if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
        };
    }, [isVideo, resetControlsTimer]);

    // Fullscreen — target document.documentElement, not a div
    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }, []);

    useEffect(() => {
        const handler = () =>
            setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", handler);
        return () =>
            document.removeEventListener("fullscreenchange", handler);
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // Don't steal keypresses when typing in the tag input
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

    // Pinch-to-zoom (trackpad sends ctrlKey+wheel)
    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const delta = -e.deltaY * 0.01;
        setZoom((z) => {
            const next = Math.max(1, Math.min(8, z + delta * z));
            if (next === 1) setPan({ x: 0, y: 0 });
            return next;
        });
    }, []);

    // Drag to pan
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

    // Video handlers
    const handleVideoTimeUpdate = useCallback(() => {
        if (!scrubbing && videoRef.current) {
            setCurrentTime(videoRef.current.currentTime);
        }
    }, [scrubbing]);

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
        resetControlsTimer();
    }, [resetControlsTimer]);

    const mediaStyle: React.CSSProperties = {
        transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
        transformOrigin: "center center",
        cursor: zoom > 1 ? "grab" : "default",
    };

    return (
        <div className="flex flex-1 overflow-hidden">
            {/* Left tag panel */}
            <TagPanel file={file} />

            {/* Main viewer */}
            <div className="flex flex-1 flex-col overflow-hidden bg-black">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3 shrink-0">
                    <h2 className="text-sm font-medium text-neutral-300 truncate max-w-[70%]">
                        {file.filename}
                    </h2>
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

                {/* Media area */}
                <div
                    className="relative flex flex-1 items-center justify-center overflow-hidden"
                    onWheel={handleWheel}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onMouseMove={isVideo ? resetControlsTimer : undefined}
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
                            onTimeUpdate={handleVideoTimeUpdate}
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
                            {thumbUrl && !fullLoaded && (
                                <img
                                    src={thumbUrl}
                                    alt={file.filename}
                                    className="absolute inset-0 h-full w-full object-contain"
                                    style={{
                                        filter: "blur(8px)",
                                        transform: "scale(1.05)",
                                    }}
                                />
                            )}
                            <img
                                src={fullUrl}
                                alt={file.filename}
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

                    {/* Video controls overlay */}
                    {isVideo && (
                        <div
                            className={`absolute bottom-0 left-0 right-0 transition-opacity duration-300 ${showControls ? "opacity-100" : "opacity-0"}`}
                            style={{
                                background:
                                    "linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)",
                                padding: "32px 16px 12px",
                            }}
                        >
                            <input
                                type="range"
                                min={0}
                                max={duration || 0}
                                step={0.01}
                                value={currentTime}
                                onChange={handleScrubChange}
                                onMouseDown={() => setScrubbing(true)}
                                onMouseUp={() => setScrubbing(false)}
                                className="w-full mb-2"
                                style={{ accentColor: "white", cursor: "pointer" }}
                            />
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={togglePlay}
                                    className="text-white text-base w-6 h-6 flex items-center justify-center hover:text-neutral-300 transition-colors"
                                >
                                    {playing ? "⏸" : "▶"}
                                </button>
                                <span className="text-xs text-neutral-300 tabular-nums">
                                    {formatTime(currentTime)} /{" "}
                                    {formatTime(duration)}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Zoom hint */}
                    {!isVideo && zoom === 1 && fullLoaded && (
                        <div className="absolute bottom-3 right-3 text-xs text-neutral-700 pointer-events-none select-none">
                            Ctrl+scroll to zoom
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="shrink-0 border-t border-neutral-800 px-5 py-2 flex items-center gap-4">
                    <p className="text-xs text-neutral-500">
                        {Math.round(file.elo_score)} pts
                    </p>
                    <p className="text-xs text-neutral-500">
                        {file.comparison_count} comparisons
                    </p>
                    <p className="text-xs text-neutral-500 uppercase tracking-wide">
                        {file.media_type}
                    </p>
                </div>
            </div>
        </div>
    );
}