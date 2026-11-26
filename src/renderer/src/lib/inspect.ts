// The file view as an inspection: the picture grows from where it was on
// screen to its spot in the file view, and goes back the same way.

/** Where a video was when it was picked up, so the next player carries on. */
export interface PlayState {
    time: number;
    paused: boolean;
}

/** How long the picture takes to grow in. */
export const INSPECT_MS = 220;
/** …and to go back (quicker: leaving should feel snappy). */
export const INSPECT_OUT_MS = 170;
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
    let nw = v ? v.videoWidth : img!.naturalWidth;
    let nh = v ? v.videoHeight : img!.naturalHeight;
    if (!nw || !nh) return box;
    // A preview turned sideways (90° / 270°, not saved yet) shows the other
    // way round: the box above is already the turned one, the shape isn't.
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
export const AT_REST: Flight = { k: 1, tx: 0, ty: 0 };
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

/** The playhead strip's rect on screen in `root`, or null (no video). */
export function barRect(root: Element | null): DOMRect | null {
    return root?.querySelector("[data-hud]")?.getBoundingClientRect() ?? null;
}

/** A bar's stand-in where a view shows none: along the picture's bottom edge. */
export const barUnder = (picture: DOMRect, height: number): DOMRect =>
    new DOMRect(picture.left, picture.bottom - height, picture.width, height);

/**
 * The playhead strip during a flight. The media area (which holds it) is
 * being moved by a CSS transition from `fromF` to `toF`; each frame this
 * reads how far along it is and places the strip so that, on screen, it
 * goes from `from` to `to` on the same progress, unscaled (its own size,
 * just the rect changing). `areaRest` / the strip's frame are measured with
 * the area untransformed. At the end the strip goes back to its resting
 * place, or (`hold`) stays at `to` (the file view is about to close).
 * Returns a stop.
 */
export function flyBar(
    area: HTMLElement,
    areaRest: DOMRect,
    fromF: Flight,
    toF: Flight,
    from: DOMRect,
    to: DOMRect,
    hold: boolean,
    ms: number,
): () => void {
    const hud = area.querySelector<HTMLElement>("[data-hud]");
    const frame = hud?.parentElement;
    if (!hud || !frame) return () => {};
    const frameRest = frame.getBoundingClientRect();
    // The strip's start can lie outside the shrunken area (the other view
    // draws it at the window's bottom, below the picture): nothing between
    // it and the area clips it while it flies.
    const unclipped: HTMLElement[] = [];
    for (let el: HTMLElement | null = frame.parentElement; el; el = el.parentElement) {
        unclipped.push(el);
        if (el === area) break;
    }
    const overflows = unclipped.map((el) => el.style.overflow);
    for (const el of unclipped) el.style.overflow = "visible";
    // Progress is read off whichever part of the transform changes most.
    const parts = [
        { a: fromF.k * areaRest.width, b: toF.k * areaRest.width, of: (m: DOMMatrixReadOnly) => m.a * areaRest.width },
        { a: fromF.tx, b: toF.tx, of: (m: DOMMatrixReadOnly) => m.e },
        { a: fromF.ty, b: toF.ty, of: (m: DOMMatrixReadOnly) => m.f },
    ];
    const lead = parts.reduce((x, y) => (Math.abs(y.b - y.a) > Math.abs(x.b - x.a) ? y : x));
    const place = (m: DOMMatrixReadOnly) => {
        const span = lead.b - lead.a;
        const e = span === 0 ? 1 : Math.min(1, Math.max(0, (lead.of(m) - lead.a) / span));
        const r = {
            left: from.left + (to.left - from.left) * e,
            top: from.top + (to.top - from.top) * e,
            width: from.width + (to.width - from.width) * e,
            height: from.height + (to.height - from.height) * e,
        };
        const k = m.a || 1;
        // Screen = area's rest corner + translate + k × (position in the area).
        const x = (r.left - areaRest.left - m.e) / k - (frameRest.left - areaRest.left);
        const y = (r.top - areaRest.top - m.f) / k - (frameRest.top - areaRest.top);
        Object.assign(hud.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            right: "auto",
            bottom: "auto",
            transformOrigin: "0 0",
            transform: `scale(${1 / k})`,
        });
    };
    const clear = () => {
        for (const p of ["left", "top", "width", "height", "right", "bottom", "transformOrigin", "transform"] as const) {
            hud.style[p] = "";
        }
        unclipped.forEach((el, i) => (el.style.overflow = overflows[i]));
    };
    const live = () => {
        const t = getComputedStyle(area).transform;
        return new DOMMatrixReadOnly(t === "none" ? undefined : t);
    };
    const start = performance.now();
    let raf = 0;
    const tick = () => {
        if (performance.now() - start > ms + 40) {
            if (hold) place(new DOMMatrixReadOnly(flightCss(toF) === "none" ? undefined : flightCss(toF)));
            else clear();
            return;
        }
        place(live());
        raf = requestAnimationFrame(tick);
    };
    place(new DOMMatrixReadOnly(flightCss(fromF) === "none" ? undefined : flightCss(fromF)));
    raf = requestAnimationFrame(tick);
    return () => {
        cancelAnimationFrame(raf);
        clear();
    };
}
