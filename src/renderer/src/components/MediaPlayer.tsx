import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import { DbFile } from "@renderer/shared/types/types";
import React, { useState, useEffect, useRef, useCallback } from "react";

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

interface MediaPlayerProps {
    file: DbFile;
    rootPath: string;
    onClick?: () => void;
    onMouseMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
    disabled?: boolean;
    muted?: boolean;
    className?: string;
}

export function MediaPlayer({
    file,
    rootPath,
    onClick,
    onMouseMove,
    disabled = false,
    muted = true,
    className = "",
}: MediaPlayerProps): JSX.Element {
    const videoRef = useRef<HTMLVideoElement>(null);

    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const [fullLoaded, setFullLoaded] = useState(false);

    const isVideo = file.media_type === "video";
    const isGif = file.media_type === "gif";
    const fullUrl = toMediaUrl(rootPath, file.path);

    const [playing, setPlaying] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [scrubbing, setScrubbing] = useState(false);
    const wasPlayingRef = useRef(false);

    useEffect(() => {
        setThumbUrl(null);
        setFullLoaded(false);
        setCurrentTime(0);
        setDuration(0);
        window.api.getThumbnailPath(file.content_hash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [file.content_hash]);

    useEffect(() => {
        if (!videoRef.current) return;
        disabled ? videoRef.current.pause() : videoRef.current.play();
    }, [disabled]);

    useEffect(() => {
        if (!isVideo) return;
        let rafId: number;
        const tick = () => {
            if (videoRef.current && !scrubbing)
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

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (disabled) return;
            onMouseMove?.(e);
        },
        [disabled, onMouseMove],
    );

    const togglePlay = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
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

    return (
        <div
            className={`relative overflow-hidden bg-neutral-900 cursor-pointer select-none ${className}`}
            onMouseMove={handleMouseMove}
            onClick={handleClick}
        >
            {isVideo ? (
                <video
                    ref={videoRef}
                    key={fullUrl}
                    src={fullUrl}
                    className="h-full w-full object-contain"
                    muted={muted}
                    loop
                    playsInline
                    autoPlay={!disabled}
                    onLoadedMetadata={() => {
                        if (videoRef.current)
                            setDuration(videoRef.current.duration);
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                />
            ) : (
                <>
                    {thumbUrl && (
                        <img
                            src={thumbUrl}
                            alt={file.filename}
                            className="absolute inset-0 h-full w-full object-contain transition-opacity duration-300"
                            style={{
                                filter: "blur(8px)",
                                opacity: fullLoaded ? 0 : 1,
                            }}
                        />
                    )}
                    <img
                        src={fullUrl}
                        alt={file.filename}
                        className="relative h-full w-full object-contain transition-opacity duration-300"
                        style={{ opacity: fullLoaded ? 1 : 0 }}
                        onLoad={() => setFullLoaded(true)}
                        draggable={false}
                    />
                    {showLoadingCover && <LoadingCover />}
                </>
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
                                wasPlayingRef.current = !videoRef.current?.paused;
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
                </div>
            )}
        </div>
    );
}