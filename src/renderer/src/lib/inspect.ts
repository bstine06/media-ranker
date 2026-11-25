// The file view as an inspection: the picture grows from where it was on
// screen to its spot in the file view, and goes back the same way.

/** Where a video was when it was picked up, so the next player carries on. */
export interface PlayState {
    time: number;
    paused: boolean;
}

/** How long the picture takes to grow in or go back. */
export const INSPECT_MS = 220;
export const INSPECT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** The shown video in `root` (not a version hand-off's cover), or null. */
export function shownVideo(root: Element | null): HTMLVideoElement | null {
    return root?.querySelector<HTMLVideoElement>("video:not(.pointer-events-none)") ?? null;
}

/** The video's play state in `root`, or null if it shows no video. */
export function playStateIn(root: Element | null): PlayState | null {
    const v = shownVideo(root);
    return v ? { time: v.currentTime, paused: v.paused } : null;
}

/** Carry a play state over to the video in `root`. */
export function applyPlayState(root: Element | null, state: PlayState | null): void {
    const v = shownVideo(root);
    if (!v || !state) return;
    if (Math.abs(v.currentTime - state.time) > 0.05) v.currentTime = state.time;
    if (state.paused) v.pause();
    else v.play().catch(() => {});
}

/**
 * The picture's rect on screen in `root`: the media element's box narrowed
 * to the picture inside it (media is shown object-contain, so a box can
 * have bars). Null when there's nothing laid out.
 */
export function pictureRect(root: Element | null): DOMRect | null {
    if (!root) return null;
    const v = shownVideo(root);
    // The full image (the blurred stand-in has alt="").
    const img = v ? null : root.querySelector<HTMLImageElement>("img:not([alt=''])");
    const el = v ?? img;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const nw = v ? v.videoWidth : img!.naturalWidth;
    const nh = v ? v.videoHeight : img!.naturalHeight;
    if (!nw || !nh) return box;
    const s = Math.min(box.width / nw, box.height / nh);
    const w = nw * s;
    const h = nh * s;
    return new DOMRect(box.left + (box.width - w) / 2, box.top + (box.height - h) / 2, w, h);
}

/**
 * The transform (origin top left) that puts `picture`, drawn inside `area`,
 * exactly over `target`; and the clip that keeps only the picture showing
 * (in the area's own, untransformed coordinates).
 */
export function flyTo(area: DOMRect, picture: DOMRect, target: DOMRect): { transform: string; clipPath: string } {
    const k = target.width / picture.width;
    const tx = target.left - area.left - (picture.left - area.left) * k;
    const ty = target.top - area.top - (picture.top - area.top) * k;
    const clipPath = `inset(${picture.top - area.top}px ${area.right - picture.right}px ${area.bottom - picture.bottom}px ${picture.left - area.left}px)`;
    return { transform: `translate(${tx}px, ${ty}px) scale(${k})`, clipPath };
}
