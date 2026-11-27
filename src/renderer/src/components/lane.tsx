import React, { useCallback, useEffect, useRef } from "react";
import type { DbFile } from "@renderer/shared/types/types";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { isTyping } from "@renderer/lib/keys";
import { toThumbnailUrl } from "@renderer/lib/media";

// Pieces shared by Sweep's moving lanes and a pass's stepped lane, so the
// two look and behave the same: a file's shape before it loads, and F / Esc
// full screen. (The media in a tile is the file's media layer player.)

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
