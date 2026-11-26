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
// Step 1 (media-layer plan): the plumbing only. Nothing uses spots yet.

import {
    createContext,
    useCallback,
    useContext,
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
    onReady?: () => void;
    rotation?: number;
    seeThrough?: boolean;
    barFitsPicture?: boolean;
}

interface Spot {
    id: number;
    /** Claim order: the highest claim on a file has its player. */
    order: number;
    file: DbFile;
    el: HTMLElement | null;
    player: SpotPlayer;
}

interface LayerApi {
    claim: (spot: Omit<Spot, "order">) => void;
    update: (id: number, patch: Partial<Omit<Spot, "id" | "order">>) => void;
    release: (id: number) => void;
}

const LayerContext = createContext<LayerApi | null>(null);

let nextSpotId = 1;
let nextOrder = 1;

export function MediaLayerProvider({ children }: { children: ReactNode }): JSX.Element {
    const spots = useRef(new Map<number, Spot>());
    const [, setTick] = useState(0);
    const changed = useCallback(() => setTick((t) => t + 1), []);
    const api = useMemo<LayerApi>(
        () => ({
            claim: (s) => {
                spots.current.set(s.id, { ...s, order: nextOrder++ });
                changed();
            },
            update: (id, patch) => {
                const s = spots.current.get(id);
                if (!s) return;
                spots.current.set(id, { ...s, ...patch });
                changed();
            },
            release: (id) => {
                if (spots.current.delete(id)) changed();
            },
        }),
        [changed],
    );

    // Each file's player goes to its newest claim.
    const owners = new Map<number, Spot>();
    for (const s of spots.current.values()) {
        const o = owners.get(s.file.id);
        if (!o || s.order > o.order) owners.set(s.file.id, s);
    }

    return (
        <LayerContext.Provider value={api}>
            {children}
            {/* Above the views; below dialogs, toasts and the tag pointer's
                cursor. Lets the mouse through except over a player. */}
            <div data-media-layer className="pointer-events-none fixed inset-0 z-40">
                {[...owners.values()].map((s) => (
                    <LayerPlayer key={s.file.id} spot={s} />
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

function LayerPlayer({ spot }: { spot: Spot }): JSX.Element | null {
    const { rootPath } = useFolders();
    const box = useRef<HTMLDivElement | null>(null);
    useFollow(spot.el, box);
    if (!rootPath) return null;
    const p = spot.player;
    return (
        <div ref={box} data-layer-player={spot.file.id} className="pointer-events-auto fixed">
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
                onReady={p.onReady}
                rotation={p.rotation}
                seeThrough={p.seeThrough}
                barFitsPicture={p.barFitsPicture}
            />
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
    className,
    style,
}: {
    file: DbFile;
    player?: SpotPlayer;
    className?: string;
    style?: CSSProperties;
}): JSX.Element {
    const api = useContext(LayerContext);
    if (!api) throw new Error("MediaSpot outside MediaLayerProvider");
    const ref = useRef<HTMLDivElement>(null);
    const id = useRef(0);
    if (id.current === 0) id.current = nextSpotId++;
    // A claim per file: a new file (or a fresh mount) is a new, newest claim.
    useLayoutEffect(() => {
        api.claim({ id: id.current, file, el: ref.current, player });
        return () => api.release(id.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, file.id]);
    // Same file, fresh record or settings: passed on, claim order kept.
    useLayoutEffect(() => {
        api.update(id.current, { file, player });
    });
    return <div ref={ref} data-media-spot={file.id} className={className} style={style} />;
}
