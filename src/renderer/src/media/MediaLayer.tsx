// The media layer: one player per file, owned here (app level) instead of by
// the views, and moved between places instead of copied.
//
// A view renders a <MediaSpot file=…/>: an empty box saying "this file goes
// here". The layer keeps the file's player exactly over that box. Several
// spots may claim the same file (a Compare card, then the file view opening
// on it): the newest claim gets the player; when it lets go, the player goes
// back to the one before. A spot without the player is just an empty box.
//
// Players live in the layer the whole time (fixed, over their spot), so a
// video is never torn down when it changes places.
//
// A spot can also carry:
// - an overlay: the view's own pieces that sit on top of the media (Compare's
//   focus line, rank, hover bar…), drawn above the player, pinned to the spot;
// - a fade: the player and overlay's opacity (a view dimming itself);
// - hidePlayer: the player hidden (still playing), its overlay not.
// When a spot changes file, the old player stays on top until the new one
// has something to show, so a swap never passes through black.

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
    hidePlayer?: boolean;
    /** When the player comes here from another spot (a newer claim, or the
     *  newer one letting go), it flies here over this long; 0: it just
     *  appears (the default). */
    arriveMs?: number;
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

/** A spot's old player, kept on top after it changed file until the new one is ready. */
interface Leaving {
    spotId: number;
    spot: Spot;
}

export function MediaLayerProvider({ children }: { children: ReactNode }): JSX.Element {
    const spots = useRef(new Map<number, Spot>());
    const leaving = useRef(new Map<number, Leaving>());
    const [, setTick] = useState(0);
    const changed = useCallback(() => setTick((t) => t + 1), []);
    const endLeaving = useCallback(
        (spotId: number) => {
            if (leaving.current.delete(spotId)) changed();
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
                if (s.file.id !== state.file.id) {
                    // Another file here: a new, newest claim; the old player
                    // covers until the new one is ready.
                    leaving.current.set(id, { spotId: id, spot: s });
                    spots.current.set(id, { ...state, id, order: nextOrder++ });
                } else {
                    spots.current.set(id, { ...s, ...state });
                }
                changed();
            },
            release: (id) => {
                const had = spots.current.delete(id);
                const covering = leaving.current.delete(id);
                if (had || covering) changed();
            },
        }),
        [changed],
    );

    // Each file's player goes to its newest claim. A spot's old file (it
    // changed file) keeps its player, the same one, on top until the new one
    // is ready: same key, so nothing is torn down.
    const shown = new Map<number, { spot: Spot; leavingFrom: number | null }>();
    for (const s of spots.current.values()) {
        const o = shown.get(s.file.id);
        if (!o || s.order > o.spot.order) shown.set(s.file.id, { spot: s, leavingFrom: null });
    }
    for (const l of leaving.current.values()) {
        if (!shown.has(l.spot.file.id)) shown.set(l.spot.file.id, { spot: l.spot, leavingFrom: l.spotId });
    }

    return (
        <LayerContext.Provider value={api}>
            {children}
            {/* Above the views (z-30); below dialogs (z-40+), toasts and the tag pointer's
                cursor. Lets the mouse through except over a player or an
                overlay's own controls. */}
            <div data-media-layer className="pointer-events-none fixed inset-0 z-30">
                {[...shown.entries()].map(([fileId, { spot, leavingFrom }]) => (
                    <LayerPlayer
                        key={fileId}
                        spot={spot}
                        leaving={leavingFrom !== null}
                        onShown={() => endLeaving(spot.id)}
                        onLeft={() => leavingFrom !== null && endLeaving(leavingFrom)}
                    />
                ))}
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

const fadeStyle = (fade: SpotFade | undefined, hidden = false): CSSProperties =>
    hidden
        ? { opacity: 0, transition: "none" }
        : { opacity: fade?.opacity ?? 1, transition: fade ? `opacity ${fade.ms}ms ease-out` : undefined };

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

/**
 * A file's player over its spot. `leaving`: its spot has moved on to another
 * file; it stays on top, not interactive, until the new one is ready (or a
 * moment has passed), then goes.
 */
function LayerPlayer({
    spot,
    leaving,
    onShown,
    onLeft,
}: {
    spot: Spot;
    leaving: boolean;
    onShown: () => void;
    onLeft: () => void;
}): JSX.Element {
    const box = useRef<HTMLDivElement | null>(null);
    // Before following the new spot: a player changing spots flies there.
    useFlight(spot, box);
    useFollow(spot.el, box);
    const onReadyRef = useRef(spot.player.onReady);
    onReadyRef.current = spot.player.onReady;
    const onShownRef = useRef(onShown);
    onShownRef.current = onShown;
    const ready = useCallback(() => {
        onShownRef.current();
        onReadyRef.current?.();
    }, []);
    const onLeftRef = useRef(onLeft);
    onLeftRef.current = onLeft;
    useEffect(() => {
        if (!leaving) return;
        const t = setTimeout(() => onLeftRef.current(), 1500);
        return () => clearTimeout(t);
    }, [leaving]);
    const player = leaving ? { ...spot.player, onClick: undefined, controlsRef: undefined } : spot.player;
    // Dimmed (its view in the background) or hidden: the mouse goes past it.
    const inert = leaving || spot.hidePlayer || (spot.fade?.opacity ?? 1) < 1;
    return (
        <div
            ref={box}
            data-layer-player={leaving ? undefined : spot.file.id}
            data-layer-leaving={leaving ? spot.file.id : undefined}
            className={`fixed ${inert ? "pointer-events-none" : "pointer-events-auto"} ${player.className ?? ""}`}
            style={{ ...fadeStyle(spot.fade, spot.hidePlayer), zIndex: leaving ? 1 : undefined }}
        >
            <Player spot={{ ...spot, player }} onReady={leaving ? undefined : ready} />
        </div>
    );
}

/** A spot's overlay: above every player, pinned to the spot. */
function SpotOverlay({ spot }: { spot: Spot }): JSX.Element {
    const box = useRef<HTMLDivElement | null>(null);
    useFollow(spot.el, box);
    // Dimmed: its buttons ignore the mouse too (they'd sit over another view).
    const dimmed = (spot.fade?.opacity ?? 1) < 1;
    return (
        <div ref={box} data-spot-overlay className="pointer-events-none fixed" style={fadeStyle(spot.fade)}>
            <div className={`relative h-full w-full ${dimmed ? "[&_*]:!pointer-events-none" : ""}`}>{spot.overlay}</div>
        </div>
    );
}

/**
 * A player changing spots (a newer claim on its file, or the newer one
 * letting go) flies to the new one, if that spot asks for it (arriveMs).
 * The player's box goes straight to the new spot. Inside it, the picture is
 * moved by a transform from where it was on screen, easing to nothing (one
 * smooth curve); the controls strip is moved by layout from where it was to
 * its place, on the same curve, so it's laid out right (not scaled) all the
 * way. Nothing is copied: it's the same element, still playing.
 */
function useFlight(spot: Spot, box: MutableRefObject<HTMLDivElement | null>): void {
    const lastSpot = useRef<number | null>(null);
    const stop = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        const prev = lastSpot.current;
        lastSpot.current = spot.id;
        const b = box.current;
        const el = spot.el;
        const ms = spot.arriveMs ?? 0;
        if (prev === null || prev === spot.id || !b || !el || ms <= 0) return;
        stop.current();
        const pictureEl = b.querySelector<HTMLElement>("[data-picture]");
        const root = pictureEl?.parentElement as HTMLElement | null;
        const hud = b.querySelector<HTMLElement>("[data-hud]");
        // Where it is now (still over the old spot).
        const fromPic = pictureRect(b);
        const fromBar = hud?.getBoundingClientRect() ?? null;
        // To the new spot.
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
        const t = setTimeout(() => stop.current(), ms + 50);
        stop.current = () => {
            clearTimeout(t);
            cleanups.forEach((c) => c());
            stop.current = () => {};
        };
    }, [spot.id, spot.el, spot.arriveMs, box]);
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
    hidePlayer,
    arriveMs,
    className,
    style,
}: {
    file: DbFile;
    player?: SpotPlayer;
    overlay?: ReactNode;
    fade?: SpotFade;
    hidePlayer?: boolean;
    /** Fly here over this long when the player comes from another spot. */
    arriveMs?: number;
    className?: string;
    style?: CSSProperties;
}): JSX.Element {
    const api = useContext(LayerContext);
    if (!api) throw new Error("MediaSpot outside MediaLayerProvider");
    const ref = useRef<HTMLDivElement>(null);
    const id = useRef(0);
    if (id.current === 0) id.current = nextSpotId++;
    const state = (): SpotState => ({ file, el: ref.current, player, overlay, fade, hidePlayer, arriveMs });
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
