import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import { DbFile } from "@renderer/shared/types/types";
import React, {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
} from "react";
import { isImageReady, preloadImage } from "@renderer/lib/imageCache";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { isTyping } from "@renderer/lib/keys";

/** How far ahead of the old version a rotated video's new version starts,
 *  to cover the time its seek takes while the old one keeps playing. */
const HANDOFF_LEAD_S = 0.15;

function LoadingCover(): JSX.Element {
    return (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-neutral-800">
            <div
                className="h-full bg-white/40 animate-[shimmer_1.5s_ease-in-out_infinite]"
                style={{ width: "60%" }}
            />
        </div>
    );
}

/** Lets a parent drive playback (e.g. Compare's keyboard controls). */
export interface MediaControls {
    togglePlay: () => void;
    /** -1 = back, 1 = forward. Skips a few seconds while playing, one frame while paused. */
    step: (direction: -1 | 1) => void;
}

interface MediaPlayerProps {
    file: DbFile;
    rootPath: string;
    onClick?: () => void;
    onMouseMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
    disabled?: boolean;
    muted?: boolean;
    className?: string;
    clickToPauseEnabled?: boolean;
    /** Off when the parent handles keys itself and drives `controlsRef`. */
    keyboardEnabled?: boolean;
    controlsRef?: React.MutableRefObject<MediaControls | null>;
    /** Preview turn, quarter turns to the left. Turns the picture only, not the controls. */
    rotation?: number;
    /** Called once there's something to show: a video's first frame, or an image (or its blurred thumbnail). */
    onReady?: () => void;
}

export function MediaPlayer({
    file,
    rootPath,
    onClick,
    onMouseMove,
    disabled = false,
    muted = true,
    className = "",
    clickToPauseEnabled = true,
    keyboardEnabled = true,
    controlsRef,
    onReady,
    rotation = 0,
}: MediaPlayerProps): JSX.Element {
    const videoRef = useRef<HTMLVideoElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);

    const isVideo = file.media_type === "video";
    const isGif = file.media_type === "gif";
    const fullUrl = toMediaUrl(rootPath, file.path, file.content_hash);

    // Preloaded images show straight away: no blurred thumbnail, no fade.
    const preloaded = useMemo(() => isImageReady(fullUrl), [fullUrl]);
    const [thumb, setThumb] = useState<{ for: string; url: string } | null>(
        null,
    );
    const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
    const fullLoaded = preloaded || loadedUrl === fullUrl;

    const readySentRef = useRef(false);
    const reportReady = (): void => {
        if (readySentRef.current) return;
        readySentRef.current = true;
        onReady?.();
    };
    // A preloaded image is showable from the first paint.
    useEffect(() => {
        if (preloaded) reportReady();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preloaded]);

    const thumbUrl = thumb?.for === fullUrl ? thumb.url : null;

    const [playing, setPlaying] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [scrubbing, setScrubbing] = useState(false);
    const wasPlayingRef = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // ── Rotation preview ────────────────────────────────────────────────────
    // Only the media layer turns; the controls overlay stays put. A sideways
    // turn swaps the layer's width and height so the turned media still fits.
    const [box, setBox] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) =>
            setBox({
                width: entry.contentRect.width,
                height: entry.contentRect.height,
            }),
        );
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // Animate turning further; snap back when the saved (already rotated)
    // version replaces the preview.
    const prevRotationRef = useRef(rotation);
    const animateTurn = rotation > prevRotationRef.current;
    prevRotationRef.current = rotation;
    const turnStyle = (turns: number, animate: boolean): React.CSSProperties => {
        const sideways = turns % 2 === 1 && box.width > 0;
        const t = "200ms ease-out";
        return {
            width: sideways ? box.height : "100%",
            height: sideways ? box.width : "100%",
            left: sideways ? (box.width - box.height) / 2 : 0,
            top: sideways ? (box.height - box.width) / 2 : 0,
            // Tailwind's base styles cap <video> at max-width: 100%, which
            // would squash a sideways layer in a tall, narrow box (Compare).
            maxWidth: "none",
            maxHeight: "none",
            transform: turns ? `rotate(${-90 * turns}deg)` : undefined,
            transition: animate
                ? `transform ${t}, width ${t}, height ${t}, left ${t}, top ${t}`
                : "none",
        };
    };

    // ── Version hand-off ────────────────────────────────────────────────────
    // When the same video gets a new version (rotation saved), the old
    // element stays up, still turned and still playing, until the new one
    // has loaded and jumped to where the old one has got to. No restart, no
    // black, no freeze.
    const [handoff, setHandoff] = useState<{
        url: string;
        turns: number;
    } | null>(null);
    const handoffElRef = useRef<HTMLVideoElement | null>(null);
    // Where the new version should pick up. Kept apart from `handoff` (the
    // visual cover), which gives up after a few seconds: a slow load must
    // still resume at the same moment rather than restart.
    const resumeRef = useRef<{ time: number; paused: boolean } | null>(null);
    const shownRef = useRef({ id: file.id, url: fullUrl, turns: rotation });
    if (shownRef.current.url !== fullUrl) {
        const old = videoRef.current;
        if (isVideo && shownRef.current.id === file.id && old) {
            handoffElRef.current = old;
            resumeRef.current = { time: old.currentTime, paused: old.paused };
            setHandoff({
                url: shownRef.current.url,
                turns: shownRef.current.turns,
            });
        } else {
            resumeRef.current = null;
            if (handoff) setHandoff(null);
        }
        shownRef.current = { id: file.id, url: fullUrl, turns: rotation };
    } else {
        shownRef.current.turns = rotation;
    }
    // Where the hand-off should resume: the old element's live position
    // while it's still up (it keeps playing), else the last one recorded.
    const resumeTime = (): number => {
        const old = handoffElRef.current;
        if (old && handoff) return old.currentTime;
        return resumeRef.current?.time ?? 0;
    };
    // Never hold the old version forever: drop the cover, but remember
    // where it had got to so the new one still resumes there.
    useEffect(() => {
        if (!handoff) return;
        const t = setTimeout(() => {
            if (resumeRef.current && handoffElRef.current) {
                resumeRef.current.time = handoffElRef.current.currentTime;
            }
            setHandoff(null);
        }, 3000);
        return () => clearTimeout(t);
    }, [handoff]);
    const finishHandoff = (v: HTMLVideoElement): void => {
        const resume = resumeRef.current;
        if (!resume) return;
        resumeRef.current = null;
        if (!resume.paused && !disabled) v.play().catch(() => {});
        setHandoff(null);
    };
    const [isHovered, setIsHovered] = useState(false);

    // Settings volume (0–100). Set on every new element too: a new file or
    // version mounts a fresh <video> at full volume.
    const { volume } = useSettings();
    useEffect(() => {
        const level = Math.max(0, Math.min(1, volume / 100));
        if (videoRef.current) videoRef.current.volume = level;
        if (handoffElRef.current) handoffElRef.current.volume = level;
    }, [volume, fullUrl, handoff]);

    // A new file starts at 0; a new version of the same file (rotated)
    // keeps its place.
    useEffect(() => {
        setCurrentTime(0);
    }, [file.id]);

    // The full image starts loading right away (see the <img> below); the
    // blurred thumbnail only covers the wait if it isn't already in hand.
    useEffect(() => {
        if (isVideo || preloaded) return;
        let cancelled = false;
        window.api.getThumbnailPath(file.content_hash).then((absPath) => {
            if (!cancelled && absPath)
                setThumb({ for: fullUrl, url: toThumbnailUrl(absPath) });
        });
        return () => {
            cancelled = true;
        };
    }, [file.content_hash, fullUrl, isVideo, preloaded]);

    useEffect(() => {
        containerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!videoRef.current) return;
        disabled ? videoRef.current.pause() : videoRef.current.play();
    }, [disabled]);

    useEffect(() => {
        if (!isVideo) return;
        let rafId: number;
        const tick = () => {
            // Mid hand-off the old version is the one playing.
            if (resumeRef.current) setCurrentTime(resumeTime());
            else if (videoRef.current && !scrubbing)
                setCurrentTime(videoRef.current.currentTime);
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, [isVideo, scrubbing]);

    const showLoadingCover = !isVideo && !isGif && !fullLoaded;
    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    const handleClick = useCallback(() => {
        if (disabled) return;
        onClick?.();
    }, [disabled, onClick]);

    // ── Drag out ────────────────────────────────────────────────────────────
    // Dragging the media starts a native file drag (into Finder, an editor,
    // a browser upload, or a sidebar folder). A drag must never count as a
    // click (e.g. a pick in Compare), so the click that may follow is eaten.
    const justDraggedRef = useRef(false);
    const dragOutProps = {
        draggable: true,
        onMouseDown: () => {
            justDraggedRef.current = false;
        },
        onDragStart: (e: React.DragEvent) => {
            e.preventDefault();
            window.getSelection()?.removeAllRanges();
            justDraggedRef.current = true;
            window.api.dragFileOut(file);
        },
    };
    const guardClick =
        (handler: (e: React.MouseEvent) => void) => (e: React.MouseEvent) => {
            if (justDraggedRef.current) {
                justDraggedRef.current = false;
                e.stopPropagation();
                return;
            }
            handler(e);
        };

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (disabled) return;
            onMouseMove?.(e);
        },
        [disabled, onMouseMove],
    );

    const togglePlay = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (!videoRef.current) return;
        videoRef.current.paused
            ? videoRef.current.play()
            : videoRef.current.pause();
    }, []);

    const handleScrubChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            e.stopPropagation();
            const t = parseFloat(e.target.value);
            setCurrentTime(t);
            if (videoRef.current) videoRef.current.currentTime = t;
        },
        [],
    );

    function formatTime(seconds: number): string {
        const s = Math.floor(seconds);
        const m = Math.floor(s / 60);
        return `${m}:${String(s % 60).padStart(2, "0")}`;
    }

    useEffect(() => {
        videoRef.current?.focus();
    }, []);

    // Frame-by-frame when paused, time-skip when playing
    const step = useCallback((direction: -1 | 1) => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
            const frameDuration = 1 / 30;
            const newTime = video.currentTime + direction * frameDuration;
            video.currentTime = Math.min(Math.max(newTime, 0), video.duration);
        } else {
            const newTime = video.currentTime + direction * 3;
            if (newTime < 0 || newTime > video.duration + 2.6) {
                video.currentTime = 0;
            } else if (newTime > video.duration) {
                video.currentTime = video.duration - 0.3;
            } else {
                video.currentTime = newTime;
            }
        }
    }, []);

    useEffect(() => {
        if (!controlsRef) return;
        controlsRef.current = isVideo
            ? { togglePlay: () => togglePlay(), step }
            : null;
        return () => {
            controlsRef.current = null;
        };
    }, [controlsRef, isVideo, togglePlay, step]);

    // keyboard
    useEffect(() => {
        if (!keyboardEnabled) return;
        const onKey = (e: KeyboardEvent) => {
            // For TikTok view: work when not disabled and not muted
            // For other views: work when hovered (which makes muted=false)
            if (disabled || (muted && !isHovered) || !isVideo) return;

            if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;

            // V play/pause, Q / ← rewind, E / → fast forward (lib/keys.ts).
            if (e.code === "KeyV") {
                e.preventDefault();
                if (!e.repeat) togglePlay();
            }

            if (["KeyQ", "KeyE", "ArrowLeft", "ArrowRight"].includes(e.code)) {
                e.preventDefault();
                step(e.code === "KeyQ" || e.code === "ArrowLeft" ? -1 : 1);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [keyboardEnabled, togglePlay, step, disabled, muted, isHovered, isVideo]);

    return (
        <div
            className={`relative overflow-hidden bg-black cursor-pointer select-none ${className}`}
            onMouseMove={handleMouseMove}
            ref={containerRef}
            tabIndex={0}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {isVideo ? (
                // Keyed list, so the outgoing version is the same element it
                // was a moment ago (not remounted) while it covers the swap.
                [
                    handoff && (
                        <video
                            key={handoff.url}
                            src={handoff.url}
                            className="pointer-events-none absolute z-[1] object-contain"
                            style={turnStyle(handoff.turns, false)}
                            muted={muted}
                            loop
                            playsInline
                        />
                    ),
                    <video
                        ref={videoRef}
                        key={fullUrl}
                        src={fullUrl}
                        className="absolute object-contain"
                        style={turnStyle(rotation, animateTurn)}
                        muted={muted}
                        loop
                        playsInline
                        autoPlay={!disabled && !resumeRef.current}
                        onLoadedMetadata={() => {
                            const v = videoRef.current;
                            const d = v?.duration;
                            if (d && isFinite(d)) setDuration(d);
                            // Pick up where the previous version was.
                            const resume = resumeRef.current;
                            if (v && resume) {
                                // Playing: aim a little ahead, since the old
                                // one keeps going while the seek happens.
                                const lead = resume.paused ? 0 : HANDOFF_LEAD_S;
                                const t = resumeTime() + lead;
                                if (t > 0.05 && (!d || t < d)) v.currentTime = t;
                                else finishHandoff(v);
                            }
                        }}
                        onSeeked={() => {
                            const v = videoRef.current;
                            if (v) finishHandoff(v);
                        }}
                        onLoadedData={reportReady}
                        onPlay={() => setPlaying(true)}
                        onPause={() => {
                            // The old version pausing for the hand-off isn't
                            // the viewer pausing.
                            if (!handoff) setPlaying(false);
                        }}
                        onClick={guardClick(
                            clickToPauseEnabled ? togglePlay : () => handleClick(),
                        )}
                        {...dragOutProps}
                    />,
                ]
            ) : (
                <div
                    className="absolute bg-black"
                    style={turnStyle(rotation, animateTurn)}
                    onClick={guardClick(() => handleClick())}
                    {...dragOutProps}
                >
                    {/* Blurred thumbnail, while the full image loads */}
                    {thumbUrl && !preloaded && (
                        <div
                            className="absolute inset-0 z-10 transition-opacity duration-200"
                            style={{
                                opacity: fullLoaded ? 0 : 1,
                            }}
                        >
                            <img
                                src={thumbUrl}
                                alt=""
                                onLoad={reportReady}
                                className="h-full w-full object-contain"
                                style={{
                                    filter: "blur(12px)",
                                    transform: "scale(1.1)",
                                }}
                            />
                        </div>
                    )}

                    <img
                        key={fullUrl}
                        ref={imgRef}
                        src={fullUrl}
                        alt={file.filename}
                        className={`relative h-full w-full object-contain ${preloaded ? "" : "transition-opacity duration-200"}`}
                        style={{
                            opacity: fullLoaded ? 1 : 0,
                        }}
                        onLoad={() => {
                            setLoadedUrl(fullUrl);
                            reportReady();
                            // Keep it decoded in case it comes back (e.g. undo).
                            preloadImage(fullUrl);
                        }}
                        onError={() => {
                            setLoadedUrl(fullUrl);
                            reportReady();
                        }}
                        draggable={false}
                    />

                    {showLoadingCover && <LoadingCover />}
                </div>
            )}

            {isGif && (
                <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                    GIF
                </div>
            )}

            {isVideo && (
                <div
                    className="absolute bottom-0 left-0 right-0 flex items-center group/controls"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/5">
                        <div
                            className="h-full bg-white/40 transition-none"
                            style={{ width: `${progress}%` }}
                        />
                        <input
                            type="range"
                            min={0}
                            max={duration || 0}
                            step={0.01}
                            value={currentTime}
                            onChange={handleScrubChange}
                            onMouseDown={(e) => {
                                e.stopPropagation();
                                wasPlayingRef.current =
                                    !videoRef.current?.paused;
                                setScrubbing(true);
                                videoRef.current?.pause();
                            }}
                            onMouseUp={(e) => {
                                e.stopPropagation();
                                setScrubbing(false);
                                if (wasPlayingRef.current)
                                    videoRef.current?.play();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute inset-0 w-full opacity-0 cursor-pointer"
                            style={{ height: "12px", bottom: 0, top: "auto" }}
                        />
                    </div>
                    <button
                        onClick={togglePlay}
                        className="relative mb-1.5 ml-2 flex items-center justify-center w-5 h-5 rounded text-white/0 group-hover/controls:text-white/60 hover:!text-white/90 transition-colors text-xs"
                    >
                        {playing ? "⏸" : "▶"}
                    </button>
                    <span
                        className="relative mb-1.5 ml-auto mr-2 text-white/0 group-hover/controls:text-white/60 transition-colors tabular-nums"
                        style={{ fontSize: "10px" }}
                    >
                        {formatTime(currentTime)} / {formatTime(duration)}
                    </span> 
                </div>
            )}
        </div>
    );
}