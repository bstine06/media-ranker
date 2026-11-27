// The file view as an inspection: the player flies from where it was on
// screen to its spot in the file view, and goes back the same way (the media
// layer moves it; these are its timings and measurements).

/** How long the picture takes to grow in. */
export const INSPECT_MS = 220;
/** …and to go back (quicker: leaving should feel snappy). */
export const INSPECT_OUT_MS = 170;
export const INSPECT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** A flying player is put into its spot this long after its flight's
 *  time (the animation surely done). A view waiting for the landing waits
 *  the flight's time plus this, plus a frame. */
export const LANDING_PAD_MS = 50;

/** The shown video in `root` (not a version hand-off's cover), or null. */
export function shownVideo(root: Element | null): HTMLVideoElement | null {
    return root?.querySelector<HTMLVideoElement>("video:not(.pointer-events-none)") ?? null;
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
    let nw = v ? v.videoWidth : img!.naturalWidth;
    let nh = v ? v.videoHeight : img!.naturalHeight;
    if (!nw || !nh) return box;
    // A file turned sideways (its rotation setting, 90° / 270°) shows the
    // other way round: the box above is already the turned one, the shape
    // isn't.
    const turned = (v ?? img!.parentElement)?.style.transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
    if (turned && Math.round(Number(turned[1]) / 90) % 2 !== 0) [nw, nh] = [nh, nw];
    const s = Math.min(box.width / nw, box.height / nh);
    const w = nw * s;
    const h = nh * s;
    return new DOMRect(box.left + (box.width - w) / 2, box.top + (box.height - h) / 2, w, h);
}

/** A translate + uniform scale, origin top left. */
export interface Flight {
    k: number;
    tx: number;
    ty: number;
}
export const flightCss = (f: Flight): string =>
    f.k === 1 && f.tx === 0 && f.ty === 0 ? "none" : `translate(${f.tx}px, ${f.ty}px) scale(${f.k})`;

/**
 * The transform (origin top left) that puts `picture`, drawn inside `area`,
 * exactly over `target`.
 */
export function flyTo(area: DOMRect, picture: DOMRect, target: DOMRect): Flight {
    const k = target.width / picture.width;
    const tx = target.left - area.left - (picture.left - area.left) * k;
    const ty = target.top - area.top - (picture.top - area.top) * k;
    return { k, tx, ty };
}
