// The media layer: one player per file, owned here (app level) instead of by
// the views, and moved between places instead of copied.
//
// A view renders a <MediaSpot file=…/>: a box saying "this file goes here".
// The file's player sits inside that box, like any part of the view: it moves,
// is cut off and stacks with the view by itself. Several spots may claim the
// same file (a Compare card, then the file view opening on it): the newest
// claim gets the player; when it lets go, the player goes back to the one
// before. A spot without the player is just an empty box.
//
// Each player is rendered (a React portal) into a box of its own, and that
// box is what moves: from one spot into another in one go, which keeps a
// video playing (it's never out of the page, so it never pauses or reloads).
// Only while flying between spots, or fading out after its spot went, does
// the box float above the app (the float container).
//
// A spot can also carry:
// - an overlay: the view's own pieces that sit on top of the media (Compare's
//   focus line, rank, hover bar…), drawn above the player, pinned to the spot;
// - a fade: the overlay's opacity (a view dimming itself);
// - overlayOnTop: its overlay stays on top even while the spot is dimmed.
// When a spot changes file, the old player stays on top until the new one
// has something to show, so a swap never passes through black.
// A file deleted (in the app or outside it): its player fades out where it
// is (GONE_MS), not going back to any other claim; spots still naming it
// show nothing for it until they move on.

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type MutableRefObject,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { DbFile } from "@renderer/shared/types/types";
import { MediaPlayer, type MediaControls } from "@renderer/components/MediaPlayer";
import { useFolders } from "@renderer/contexts/FolderContext";
import { INSPECT_EASE, flightCss, flyTo, pictureRect } from "@renderer/lib/inspect";

/** How a spot wants the player to behave while it has it. */
export interface SpotPlayer {
    muted?: boolean;
    disabled?: boolean;
    clickToPauseEnabled?: boolean;
    keyboardEnabled?: boolean;
    controlsRef?: MutableRefObject<MediaControls | null>;
    onClick?: () => void;
    onMouseMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
    onMouseLeave?: () => void;
    onMouseEnter?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onReady?: () => void;
    rotation?: number;
    seeThrough?: boolean;
    barFitsPicture?: boolean;
    /** Extra classes on the player's box (e.g. the tag pointer hiding the cursor). */
    className?: string;
}

/** The player and overlay's opacity, and how fast it changes. */
export interface SpotFade {
    opacity: number;
    ms: number;
}

interface SpotState {
    file: DbFile;
    el: HTMLElement | null;
    player: SpotPlayer;
    overlay?: ReactNode;
    fade?: SpotFade;
    /** Its overlay above every player even while dimmed (see the top). */
    overlayOnTop?: boolean;
    /** When the player comes here from another spot (a newer claim, or the
     *  newer one letting go), it flies here over this long; 0: it just
     *  appears (the default). */
    arriveMs?: number;
    /** Spots that change file together (Compare's two sides): their old
     *  players all go at once, when every new one is ready. */
    group?: string;
}

interface Spot extends SpotState {
    id: number;
    /** Claim order: the highest claim on a file has its player. */
    order: number;
}

interface LayerApi {
    claim: (id: number, state: SpotState) => void;
    update: (id: number, state: SpotState) => void;
    release: (id: number) => void;
}

const LayerContext = createContext<LayerApi | null>(null);

let nextSpotId = 1;
let nextOrder = 1;

/** How long a deleted file's player takes to fade out where it is. */
export const GONE_MS = 200;

/** A spot's old player, kept on top after it changed file until the new one
 *  (and, in a group, every new one) is ready. */
interface Leaving {
    spotId: number;
    spot: Spot;
    /** The spot's new player is ready. */
    ready: boolean;
}

export function MediaLayerProvider({ children }: { children: ReactNode }): JSX.Element {
    const spots = useRef(new Map<number, Spot>());
    const leaving = useRef(new Map<number, Leaving>());
    // Files whose player is up and has shown something (it may be moving to
    // another spot: no need to wait for it again).
    const readyFiles = useRef(new Set<number>());
    // Deleted files: fading out (with the spot they were shown at) …
    const fading = useRef(new Map<number, Spot>());
    // … and, until no spot names them any more, never shown again.
    const deleted = useRef(new Set<number>());
    const [, setTick] = useState(0);
    const changed = useCallback(() => setTick((t) => t + 1), []);
    // Each file's player box (see the top), and where boxes float.
    const boxes = useRef(new Map<number, HTMLDivElement>());
    const floatRef = useRef<HTMLDivElement>(null);
    const boxFor = (fileId: number): HTMLDivElement => {
        let b = boxes.current.get(fileId);
        if (!b) {
            b = document.createElement("div");
            boxes.current.set(fileId, b);
        }
        return b;
    };
    // A spot going away: the boxes inside it float where they are first, so
    // they never leave the page with it (a video taken out of the page
    // pauses). Called before React takes the spot's element out.
    const liftFrom = useCallback((el: HTMLElement | null | undefined) => {
        const float = floatRef.current;
        if (!el || !float) return;
        for (const b of boxes.current.values()) if (el.contains(b)) floatAt(b, float);
    }, []);
    // A deleted file stops being one once nothing names it (an undo can
    // bring the same file back later).
    const forget = useCallback(() => {
        for (const id of deleted.current) {
            if (fading.current.has(id)) continue;
            const named = [...spots.current.values(), ...[...leaving.current.values()].map((l) => l.spot)].some(
                (x) => x.file.id === id,
            );
            if (!named) deleted.current.delete(id);
        }
    }, []);
    // A spot's new player is ready (or its wait is over): its old one goes,
    // with the rest of its group once they're all ready too.
    const newReady = useCallback(
        (spotId: number, force = false) => {
            const l = leaving.current.get(spotId);
            if (!l) return;
            l.ready = true;
            const group = l.spot.group;
            const together = group
                ? [...leaving.current.values()].filter((x) => x.spot.group === group)
                : [l];
            if (force || together.every((x) => x.ready)) {
                for (const x of together) leaving.current.delete(x.spotId);
                changed();
            }
        },
        [changed],
    );
    const api = useMemo<LayerApi>(
        () => ({
            claim: (id, state) => {
                spots.current.set(id, { ...state, id, order: nextOrder++ });
                changed();
            },
            update: (id, state) => {
                const s = spots.current.get(id);
                if (!s) return;
                if (s.file.id !== state.file.id && deleted.current.has(s.file.id)) {
                    // Moving on from a deleted file: it's fading by itself,
                    // nothing to cover with.
                    spots.current.set(id, { ...state, id, order: nextOrder++ });
                    forget();
                } else if (s.file.id !== state.file.id) {
                    // Another file here: a new, newest claim; the old player
                    // covers until the new one is ready. A file that already
                    // has a player showing (it was on another spot) needs no
                    // waiting for.
                    const alreadyShowing = readyFiles.current.has(state.file.id);
                    leaving.current.set(id, { spotId: id, spot: s, ready: alreadyShowing });
                    spots.current.set(id, { ...state, id, order: nextOrder++ });
                    if (alreadyShowing) newReady(id);
                } else {
                    spots.current.set(id, { ...s, ...state });
                }
                changed();
            },
            release: (id) => {
                liftFrom(spots.current.get(id)?.el);
                liftFrom(leaving.current.get(id)?.spot.el);
                const had = spots.current.delete(id);
                const covering = leaving.current.delete(id);
                forget();
                if (had || covering) changed();
            },
        }),
        [changed, newReady, forget, liftFrom],
    );

    // A file deleted: its player stays where it's shown now and fades out.
    useEffect(
        () =>
            window.api.onMediaRemoved(({ relativePath }) => {
                const at = new Map<number, Spot>();
                for (const s of spots.current.values()) {
                    if (s.file.path !== relativePath) continue;
                    const o = at.get(s.file.id);
                    if (!o || s.order > o.order) at.set(s.file.id, s);
                }
                for (const [spotId, l] of leaving.current) {
                    if (l.spot.file.path !== relativePath) continue;
                    if (!at.has(l.spot.file.id)) at.set(l.spot.file.id, l.spot);
                    // Covering for a spot's new file: no longer.
                    leaving.current.delete(spotId);
                }
                if (at.size === 0) return;
                for (const [fileId, spot] of at) {
                    deleted.current.add(fileId);
                    fading.current.set(fileId, spot);
                }
                // Groups that were waiting on a deleted file's cover only.
                const groups = new Set([...leaving.current.values()].map((l) => l.spot.group).filter(Boolean));
                for (const g of groups) {
                    const together = [...leaving.current.values()].filter((l) => l.spot.group === g);
                    if (together.every((l) => l.ready)) for (const l of together) leaving.current.delete(l.spotId);
                }
                changed();
            }),
        [changed],
    );
    const faded = useCallback(
        (fileId: number) => {
            fading.current.delete(fileId);
            forget();
            changed();
        },
        [changed, forget],
    );

    // Each file's player goes to its newest claim. A spot's old file (it
    // changed file) keeps its player, the same one, on top until the new one
    // is ready: same key, so nothing is torn down.
    const shown = new Map<number, { spot: Spot; leavingFrom: number | null }>();
    for (const s of spots.current.values()) {
        if (deleted.current.has(s.file.id)) continue;
        const o = shown.get(s.file.id);
        if (!o || s.order > o.spot.order) shown.set(s.file.id, { spot: s, leavingFrom: null });
    }
    for (const l of leaving.current.values()) {
        if (deleted.current.has(l.spot.file.id)) continue;
        if (!shown.has(l.spot.file.id)) shown.set(l.spot.file.id, { spot: l.spot, leavingFrom: l.spotId });
    }

    return (
        <LayerContext.Provider value={api}>
            {children}
            {/* Players flying, or fading after their spot went: above the
                views, below dialogs. */}
            <div ref={floatRef} data-media-float className="pointer-events-none fixed inset-0" style={{ zIndex: LAYER_Z.float }} />
            <div data-media-layer className="pointer-events-none">
                {/* Keyed by file: a player stays the same one whatever it does
                    (moves, covers, fades). Each renders into its own box. */}
                {[
                    ...[...shown.entries()].map(([fileId, { spot, leavingFrom }]) => ({
                        fileId,
                        el: (
                            <LayerPlayer
                                key={fileId}
                                box={boxFor(fileId)}
                                float={floatRef}
                                onGone={() => boxes.current.delete(fileId)}
                                spot={spot}
                                leaving={leavingFrom !== null}
                                readyFiles={readyFiles.current}
                                onShown={() => newReady(spot.id)}
                                onLeft={() => leavingFrom !== null && newReady(leavingFrom, true)}
                            />
                        ),
                    })),
                    ...[...fading.current.entries()].map(([fileId, spot]) => ({
                        fileId,
                        el: (
                            <LayerPlayer
                                key={fileId}
                                box={boxFor(fileId)}
                                float={floatRef}
                                onGone={() => boxes.current.delete(fileId)}
                                spot={spot}
                                leaving={false}
                                gone
                                readyFiles={readyFiles.current}
                                onShown={() => {}}
                                onLeft={() => faded(fileId)}
                            />
                        ),
                    })),
                ].map((x) => x.el)}
                {[...spots.current.values()]
                    .filter((s) => s.overlay)
                    .map((s) => (
                        <SpotOverlay key={`overlay-${s.id}`} spot={s} />
                    ))}
            </div>
        </LayerContext.Provider>
    );
}

/** Keeps `box` exactly over `el` (checked every frame: a spot can move without
 *  changing size, e.g. the sidebar being dragged). */
function useFollow(el: HTMLElement | null, box: MutableRefObject<HTMLDivElement | null>): void {
    useLayoutEffect(() => {
        if (!el) return;
        let raf = 0;
        let last = "";
        const place = () => {
            const b = box.current;
            if (b) {
                const r = el.getBoundingClientRect();
                const key = `${r.left},${r.top},${r.width},${r.height}`;
                if (key !== last) {
                    last = key;
                    Object.assign(b.style, {
                        left: `${r.left}px`,
                        top: `${r.top}px`,
                        width: `${r.width}px`,
                        height: `${r.height}px`,
                    } satisfies CSSProperties);
                }
            }
            raf = requestAnimationFrame(place);
        };
        place();
        return () => cancelAnimationFrame(raf);
    }, [el, box]);
}

/**
 * Stacking among the views. A view that goes over another one (the file view
 * over Compare) sits at FILE_VIEW: above the players its view below put in
 * the background, below the active player, whose own overlay (the file
 * view's buttons on the media) is above it. Dialogs (z-40+) stay on top.
 */
export const LAYER_Z = {
    background: 10,
    backgroundOverlay: 11,
    /** A view laid over another one (Compare's file view). */
    overView: 20,
    active: 30,
    leaving: 31,
    activeOverlay: 35,
    /** Players flying between spots, or fading after their spot went. */
    float: 36,
} as const;
const inBackground = (spot: Spot): boolean => (spot.fade?.opacity ?? 1) < 1;

const fadeStyle = (fade: SpotFade | undefined): CSSProperties => ({
    opacity: fade?.opacity ?? 1,
    transition: fade ? `opacity ${fade.ms}ms ease-out` : undefined,
});

function Player({ spot, onReady }: { spot: Spot; onReady?: () => void }): JSX.Element | null {
    const { rootPath } = useFolders();
    if (!rootPath) return null;
    const p = spot.player;
    return (
        <MediaPlayer
            file={spot.file}
            rootPath={rootPath}
            className="h-full w-full"
            muted={p.muted}
            disabled={p.disabled}
            clickToPauseEnabled={p.clickToPauseEnabled}
            keyboardEnabled={p.keyboardEnabled}
            controlsRef={p.controlsRef}
            onClick={p.onClick}
            onMouseMove={p.onMouseMove}
            onMouseLeave={p.onMouseLeave}
            onMouseEnter={p.onMouseEnter}
            onContextMenu={p.onContextMenu}
            onReady={onReady}
            rotation={p.rotation}
            seeThrough={p.seeThrough}
            barFitsPicture={p.barFitsPicture}
        />
    );
}

/** Float `box` above the app exactly where it is now on screen. */
function floatAt(box: HTMLDivElement, float: HTMLElement): void {
    const r = box.getBoundingClientRect();
    if (box.parentElement !== float) float.appendChild(box);
    Object.assign(box.style, {
        position: "fixed",
        inset: "auto",
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
    } satisfies CSSProperties);
    // Its style as it is now counts as the start of any change that follows
    // (a moved element otherwise starts over: a fade would just jump).
    void getComputedStyle(box).opacity;
}

/** Put `box` inside `el`, filling it. */
function seat(box: HTMLDivElement, el: HTMLElement): void {
    if (box.parentElement !== el) el.appendChild(box);
    // Cleared first: `inset` sets left / top too.
    Object.assign(box.style, { width: "", height: "", left: "", top: "" });
    Object.assign(box.style, { position: "absolute", inset: "0px" } satisfies CSSProperties);
}

/**
 * A file's player, inside its spot. `leaving`: its spot has moved on to
 * another file; it stays on top, not interactive, until the new one is ready
 * (or a moment has passed), then goes.
 */
function LayerPlayer({
    box,
    float,
    onGone,
    spot,
    leaving,
    gone = false,
    readyFiles,
    onShown,
    onLeft,
}: {
    /** Its own box (see the top), rendered into and moved around. */
    box: HTMLDivElement;
    float: MutableRefObject<HTMLDivElement | null>;
    /** It's going for good: its box is dropped. */
    onGone: () => void;
    spot: Spot;
    leaving: boolean;
    /** Its file was deleted: it stays where it is and fades out (sound
     *  too), then onLeft. */
    gone?: boolean;
    /** Kept up to date: this file is in it while its player has shown something. */
    readyFiles: Set<number>;
    onShown: () => void;
    onLeft: () => void;
}): JSX.Element {
    // Into its spot (flying there if it comes from another one). Deleted: it
    // stays where it is.
    useFlight(spot, box, float, gone);
    const onGoneRef = useRef(onGone);
    onGoneRef.current = onGone;
    useLayoutEffect(
        () => () => {
            box.remove();
            onGoneRef.current();
        },
        [box],
    );
    const onReadyRef = useRef(spot.player.onReady);
    onReadyRef.current = spot.player.onReady;
    const onShownRef = useRef(onShown);
    onShownRef.current = onShown;
    const fileId = spot.file.id;
    const ready = useCallback(() => {
        readyFiles.add(fileId);
        onShownRef.current();
        onReadyRef.current?.();
    }, [readyFiles, fileId]);
    useEffect(() => () => void readyFiles.delete(fileId), [readyFiles, fileId]);
    const onLeftRef = useRef(onLeft);
    onLeftRef.current = onLeft;
    useEffect(() => {
        if (!leaving) return;
        const t = setTimeout(() => onLeftRef.current(), 1500);
        return () => clearTimeout(t);
    }, [leaving]);
    // Deleted: the sound fades with the picture, then it stops.
    useEffect(() => {
        if (!gone) return;
        const videos = [...box.querySelectorAll("video")];
        const from = videos.map((v) => v.volume);
        const t0 = performance.now();
        let raf = 0;
        const step = () => {
            const k = Math.max(0, 1 - (performance.now() - t0) / GONE_MS);
            videos.forEach((v, i) => (v.volume = from[i] * k));
            if (k > 0) raf = requestAnimationFrame(step);
            else videos.forEach((v) => v.pause());
        };
        raf = requestAnimationFrame(step);
        const t = setTimeout(() => onLeftRef.current(), GONE_MS + 30);
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(t);
        };
    }, [gone, box]);
    const player =
        leaving || gone
            ? { ...spot.player, onClick: undefined, controlsRef: undefined, keyboardEnabled: false, onReady: undefined }
            : spot.player;
    // The box's own look, set on it directly (it isn't rendered by React).
    // Dimmed (its view in the background): the mouse goes past it.
    const inert = leaving || gone || (spot.fade?.opacity ?? 1) < 1;
    useLayoutEffect(() => {
        box.className = `${inert ? "pointer-events-none" : "pointer-events-auto"} ${player.className ?? ""}`;
        if (gone) box.dataset.layerGone = String(fileId);
        else delete box.dataset.layerGone;
        if (leaving) box.dataset.layerLeaving = String(fileId);
        else delete box.dataset.layerLeaving;
        if (leaving || gone) delete box.dataset.layerPlayer;
        else box.dataset.layerPlayer = String(fileId);
        // On top of the spot's new player while covering or fading.
        box.style.zIndex = leaving || gone ? "2" : "1";
        if (gone) {
            box.style.transition = `opacity ${GONE_MS}ms ease-out`;
            box.style.opacity = "0";
        }
    });
    return createPortal(<Player spot={{ ...spot, player }} onReady={leaving || gone ? undefined : ready} />, box);
}

/** A spot's overlay: above every player, pinned to the spot. */
function SpotOverlay({ spot }: { spot: Spot }): JSX.Element {
    const box = useRef<HTMLDivElement | null>(null);
    useFollow(spot.el, box);
    // Dimmed: its buttons ignore the mouse too (they'd sit over another view).
    const dimmed = (spot.fade?.opacity ?? 1) < 1;
    return (
        <div
            ref={box}
            data-spot-overlay
            className="pointer-events-none fixed"
            style={{ ...fadeStyle(spot.fade), zIndex: dimmed && !spot.overlayOnTop ? LAYER_Z.backgroundOverlay : LAYER_Z.activeOverlay }}
        >
            <div className={`relative h-full w-full ${dimmed ? "[&_*]:!pointer-events-none" : ""}`}>{spot.overlay}</div>
        </div>
    );
}

/**
 * Keeps the player's box in its spot. Coming from another spot (a newer claim
 * on its file, or the newer one letting go), it flies there if the spot asks
 * for it (arriveMs): the box floats above the app over the new spot. Inside
 * it, the picture is moved by a transform from where it was on screen,
 * easing to nothing (one smooth curve); the controls strip is moved by layout
 * from where it was to its place, on the same curve, so it's laid out right
 * (not scaled) all the way. Then it's put inside the spot. Nothing is
 * copied: it's the same element, still playing.
 */
function useFlight(spot: Spot, b: HTMLDivElement, float: MutableRefObject<HTMLDivElement | null>, gone: boolean): void {
    const lastSpot = useRef<number | null>(null);
    const stop = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        if (gone) {
            // Stays where it is (floating, if its spot is going).
            stop.current();
            return;
        }
        const prev = lastSpot.current;
        lastSpot.current = spot.id;
        const el = spot.el;
        const fl = float.current;
        if (!el || !fl) return;
        const ms = spot.arriveMs ?? 0;
        const flies = prev !== null && prev !== spot.id && b.isConnected && ms > 0;
        if (!flies) {
            // Mid-flight to this same spot: let it land.
            if (prev === spot.id && b.parentElement === fl) return;
            stop.current();
            seat(b, el);
            return;
        }
        const pictureEl = b.querySelector<HTMLElement>("[data-picture]");
        const root = pictureEl?.parentElement as HTMLElement | null;
        const hud = b.querySelector<HTMLElement>("[data-hud]");
        // Where it is now (over the old spot, or partway along a flight).
        const fromPic = pictureRect(b);
        const fromBar = hud?.getBoundingClientRect() ?? null;
        stop.current();
        // Float over the new spot.
        floatAt(b, fl);
        const r = el.getBoundingClientRect();
        Object.assign(b.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        const ease = `${ms}ms ${INSPECT_EASE}`;
        const cleanups: (() => void)[] = [];
        if (root) {
            const overflow = root.style.overflow;
            root.style.overflow = "visible"; // the picture starts outside the new box
            cleanups.push(() => (root.style.overflow = overflow));
        }
        const toPic = pictureRect(b);
        if (pictureEl && fromPic && toPic) {
            const f = flyTo(b.getBoundingClientRect(), toPic, fromPic);
            Object.assign(pictureEl.style, { transformOrigin: "0 0", transition: "none", transform: flightCss(f) });
            void pictureEl.offsetWidth;
            Object.assign(pictureEl.style, { transition: `transform ${ease}`, transform: "none" });
            cleanups.push(() => Object.assign(pictureEl.style, { transition: "", transform: "", transformOrigin: "" }));
        }
        const frame = hud?.parentElement;
        if (hud && frame && fromBar) {
            const fr = frame.getBoundingClientRect();
            Object.assign(hud.style, {
                transition: "none",
                left: `${fromBar.left - fr.left}px`,
                top: `${fromBar.top - fr.top}px`,
                width: `${fromBar.width}px`,
                height: `${fromBar.height}px`,
                right: "auto",
                bottom: "auto",
            });
            void hud.offsetWidth;
            Object.assign(hud.style, {
                transition: `left ${ease}, top ${ease}, width ${ease}, height ${ease}`,
                left: "0px",
                top: "0px",
                width: `${fr.width}px`,
                height: `${fr.height}px`,
            });
            cleanups.push(() => {
                for (const p of ["transition", "left", "top", "width", "height", "right", "bottom"] as const) hud.style[p] = "";
            });
        }
        // Landed: inside the spot.
        const t = setTimeout(() => {
            stop.current();
            if (spot.el?.isConnected) seat(b, spot.el);
        }, ms + 50);
        stop.current = () => {
            clearTimeout(t);
            cleanups.forEach((c) => c());
            stop.current = () => {};
        };
    }, [spot.id, spot.el, spot.arriveMs, b, float, gone]);
    useLayoutEffect(() => () => stop.current(), []);
}

/**
 * A place for a file's media. Renders an empty box (size it like any div);
 * the layer puts the file's player over it while this is the newest claim on
 * the file. `player`: how the player should behave while it's here.
 */
export function MediaSpot({
    file,
    player = {},
    overlay,
    fade,
    overlayOnTop,
    arriveMs,
    group,
    className,
    style,
}: {
    file: DbFile;
    player?: SpotPlayer;
    overlay?: ReactNode;
    fade?: SpotFade;
    /** Its overlay above every player even while dimmed. */
    overlayOnTop?: boolean;
    /** Fly here over this long when the player comes from another spot. */
    arriveMs?: number;
    /** Spots that change file together (see SpotState.group). */
    group?: string;
    className?: string;
    style?: CSSProperties;
}): JSX.Element {
    const api = useContext(LayerContext);
    if (!api) throw new Error("MediaSpot outside MediaLayerProvider");
    const ref = useRef<HTMLDivElement>(null);
    const id = useRef(0);
    if (id.current === 0) id.current = nextSpotId++;
    const state = (): SpotState => ({ file, el: ref.current, player, overlay, fade, overlayOnTop, arriveMs, group });
    // Claimed when it appears, let go when it goes.
    useLayoutEffect(() => {
        api.claim(id.current, state());
        return () => api.release(id.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api]);
    // Everything else (including another file here) passed on every render.
    useLayoutEffect(() => {
        api.update(id.current, state());
    });
    return <div ref={ref} data-media-spot={file.id} className={className} style={style} />;
}
