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
    onReady?: () => void;
    rotation?: number;
    seeThrough?: boolean;
    barFitsPicture?: boolean;
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
    return (
        <div
            ref={box}
            data-layer-player={leaving ? undefined : spot.file.id}
            data-layer-leaving={leaving ? spot.file.id : undefined}
            className={leaving ? "pointer-events-none fixed" : "pointer-events-auto fixed"}
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
    return (
        <div ref={box} data-spot-overlay className="pointer-events-none fixed" style={fadeStyle(spot.fade)}>
            <div className="relative h-full w-full">{spot.overlay}</div>
        </div>
    );
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
    className,
    style,
}: {
    file: DbFile;
    player?: SpotPlayer;
    overlay?: ReactNode;
    fade?: SpotFade;
    hidePlayer?: boolean;
    className?: string;
    style?: CSSProperties;
}): JSX.Element {
    const api = useContext(LayerContext);
    if (!api) throw new Error("MediaSpot outside MediaLayerProvider");
    const ref = useRef<HTMLDivElement>(null);
    const id = useRef(0);
    if (id.current === 0) id.current = nextSpotId++;
    const state = (): SpotState => ({ file, el: ref.current, player, overlay, fade, hidePlayer });
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
