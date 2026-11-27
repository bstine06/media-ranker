import { stepVideo, toMediaUrl, toThumbnailUrl, volumeLevel } from "@renderer/lib/media";
import { DbFile } from "@renderer/shared/types/types";
import React, {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useLayoutEffect,
} from "react";
import { isImageReady, preloadImage } from "@renderer/lib/imageCache";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { attach, detach, setAudible, setMasterVolume } from "@renderer/lib/audioMix";
import { isTyping } from "@renderer/lib/keys";
import { fastForwardHeld, onFastForward } from "@renderer/lib/fastForward";

/** A turn's length; then a moment more of following the box (a Sweep tile
 *  easing to its new shape takes a little longer). */
const TURN_MS = 120;
const TURN_SETTLE_MS = 100;

/** How near the bottom of the focused player the mouse brings its bar up. */
const BAR_ZONE_PX = 90;

/** How far ahead of the old version a video's new version (baked / replaced) starts,
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
    onMouseLeave?: () => void;
    onMouseEnter?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
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
    /** No black behind the media: what's underneath shows around it (an
     *  inspection, over the view it was opened from). */
    seeThrough?: boolean;
    /** The playhead strip only as wide as the picture (under it, at the
     *  bottom of the player), instead of the player's full width. */
    barFitsPicture?: boolean;
    /** Sound through the app's mixer (lib/audioMix): muted / the Settings
     *  volume become its gain there and the master's. Read on mount. */
    mixed?: boolean;
    /** The focused media of its view (Compare's focused side, the file view):
     *  only the focused player answers the playback keys (Q / E scrub, hold
     *  4 fast-forward, P play / pause) and shows its bar on the mouse nearing
     *  its bottom. Unset: focused while keyboardEnabled and it's live (heard,
     *  or hovered). */
    focused?: boolean;
    /** The media's own shape (width / height, unturned), once loaded. */
    onAspect?: (aspect: number) => void;
}

export function MediaPlayer({
    file,
    rootPath,
    onClick,
    onMouseMove,
    onMouseLeave,
    onMouseEnter,
    onContextMenu,
    disabled = false,
    muted = true,
    className = "",
    clickToPauseEnabled = true,
    keyboardEnabled = true,
    controlsRef,
    onReady,
    rotation = 0,
    seeThrough = false,
    barFitsPicture = false,
    mixed = false,
    focused,
    onAspect,
}: MediaPlayerProps): JSX.Element {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    // The video's own shape (width / height), once known.
    const [videoAspect, setVideoAspect] = useState<number | null>(null);
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
    // The file's rotation setting (0–3) drawn as a running angle, so a turn
    // always animates the short way: 3 → 0 turns on one more quarter, an
    // undo turns back one. A new file, or new content (replaced / baked: it
    // brings its own orientation, and the old version covers as it was),
    // starts at its own setting with no motion.
    // The transition stays on for the length of the turn, so a re-render in
    // the middle (anything) doesn't cut it short; after that, size changes
    // (a resize) follow at once.
    const angleRef = useRef({ url: fullUrl, rotation, turns: rotation, from: rotation, at: 0 });
    {
        const a = angleRef.current;
        if (a.url !== fullUrl) {
            angleRef.current = { url: fullUrl, rotation, turns: rotation, from: rotation, at: 0 };
        } else if (a.rotation !== rotation) {
            const step = (((rotation - a.rotation) % 4) + 4) % 4;
            angleRef.current = {
                url: fullUrl,
                rotation,
                turns: a.turns + (step === 3 ? -1 : step),
                from: a.turns,
                at: performance.now(),
            };
        }
    }
    const turnsNow = angleRef.current.turns;
    // Mid-turn, the turning layers are drawn frame by frame (see below), not
    // by their style.
    const animateTurn = performance.now() - angleRef.current.at < TURN_MS + TURN_SETTLE_MS;
    const [, setTurnDone] = useState(0);
    // A turn: each frame, the layer's angle and size go from where it was to
    // where it's going on one eased curve, sizes measured live from the
    // picture box (a Sweep tile is easing to its new shape at the same time:
    // the browser's own transition would aim for a size that's stale by the
    // end and snap). Then the style's box-relative sizes take over, equal by
    // then.
    const turnAt = angleRef.current.at;
    useLayoutEffect(() => {
        if (!turnAt) return;
        const { from, turns: to } = angleRef.current;
        let raf = 0;
        const frame = () => {
            const pic = containerRef.current?.querySelector<HTMLElement>("[data-picture]");
            const els = containerRef.current?.querySelectorAll<HTMLElement>("[data-turning]") ?? [];
            const k = Math.min(1, (performance.now() - turnAt) / TURN_MS);
            const e = 1 - (1 - k) ** 3;
            if (pic) {
                const W = pic.clientWidth;
                const H = pic.clientHeight;
                const dims = (t: number): [number, number] => (Math.abs(t % 2) === 1 ? [H, W] : [W, H]);
                const [w0, h0] = dims(from);
                const [w1, h1] = dims(to);
                const turns = from + (to - from) * e;
                els.forEach((el) => {
                    el.style.width = `${w0 + (w1 - w0) * e}px`;
                    el.style.height = `${h0 + (h1 - h0) * e}px`;
                    el.style.transform = `translate(-50%, -50%) rotate(${-90 * turns}deg)`;
                });
            }
            if (performance.now() - turnAt < TURN_MS + TURN_SETTLE_MS) raf = requestAnimationFrame(frame);
            else setTurnDone((n) => n + 1);
        };
        // The first frame now, before the paint (the style no longer sizes it).
        frame();
        return () => cancelAnimationFrame(raf);
    }, [turnAt]);
    // Sized in the picture box's own units (it's a size container): a
    // sideways layer is as wide as the box is tall and the other way round,
    // centred and turned about its middle. So it follows the box at once as
    // the box changes, even in the middle of a turn (a Sweep tile easing to
    // its new shape), instead of being measured and catching up after.
    const turnStyle = (turns: number, animate: boolean): React.CSSProperties => {
        const sideways = Math.abs(turns % 2) === 1;
        // Turning: size and angle are set each frame (see above).
        if (animate) return { position: "absolute", left: "50%", top: "50%", maxWidth: "none", maxHeight: "none" };
        return {
            position: "absolute",
            left: "50%",
            top: "50%",
            width: sideways ? "100cqh" : "100cqw",
            height: sideways ? "100cqw" : "100cqh",
            // Tailwind's base styles cap <video> at max-width: 100%, which
            // would squash a sideways layer in a tall, narrow box (Compare).
            maxWidth: "none",
            maxHeight: "none",
            transform: `translate(-50%, -50%) rotate(${-90 * turns}deg)`,
        };
    };

    // ── Version hand-off ────────────────────────────────────────────────────
    // When the same video gets a new version (replaced; later, baked), the old
    // element stays up, still turned and still playing, until the new one
    // has loaded and jumped to where the old one has got to. No restart, no
    // black, no freeze.
    const [handoff, setHandoff] = useState<{
        url: string;
        turns: number;
    } | null>(null);
    const handoffElRef = useRef<HTMLVideoElement | null>(null);
    // The same for an image: its old version, as it was turned, stays on top
    // until the new one has loaded (no black, no blur, no fade).
    const [imgCover, setImgCover] = useState<{ url: string; turns: number } | null>(null);
    useEffect(() => {
        if (!imgCover) return;
        const t = setTimeout(() => setImgCover(null), 3000);
        return () => clearTimeout(t);
    }, [imgCover]);
    // Where the new version should pick up. Kept apart from `handoff` (the
    // visual cover), which gives up after a few seconds: a slow load must
    // still resume at the same moment rather than restart.
    const resumeRef = useRef<{ time: number; paused: boolean } | null>(null);
    const shownRef = useRef({ id: file.id, url: fullUrl, turns: turnsNow });
    // Whether this element starts by itself, decided once when it's created:
    // not a new version picking up somewhere (it plays itself once there, or
    // stays paused). Flipping it later would set a paused video playing as
    // soon as it had loaded enough.
    const autoPlayRef = useRef(true);
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
            // An image's new version: the old one covers until it's loaded.
            if (!isVideo && shownRef.current.id === file.id && !isImageReady(fullUrl)) {
                setImgCover({ url: shownRef.current.url, turns: shownRef.current.turns });
            } else if (imgCover) {
                setImgCover(null);
            }
        }
        shownRef.current = { id: file.id, url: fullUrl, turns: turnsNow };
        autoPlayRef.current = !resumeRef.current;
    } else {
        shownRef.current.turns = turnsNow;
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
    // Through the mixer: the element plays at full volume into it, muted /
    // not is its gain there, the Settings volume is the master's. (Once an
    // element's sound is in the mixer it's heard nowhere else.) If the mixer
    // can't take it, the element's own mute and volume, as without.
    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const [inMix, setInMix] = useState(false);
    // Tried and failed: its own mute and volume from then on.
    const [mixFailed, setMixFailed] = useState(false);
    const mixedRef = useRef(mixed);
    useLayoutEffect(() => {
        if (!mixedRef.current || !videoEl) return;
        const ok = attach(videoEl);
        setInMix(ok);
        setMixFailed(!ok);
        if (ok) videoEl.muted = false;
        return () => {
            detach(videoEl);
            setInMix(false);
        };
    }, [videoEl]);
    useEffect(() => {
        if (inMix && videoEl) setAudible(videoEl, !muted);
    }, [inMix, videoEl, muted]);
    useEffect(() => {
        const level = volumeLevel(volume);
        if (inMix) setMasterVolume(level);
        else if (videoRef.current) videoRef.current.volume = level;
        if (handoffElRef.current && !inMix) handoffElRef.current.volume = level;
    }, [volume, fullUrl, handoff, inMix]);

    // A new file starts at 0; a new version of the same file (baked / replaced)
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
        // Without scrolling: in a clipped row wider than the screen (Pass's
        // lane) focusing would scroll the row sideways to show it.
        containerRef.current?.focus({ preventScroll: true });
    }, []);

    // Play / pause when `disabled` really changes (React may run this twice
    // on mount in development: the second run does nothing).
    const lastDisabledRef = useRef<boolean | null>(null);
    useEffect(() => {
        if (!videoRef.current) return;
        if (lastDisabledRef.current === disabled) return;
        lastDisabledRef.current = disabled;
        // (A play() cut short by a pause, e.g. a lane tile scrolling out of
        // range, rejects: harmless.)
        if (disabled) videoRef.current.pause();
        else videoRef.current.play().catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Where the playhead strip rests: the player's full width, or just the
    // picture's (shown object-contain, centred; a sideways turn swaps it).
    const barFrame: React.CSSProperties = (() => {
        if (!barFitsPicture || !videoAspect || box.width <= 0 || box.height <= 0) {
            return { left: 0, right: 0 };
        }
        const aspect = rotation % 2 === 1 ? 1 / videoAspect : videoAspect;
        const width = Math.min(box.width, box.height * aspect);
        return { left: (box.width - width) / 2, width };
    })();

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
        videoRef.current?.focus({ preventScroll: true });
    }, []);

    // Frame-by-frame when paused, time-skip when playing
    const step = useCallback((direction: -1 | 1) => {
        const video = videoRef.current;
        if (video) stepVideo(video, direction);
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

    // ── Playback keys and the bar ──
    const isFocused = focused ?? (keyboardEnabled && !disabled && (!muted || isHovered));
    const live = isFocused && isVideo && !disabled;
    // The bar shows for a moment after a key scrub.
    const [poked, setPoked] = useState(0);
    useEffect(() => {
        if (!poked) return;
        const t = setTimeout(() => setPoked(0), 1200);
        return () => clearTimeout(t);
    }, [poked]);
    useEffect(() => {
        if (!live) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
            if (document.querySelector("[data-modal]")) return;
            // P play / pause, Q / ← back, E / → forward (lib/keys.ts); hold 4
            // fast-forward (lib/fastForward).
            if (e.code === "KeyP") {
                e.preventDefault();
                if (!e.repeat) togglePlay();
            } else if (["KeyQ", "KeyE", "ArrowLeft", "ArrowRight"].includes(e.code)) {
                e.preventDefault();
                step(e.code === "KeyQ" || e.code === "ArrowLeft" ? -1 : 1);
                setPoked(Date.now());
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [live, togglePlay, step]);
    // Hold 4: faster while focused (the factor is Pass's speed setting).
    const { passFfFactor } = useSettings();
    const [ffHeld, setFfHeld] = useState(fastForwardHeld);
    useEffect(() => onFastForward(setFfHeld), []);
    const ffOn = live && ffHeld;
    useEffect(() => {
        const v = videoEl;
        if (!v) return;
        v.playbackRate = ffOn ? passFfFactor : 1;
    }, [ffOn, passFfFactor, videoEl]);
    // The mouse near the bottom of the focused player.
    const [nearBottom, setNearBottom] = useState(false);
    useEffect(() => {
        if (!live) {
            setNearBottom(false);
            return;
        }
        const onMove = (e: MouseEvent) => {
            const r = containerRef.current?.getBoundingClientRect();
            const inside = !!r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
            setNearBottom(inside && e.clientY > r!.bottom - BAR_ZONE_PX);
        };
        const onLeave = () => setNearBottom(false);
        window.addEventListener("mousemove", onMove);
        document.addEventListener("mouseleave", onLeave);
        return () => {
            window.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseleave", onLeave);
        };
    }, [live]);
    // Whatever brought it up (the mouse near the bottom, holding 4, dragging
    // the playhead, a key step), it stays the same moment after (poked).
    const barWanted = scrubbing || ffOn || (live && nearBottom);
    const wasWanted = useRef(false);
    useEffect(() => {
        if (wasWanted.current && !barWanted) setPoked(Date.now());
        wasWanted.current = barWanted;
    }, [barWanted]);
    const barShown = isVideo && (barWanted || (live && poked > 0));

    return (
        <div
            className={`relative overflow-hidden ${seeThrough ? "" : "bg-black"} cursor-pointer select-none ${className}`}
            onMouseMove={handleMouseMove}
            ref={containerRef}
            tabIndex={0}
            onMouseEnter={() => {
                setIsHovered(true);
                onMouseEnter?.();
            }}
            onContextMenu={onContextMenu}
            onMouseLeave={() => {
                setIsHovered(false);
                onMouseLeave?.();
            }}
        >
            {/* The picture, on its own so the media layer can move it apart
                from the controls strip (src/renderer/src/media). Same box as
                the player. */}
            <div data-picture className="absolute inset-0" style={{ containerType: "size" }}>
            {isVideo ? (
                // Keyed list, so the outgoing version is the same element it
                // was a moment ago (not remounted) while it covers the swap.
                [
                    handoff && (
                        <video
                            key={handoff.url}
                            crossOrigin={mixed ? "anonymous" : undefined}
                            src={handoff.url}
                            className="pointer-events-none absolute z-[1] object-contain"
                            style={turnStyle(handoff.turns, false)}
                            muted={muted}
                            loop
                            playsInline
                        />
                    ),
                    <video
                        ref={(v) => {
                            videoRef.current = v;
                            setVideoEl(v);
                        }}
                        key={fullUrl}
                        // Before src, or the mixer hears silence (media://
                        // sends the CORS header).
                        crossOrigin={mixed ? "anonymous" : undefined}
                        src={fullUrl}
                        className="absolute object-contain"
                        style={turnStyle(turnsNow, animateTurn)}
                        data-turning={animateTurn ? "" : undefined}
                        // In the mix: muted is its gain there instead.
                        // (Silent until it's in, so nothing plays past it.)
                        muted={inMix ? false : muted || (mixedRef.current && !mixFailed)}
                        loop
                        playsInline
                        autoPlay={!disabled && autoPlayRef.current}
                        onLoadedMetadata={() => {
                            const v = videoRef.current;
                            const d = v?.duration;
                            if (d && isFinite(d)) setDuration(d);
                            if (v?.videoWidth && v.videoHeight) {
                                setVideoAspect(v.videoWidth / v.videoHeight);
                                onAspect?.(v.videoWidth / v.videoHeight);
                            }
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
                <>
                <div
                    className={`absolute ${seeThrough ? "" : "bg-black"}`}
                    style={turnStyle(turnsNow, animateTurn)}
                    data-turning={animateTurn ? "" : undefined}
                    onClick={guardClick(() => handleClick())}
                    {...dragOutProps}
                >
                    {/* Blurred thumbnail, while the full image loads (not
                        under a new version's cover: the old image shows). */}
                    {thumbUrl && !preloaded && !imgCover && (
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
                        className={`relative h-full w-full object-contain ${preloaded || imgCover ? "" : "transition-opacity duration-200"}`}
                        style={{
                            opacity: fullLoaded ? 1 : 0,
                        }}
                        onLoad={(e) => {
                            const img = e.currentTarget;
                            if (img.naturalWidth && img.naturalHeight) onAspect?.(img.naturalWidth / img.naturalHeight);
                            setLoadedUrl(fullUrl);
                            setImgCover(null);
                            reportReady();
                            // Keep it decoded in case it comes back (e.g. undo).
                            preloadImage(fullUrl);
                        }}
                        onError={() => {
                            setLoadedUrl(fullUrl);
                            setImgCover(null);
                            reportReady();
                        }}
                        draggable={false}
                    />

                    {showLoadingCover && !imgCover && <LoadingCover />}
                </div>
                {/* A new version of the same image (replaced; later, baked): the
                    old one stays on top, as it was turned, until the new
                    one has loaded; then they swap in one frame. */}
                {imgCover && (
                    <div
                        className="pointer-events-none absolute z-[2]"
                        style={turnStyle(imgCover.turns, false)}
                    >
                        <img src={imgCover.url} alt="" data-cover className="h-full w-full object-contain" draggable={false} />
                    </div>
                )}
                </>
            )}
            </div>

            {isGif && (
                <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                    GIF
                </div>
            )}

            {isVideo && (
                // The strip's resting place (full width, or the picture's
                // width); the strip itself fills it, except while a file
                // view flight moves it on its own (see ScrollView).
                <div data-hud-frame className="absolute bottom-0 h-[26px]" style={barFrame}>
                <div
                    data-hud
                    className={`absolute inset-0 flex items-center transition-opacity ${barShown ? "opacity-100 duration-150" : "pointer-events-none opacity-0 duration-300"}`}
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
                        className="relative mb-1.5 ml-2 flex items-center justify-center w-5 h-5 rounded text-white/60 hover:!text-white/90 transition-colors text-xs"
                    >
                        {playing ? "⏸" : "▶"}
                    </button>
                    <span
                        className="relative mb-1.5 ml-auto mr-2 text-white/60 tabular-nums"
                        style={{ fontSize: "10px" }}
                    >
                        {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                </div>
                </div>
            )}
        </div>
    );
}