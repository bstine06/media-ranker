import React, { useCallback, useEffect, useRef } from "react";
import type { DbFile } from "@renderer/shared/types/types";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { isTyping } from "@renderer/lib/keys";
import { toMediaUrl, toThumbnailUrl, volumeLevel } from "@renderer/lib/media";
import { attach, detach, setAudible, setMasterVolume } from "@renderer/lib/audioMix";
import { TURN_BOX, turnedFill } from "@renderer/lib/turn";

// Pieces shared by Sweep's moving lanes and a pass's stepped lane, so the
// two look and behave the same: a file's shape before it loads, the media
// in a tile, and F / Esc full screen.

/** A file's own shape (width / height, unturned) from its thumbnail,
 *  before the media itself loads. Tiles take the turned shape from it
 *  (lib/turn: turnedAspect). */
export async function measureAspect(file: DbFile): Promise<number> {
    const fallback = file.media_type === "video" ? 16 / 9 : 1;
    const path = await window.api.getThumbnailPath(file.content_hash);
    if (!path) return fallback;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () =>
            resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : fallback);
        img.onerror = () => resolve(fallback);
        img.src = toThumbnailUrl(path);
    });
}

/** A file's media filling its tile (cropped to fit, no black bars), drawn
 *  turned by its rotation setting (the tile may be shaped for another turn
 *  for a moment: Sweep holds a tile's width while R is pressed).
 *  `onShape` reports the media's own shape, unturned.
 *  Videos loop, playing while `play`, heard while `audible`. Their sound
 *  goes through the lanes' mixer (lib/audioMix), so several can be heard
 *  at once without clipping. */
export function LaneMedia({
    file,
    rootPath,
    audible,
    play,
    onShape,
    onVideo,
}: {
    file: DbFile;
    rootPath: string;
    audible: boolean;
    play: boolean;
    /** The media's real shape (width / height), once loaded. */
    onShape: (aspect: number) => void;
    /** Hands over its <video> (null when it goes), for scrubbing. */
    onVideo?: (el: HTMLVideoElement | null) => void;
}): JSX.Element {
    const { volume } = useSettings();
    const videoRef = useRef<HTMLVideoElement>(null);
    const url = toMediaUrl(rootPath, file.path, file.content_hash);
    const rotation = file.rotation ?? 0;
    const fill: React.CSSProperties = rotation
        ? turnedFill(rotation, "cover")
        : { position: "absolute", inset: 0, width: "100%", height: "100%" };
    // Turned: inside a box the size of the tile (the turn is sized from it).
    const box = (media: JSX.Element): JSX.Element =>
        rotation ? <div style={{ ...TURN_BOX, position: "absolute", inset: 0 }}>{media}</div> : media;

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (play) v.play().catch(() => {});
        else v.pause();
    }, [play, url]);

    // Sound: through the mixer (the element itself stays at full volume;
    // audible or not is its gain there). If the mixer can't take it, the
    // element's own mute and volume, as before.
    const mixed = useRef(false);
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        mixed.current = attach(v);
        if (mixed.current) v.muted = false;
        return () => {
            detach(v);
            mixed.current = false;
        };
    }, []);
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (mixed.current) setAudible(v, audible);
        else v.muted = !audible;
    }, [audible, url]);
    useEffect(() => {
        setMasterVolume(volumeLevel(volume));
        const v = videoRef.current;
        if (v && !mixed.current) v.volume = volumeLevel(volume);
    }, [volume, url]);

    const onVideoRef = useRef(onVideo);
    onVideoRef.current = onVideo;
    useEffect(() => {
        const v = videoRef.current;
        const cb = onVideoRef.current;
        if (!v || !cb) return;
        cb(v);
        return () => cb(null);
        // Re-run when it starts or stops wanting the element.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, !!onVideo]);

    if (file.media_type === "video") {
        return box(
            <video
                ref={videoRef}
                // Before src, or Web Audio hears silence (media:// sends the
                // CORS header).
                crossOrigin="anonymous"
                src={url}
                className="object-cover"
                style={fill}
                onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) onShape(v.videoWidth / v.videoHeight);
                }}
                // Starts muted; unmuted once its sound is in the mixer.
                muted
                loop
                playsInline
                preload="metadata"
            />,
        );
    }
    return box(
        <img
            src={url}
            className="object-cover"
            style={fill}
            draggable={false}
            onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight) onShape(img.naturalWidth / img.naturalHeight);
            }}
        />,
    );
}

/**
 * F: full screen (the window's own, with the sidebar hidden by the app).
 * Esc leaves it (and first closes the file view, if one is open over the
 * view). Leaving the view leaves full screen too. Only a full screen F
 * started is undone; one the user chose themselves stays.
 */
export function useLaneFullscreen({
    active,
    immersive,
    setImmersive,
    pickingRef,
    inspected,
    closeInspected,
}: {
    active: boolean;
    immersive: boolean;
    setImmersive: (on: boolean) => void;
    pickingRef: React.MutableRefObject<boolean>;
    /** A file view open over the lane: Esc closes it, F waits. */
    inspected: boolean;
    closeInspected: () => void;
}): { fullscreen: boolean; setFullscreen: (on: boolean) => void } {
    const fullscreen = immersive;
    const byUs = useRef(false);
    const setFullscreen = useCallback(
        (on: boolean) => {
            setImmersive(on);
            if (on) {
                byUs.current = true;
                window.api.setFullscreen(true);
            } else if (byUs.current) {
                byUs.current = false;
                window.api.setFullscreen(false);
            }
        },
        [setImmersive],
    );
    // The window left full screen some other way (the green button).
    useEffect(() => {
        if (!immersive) byUs.current = false;
    }, [immersive]);
    // Leaving the view leaves full screen: only when this view goes from
    // active to inactive. (Every lane view stays mounted; one that's merely
    // inactive mustn't undo another view's full screen.)
    const wasActive = useRef(active);
    useEffect(() => {
        if (wasActive.current && !active && immersive) setFullscreen(false);
        wasActive.current = active;
    }, [active, immersive, setFullscreen]);
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (inspected) {
                // Esc, or G again (it opened it), closes the file view.
                if (e.code === "Escape") closeInspected();
                else if (
                    e.code === "KeyG" &&
                    !e.repeat &&
                    !pickingRef.current &&
                    !isTyping() &&
                    !document.querySelector("[data-modal]")
                ) {
                    e.preventDefault();
                    // Nothing else gets this press: the view's own G comes
                    // back on as the file view closes and would open it again.
                    e.stopPropagation();
                    closeInspected();
                }
                return;
            }
            if (pickingRef.current || isTyping()) return;
            if (e.code === "KeyF" && !e.repeat) {
                e.preventDefault();
                setFullscreen(!fullscreen);
            } else if (e.code === "Escape" && fullscreen) {
                e.preventDefault();
                setFullscreen(false);
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active, inspected, closeInspected, fullscreen, setFullscreen, pickingRef]);
    return { fullscreen, setFullscreen };
}
