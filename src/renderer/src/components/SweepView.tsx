import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DbFile, DbTag, DbTagWithCategory, View } from "@renderer/shared/types/types";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useKingOfHill } from "@renderer/contexts/KingOfHillContext";
import { useFileTags } from "@renderer/hooks/useFileTags";
import { claimSpaceAndTab, isTyping } from "@renderer/lib/keys";
import {
    useTagPointer,
    useTagPointerSurface,
    type FlashKind,
    type PointerTarget,
} from "@renderer/contexts/TagPointerContext";
import { PointerLabel } from "./TagPointer";
import { isSideways } from "@renderer/lib/turn";
import { measureAspect, useLaneFullscreen } from "./lane";
import { MediaSpot } from "@renderer/media/MediaLayer";
import { Liftable } from "@renderer/media/Liftable";
import { INSPECT_MS, INSPECT_OUT_MS } from "@renderer/lib/inspect";
import { MediaFlash } from "./TagPointer";
import SingleFileView from "./SingleFileView";
import { TagPill } from "./TagPill";
import { ScopeSummary } from "./ScopeSummary";
import { usePass } from "@renderer/contexts/PassContext";
import { filterKey, pruneFilter } from "@renderer/lib/tagFilters";

// Sweep: tag one tag at a time, over files that don't have it yet. The tag
// can be picked at random and rerolled on an interval.
//
// One row scrolls steadily right to left, every file at full height (no
// black bars). The file under the pointer is the active one; the pointer
// follows the mouse over the strip. The tag is the app-wide tag pointer's
// (contexts/TagPointerContext): its keys (Space, Tab / T / right click, `,
// H) work the same here as everywhere; Sweep adds the strip's own.
//   Space  toggle the tag on the active file (or click any file)
//   1 / 3  the lanes' direction, 3 the forward key, 1 the reverse key:
//     the key of the way it's going: held, fast that way (back to the set
//     speed on letting go); paused: goes that way (held: fast, then the set
//     speed); the opposite key: pauses at once, and still held after a
//     moment, goes fast the other way (then the set speed that way)
//   2  pointer to the next lane (2–3 lanes), same height in it
//   Fast either way is 4× at once, climbing to 20×; so do the edges.
//   5 / 6  set speed down / up (or scroll)    `  new random tag
//   (4 is fast-forward on a focused video, app-wide: lib/fastForward)
//   Tab / right click / T  hold: the strip stops and the pointer grows,
//     with earlier tags stacked above it (smaller and smaller, 3 at a time):
//     Tab steps back through them, Shift+Tab forward again, Space (or a
//     click) picks one. Or type to search (suggestions below: Shift+Tab or ↓
//     step down, wrapping; Tab, Space, Enter or a click picks). Esc or right
//     click lets go.
//   + / −  add a lane below / remove the bottom one (1 to 3 lanes; the
//          pointer's lane is the one the keys act on)
//   G  open in file view    R  rotate left    K  to Compare (king)
//   X  hear every video on screen (mixed, no clipping) / just the pointer's
//   F  full screen (Esc leaves it)
//   H  hide the pointer and menus (the pointer does nothing until it's back)

const INTERVALS = [15, 30, 60, 120, 300];

export default function SweepView({
    active,
    setView,
    immersive,
    setImmersive,
}: {
    active: boolean;
    setView: (view: View) => void;
    /** Full screen: just Sweep, no sidebar (the app hides it). */
    immersive: boolean;
    setImmersive: (on: boolean) => void;
}): JSX.Element {
    const { rootPath, folderPrefixes } = useFolders();
    const { activeFilter, activeFilterKey } = useTags();
    const {
        sweepRandom,
        setSweepRandom,
        sweepInterval,
        setSweepInterval,
        sweepSpeed,
        setSweepSpeed,
        sweepSkipAnswered,
        toggleSweepSkipAnswered,
    } = useSettings();
    const { openLobby } = usePass();
    const { tag, reroll, pickingRef, hidden } = useTagPointer();
    const { crown } = useKingOfHill();

    const sweepTagId = tag?.id ?? null;
    // G: a file open in the file view over the sweep, as an inspection (as
    // over Compare and Pass): every lane stops at once, the sweep stays on
    // screen dimmed, and the tile's very player flies to the file view; on
    // closing it flies back and the lanes go on once it has landed.
    const [inspect, setInspect] = useState<{ file: DbFile; closing: boolean; shown: boolean } | null>(null);
    const openInspected = useCallback(
        (file: DbFile) => setInspect((i) => i ?? { file, closing: false, shown: false }),
        [],
    );

    // Latest filters for fetching, without re-creating the layout.
    // Skipping answered files: only files without a firm answer for the tag.
    // Off: every file.
    const poolTagId = sweepSkipAnswered ? sweepTagId : null;
    const filters = useRef({ folderPrefixes, activeFilter, tagId: poolTagId });
    filters.current = { folderPrefixes, activeFilter, tagId: poolTagId };

    // No file twice at once, in any lane (the sound doubled; no use for
    // tagging either). What every lane has loaded (on screen or not) and
    // what's on screen or about to be; what's been shown since the tag was
    // picked (not fetched again unless every file has been); and files just
    // fetched that a lane hasn't added yet.
    const visible = useRef<{ loaded: number[]; near: number[] }>({ loaded: [], near: [] });
    const setVisible = useCallback((v: { loaded: number[]; near: number[] }) => {
        visible.current = v;
        for (const id of v.loaded) reserved.current.delete(id);
    }, []);
    const seen = useRef(new Set<number>());
    const reserved = useRef(new Set<number>());
    useEffect(() => {
        seen.current = new Set(visible.current.loaded);
        reserved.current = new Set();
    }, [poolTagId, activeFilterKey]);

    // One fetch at a time across lanes, so two lanes can't get the same file.
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    const fetchFile = useCallback((): Promise<DbFile | null> => {
        const run = async (): Promise<DbFile | null> => {
            const { folderPrefixes, activeFilter, tagId } = filters.current;
            const loaded = [...visible.current.loaded, ...reserved.current];
            const get = (exclude: Iterable<number>) =>
                window.api.getRandomFile(folderPrefixes, activeFilter, [...new Set(exclude)], tagId);
            let file = await get([...seen.current, ...loaded]);
            // Seen them all: start over, still nothing that's loaded.
            if (!file && seen.current.size > 0) {
                seen.current = new Set(loaded);
                file = await get(loaded);
            }
            // Fewer files than the lanes hold: never a repeat (a file has one
            // player, so it can only be in one place). The lane ends on its
            // end card until a file is free again (dropped far behind in
            // another lane; it tries again every 2 s).
            if (file) {
                seen.current.add(file.id);
                reserved.current.add(file.id);
            }
            return file;
        };
        const p = queue.current.then(run, run);
        queue.current = p.catch(() => {});
        return p;
    }, []);

    // A new library starts fresh.
    useEffect(() => {
        visible.current = { loaded: [], near: [] };
        seen.current = new Set();
        reserved.current = new Set();
    }, [rootPath]);

    const toCompare = useCallback(
        (file: DbFile) => {
            crown(file);
            setView("compare");
        },
        [crown, setView],
    );

    // F: full screen (just the strip: no sidebar, no toolbar). It's the
    // window's own full screen, so Esc reaches us: Esc leaves it (unless the
    // pointer's hold is open; Esc lets go of that first). H (the pointer put
    // away, app-wide): content only, no pointer, toolbar or hints. Esc also
    // leaves the single file view.
    const contentOnly = hidden;
    const closeInspected = useCallback(() => setInspect((i) => (i && !i.closing ? { ...i, closing: true } : i)), []);
    const onInspectShown = useCallback(() => setInspect((i) => (i && !i.shown ? { ...i, shown: true } : i)), []);
    const onInspectClosed = useCallback(() => setInspect(null), []);
    const dimmed = !!inspect?.shown && !inspect.closing;
    const fadeMs = inspect?.closing ? INSPECT_OUT_MS : INSPECT_MS;
    // The strip's pieces on the media (the pointer) go above the flight
    // meanwhile, fading with the dim (see Liftable).
    const liftFade = inspect ? { opacity: dimmed ? 0 : 1, ms: fadeMs } : null;
    const { fullscreen } = useLaneFullscreen({
        active,
        immersive,
        setImmersive,
        pickingRef,
        inspected: !!inspect,
        closeInspected,
    });

    // The sweep stays mounted, on screen and still, under the file view;
    // its lanes go on again only once the player has landed back.
    const sweeping = active && !inspect;

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden bg-neutral-950">
            {inspect && (
                <div className="absolute inset-0 z-20 flex flex-col">
                    <SingleFileView
                        file={inspect.file}
                        active={active}
                        setView={setView}
                        onClose={closeInspected}
                        inspect={{ closing: inspect.closing, onClosed: onInspectClosed, onShown: onInspectShown }}
                    />
                </div>
            )}
            <div
                className="relative flex flex-1 flex-col overflow-hidden"
                style={{ opacity: dimmed ? 0.06 : 1, transition: `opacity ${fadeMs}ms ease-out` }}
            >
                {/* No toolbar in full screen: just the strip. */}
                {!contentOnly && !fullscreen && (
                    <SweepToolbar
                        tag={tag}
                        skipAnswered={sweepSkipAnswered}
                        onToggleSkipAnswered={toggleSweepSkipAnswered}
                        random={sweepRandom}
                        onToggleRandom={() => setSweepRandom(!sweepRandom)}
                        interval={sweepInterval}
                        onInterval={setSweepInterval}
                        onReroll={reroll}
                        speed={sweepSpeed}
                        onSpeed={setSweepSpeed}
                    />
                )}
                {rootPath && (
                    <SweepStrip
                        key={rootPath}
                        rootPath={rootPath}
                        active={sweeping}
                        tag={tag}
                        speed={sweepSpeed}
                        onSpeed={setSweepSpeed}
                        onInspect={openInspected}
                        inspectedId={inspect?.file.id ?? null}
                        liftFade={liftFade}
                        fetchFile={fetchFile}
                        setVisible={setVisible}
                        onCompare={toCompare}
                        contentOnly={contentOnly}
                        ending={{
                            skipAnswered: sweepSkipAnswered,
                            poolKey: `${poolTagId}:${activeFilterKey}:${JSON.stringify(folderPrefixes)}`,
                            onPassTag: tag
                                ? () => {
                                      setView("pass");
                                      openLobby([tag.id]);
                                  }
                                : null,
                        }}
                    />
                )}
            </div>
        </div>
    );
}

// ─── Strip ─────────────────────────────────────────────────────────────────
// One row moving at a steady speed. Files are height-matched, so each is as
// wide as its shape needs. New files are fetched as the row runs out in
// whichever direction it's going; ones far off the other end are dropped.

/** Where the pointer rests (fraction of the strip's width) when the mouse
 *  isn't over the strip. Over it, the pointer follows the mouse. */
const POINTER_AT = 0.4;
/** Keep this much (px) loaded beyond each edge (enough for fast forward). */
const BUFFER_PX = 2500;
/** Most files kept in the row (the rest are dropped from the far end). */
const MAX_ITEMS = 40;
/** Videos about to come on screen start playing this long (s) before they
 *  arrive at the lane's speed, so they're moving on arrival; a fixed
 *  distance meant 10+ s of off-screen playing at slow speeds. */
const PLAY_LEAD_S = 1;
/** …and at least this far (px) off screen (stopped or crawling). */
const PLAY_MARGIN_MIN_PX = 60;
/** The mouse near the edges fast-forwards (right) or rewinds (left), from
 *  the set speed where the zone starts up to BOOST_MAX ×, picking up faster
 *  the further in it goes. Fractions of the strip's width, from that edge:
 *  rewind starts 10% from the left edge and peaks at the edge; fast forward
 *  starts 40% from the right edge and peaks 8% from it. */
const EDGE_ZONE_LEFT = 0.1;
const EDGE_ZONE_RIGHT = 0.4;
const EDGE_FULL_RIGHT = 0.08;
/** Lanes stopped for a scrub pick up again this long after the last one
 *  (unless the setting keeps them stopped until 3). */
const SCRUB_RESUME_MS = 1000;
/** A scrub's stop: how fast lanes ease to a halt (higher = shorter slide). */
const SCRUB_STOP_EASE = 24;
/** Coverage: a file counts as on screen once this share of its width is
 *  showing. */
const CHECK_MIN_VISIBLE = 0.5;
/** Holding 3 jumps to BOOST_START × the set speed and climbs to BOOST_MAX ×
 *  within about a second. */
const BOOST_START = 4;
const BOOST_MAX = 20;
/** 5 / 6 change the set speed by this much (px/s), within these limits. */
const SPEED_STEP = 20;
const SPEED_MIN = 20;
const SPEED_MAX = 1000;

interface StripItem {
    key: number;
    file: DbFile;
    /** Width over height. */
    aspect: number;
}

/** A file's shape, from its thumbnail (every file has one). */
/** Most lanes (+ adds one below, − removes the bottom one). */
const MAX_LANES = 3;
/** With varispeed on, each lane's speed against the set speed (the top lane
 *  always runs at it). */
const LANE_SPEED_VARY = [1, 0.86, 1.14];

type LaneMotion = { dir: 1 | 0 | -1; boost: boolean };
const CRUISE: LaneMotion = { dir: 1, boost: false };
/** The opposite direction key held this long after its pause: fast the
 *  other way. */
const TURN_HOLD_MS = 200;
/** R holds the pointer's lane still until this long after the last press. */
const TURN_PAUSE_MS = 900;

/** What a lane hands the strip so it can update the lane's files. */
interface LaneHandle {
    replaceItemFile: (file: DbFile) => void;
    /** A file was deleted or moved away (anywhere): its tile goes. */
    removeItemPath: (relativePath: string) => void;
    /** A file was renamed or moved (Finder, the app, an undo): its tile
     *  follows, so a later delete still finds it. */
    renameItemPath: (oldRelativePath: string, relativePath: string) => void;
    /** A file came back (undoing its delete): back in its old spot, if
     *  that spot is still in the lane. */
    restoreItemPath: (relativePath: string, hash: string) => void;
}

function SweepStrip({
    rootPath,
    active,
    tag,
    speed,
    onSpeed,
    onInspect,
    inspectedId,
    liftFade,
    fetchFile,
    setVisible,
    onCompare,
    contentOnly,
    ending,
}: {
    /** The file open in the file view over the sweep (its tile's player is
     *  there and flies home on closing), or null. */
    inspectedId: number | null;
    /** A file view is up: the pointer sits above the flying player, at
     *  this opacity. */
    liftFade: { opacity: number; ms: number } | null;
    /** What a lane shows when it runs out of files. */
    ending: LaneEnding;
    rootPath: string;
    active: boolean;
    tag: DbTagWithCategory | null;
    /** H: just the files, no pointer or hints. The strip's keys still work;
     *  the pointer's don't (nothing is tagged or rerolled while it's away). */
    contentOnly: boolean;
    speed: number;
    onSpeed: (speed: number) => void;
    onInspect: (file: DbFile) => void;
    fetchFile: () => Promise<DbFile | null>;
    setVisible: (v: { loaded: number[]; near: number[] }) => void;
    onCompare: (file: DbFile) => void;
}): JSX.Element {
    const { sweepVarispeed, sweepAllLanes, sweepScrubHold, sweepAllAudio, toggleSweepAllAudio } = useSettings();
    const {
        picking,
        pickingRef,
        togglePicker,
        closePicker,
        checkTagId,
        addSeen,
        setTarget,
        clearTarget,
        toggleTagOn,
    } = useTagPointer();
    useTagPointerSurface(active);
    const boxRef = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ width: 0, height: 0 });

    // ── Lanes ────────────────────────────────────────────────────────────
    // 1 to 3 rows, each with its own random files; + adds one below, −
    // removes the bottom one (the top lane always stays). They split the
    // height equally. Each lane's motion: its direction and whether 1 / 3 is
    // held. 1 / 3 and the edge zones move the lane under the cursor (or
    // every lane, with the setting on).
    const [laneCount, setLaneCount] = useState(1);
    const laneCountRef = useRef(1);
    laneCountRef.current = laneCount;
    const [motion, setMotion] = useState<LaneMotion[]>(() => Array(MAX_LANES).fill(CRUISE));
    const motionRef = useRef(motion);
    motionRef.current = motion;
    const setLaneMotion = (lanes: number[], patch: Partial<LaneMotion>) =>
        setMotion((m) => m.map((x, i) => (lanes.includes(i) ? { ...x, ...patch } : x)));

    // ── Scrub pause ──────────────────────────────────────────────────────
    // Q / E on a video stop every lane: you're watching that one. They stop
    // quickly. Scrubbing stays on the video
    // the first press picked (the lock) until the mouse moves or the lanes
    // go again. With the setting on they stay stopped until 3. Otherwise
    // they pick up again SCRUB_RESUME_MS after the last scrub, as they were
    // (a rewind comes back as forward). Pressing 1 / 3, opening the
    // picker or leaving ends it: you've taken over.
    const scrubHoldRef = useRef(sweepScrubHold);
    scrubHoldRef.current = sweepScrubHold;
    // Lanes are stopped for a scrub (they ease to a halt fast).
    const scrubbingRef = useRef(false);
    // The tile key of the video being scrubbed: its player stays the
    // focused one (it answers Q / E) until the lock goes. State too, so the
    // tiles know.
    const scrubLock = useRef<number | null>(null);
    const [lockKey, setLockKey] = useState<number | null>(null);
    const setScrubLock = useCallback((key: number | null) => {
        scrubLock.current = key;
        setLockKey(key);
    }, []);
    const scrubResume = useRef<(1 | 0 | -1)[] | null>(null);
    const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearScrubTimer = () => {
        if (scrubTimer.current) clearTimeout(scrubTimer.current);
        scrubTimer.current = null;
        scrubResume.current = null;
    };
    const cancelScrubResume = useCallback(() => {
        clearScrubTimer();
        scrubbingRef.current = false;
        setScrubLock(null);
    }, [setScrubLock]);
    const pauseForScrub = () => {
        if (scrubHoldRef.current) {
            clearScrubTimer();
        } else {
            if (!scrubResume.current) {
                scrubResume.current = motionRef.current.map((m) => (m.dir === -1 ? 1 : m.dir));
            }
            if (scrubTimer.current) clearTimeout(scrubTimer.current);
            scrubTimer.current = setTimeout(() => {
                const resume = scrubResume.current;
                cancelScrubResume();
                if (resume) setMotion(resume.map((dir) => ({ dir, boost: false })));
            }, SCRUB_RESUME_MS);
        }
        scrubbingRef.current = true;
        setMotion((m) => m.map(() => ({ dir: 0, boost: false })));
    };
    useEffect(() => {
        if (!active) cancelScrubResume();
    }, [active, cancelScrubResume]);
    useEffect(() => cancelScrubResume, [cancelScrubResume]);
    // Per lane, read every frame: velocity (px/s), edge-zone depth, boost.
    const velocities = useRef<number[]>(Array(MAX_LANES).fill(0));
    const edgeDepths = useRef<number[]>(Array(MAX_LANES).fill(0));
    const edgeSides = useRef<("left" | "right" | null)[]>(Array(MAX_LANES).fill(null));
    const laneSpeed = (i: number) => (sweepVarispeed ? LANE_SPEED_VARY[i] : 1);
    const laneHandles = useRef<(LaneHandle | null)[]>(Array(MAX_LANES).fill(null));
    const registerLane = useCallback((i: number, h: LaneHandle | null) => {
        laneHandles.current[i] = h;
    }, []);
    // Each lane's file under the pointer (only the pointer's lane has one).
    const [activeByLane, setActiveByLane] = useState<(StripItem | undefined)[]>([]);
    const onLaneActive = useCallback((i: number, item: StripItem | undefined) => {
        setActiveByLane((prev) => {
            if (prev[i] === item) return prev;
            const next = [...prev];
            next[i] = item;
            return next;
        });
    }, []);
    // What every lane has loaded, and what's on screen (or about to be),
    // so no lane fetches a file another already has.
    const visibleByLane = useRef<{ loaded: number[]; near: number[] }[]>([]);
    const onLaneVisible = useCallback(
        (i: number, loaded: number[], near: number[]) => {
            visibleByLane.current[i] = { loaded, near };
            const lanes = visibleByLane.current.slice(0, laneCountRef.current).filter(Boolean);
            setVisible({
                loaded: lanes.flatMap((l) => l.loaded),
                near: lanes.flatMap((l) => l.near),
            });
        },
        [setVisible],
    );
    // Unique tile keys across lanes (flashes are keyed by them).
    const keyCounter = useRef(0);

    // The pointer: where the mouse is over the strip (null: resting), and
    // which lane it's in. 2 shifts it down a lane (wrapping to the top), at
    // the same height within the lane, for a parked mouse: the shift lasts
    // until the mouse really moves, then the pointer follows it again.
    // Resting, it sits at the top of the shifted lane.
    const mouseX = useRef<number | null>(null);
    const mouseY = useRef<number | null>(null);
    const laneOffset = useRef(0);
    // Last real mouse position (screen), to tell real movement from the
    // mousemove a browser fires when content changes under a still cursor.
    const lastScreen = useRef<{ x: number; y: number } | null>(null);
    const [pointerLane, setPointerLane] = useState(0);
    const pointerLaneRef = useRef(0);
    pointerLaneRef.current = pointerLane;
    const pointerRef = useRef<HTMLDivElement>(null);
    // Puts the pointer where the mouse (and the lane shift) says.
    const placePointer = (glide = false) => {
        const el = pointerRef.current;
        const boxEl = boxRef.current;
        if (!el || !boxEl) return;
        const n = laneCountRef.current;
        const laneH = boxEl.clientHeight / n;
        let lane: number;
        el.style.transition = glide
            ? "left 250ms ease-out, top 250ms ease-out, transform 250ms ease-out"
            : "none";
        if (mouseX.current == null || mouseY.current == null) {
            lane = laneOffset.current % n;
            el.style.left = `${POINTER_AT * 100}%`;
            el.style.top = `${lane * laneH}px`;
            el.style.transform = "translate(-50%, 0)";
        } else {
            const mouseLane = Math.max(0, Math.min(n - 1, Math.floor(mouseY.current / laneH)));
            lane = (mouseLane + laneOffset.current) % n;
            // The triangle's tip on that spot (kept low enough that the
            // label isn't cut off at the top).
            const y = lane * laneH + (mouseY.current - mouseLane * laneH);
            el.style.left = `${mouseX.current}px`;
            el.style.top = `${Math.max(y, el.offsetHeight)}px`;
            el.style.transform = "translate(-50%, -100%)";
        }
        if (lane !== pointerLaneRef.current) {
            pointerLaneRef.current = lane;
            setPointerLane(lane);
        }
    };
    const placePointerRef = useRef(placePointer);
    placePointerRef.current = placePointer;
    // Lifted above a flight or back (a new element each time): put where it
    // was, not at its rest spot.
    const lifted = liftFade != null;
    useLayoutEffect(() => {
        placePointerRef.current();
    }, [lifted]);
    // Fewer lanes: the shift wraps to fit, and the pointer follows.
    useEffect(() => {
        laneOffset.current %= laneCount;
        placePointerRef.current();
    }, [laneCount]);
    // A removed lane starts fresh if it's added again.
    useEffect(() => {
        for (let i = laneCount; i < MAX_LANES; i++) {
            velocities.current[i] = 0;
            edgeDepths.current[i] = 0;
            edgeSides.current[i] = null;
        }
        setMotion((m) => m.map((x, i) => (i < laneCount ? x : CRUISE)));
    }, [laneCount]);
    // The lanes 1 / 3 and the edge zones act on.
    const targetLanes = (): number[] =>
        sweepAllLanes
            ? Array.from({ length: laneCountRef.current }, (_, i) => i)
            : [pointerLaneRef.current];

    // Edge zones: lanes in one fast-forward or rewind, by how deep the mouse
    // is. Lanes leaving one go back to cruising (forward, after a rewind).
    const applyEdge = (side: "left" | "right" | null, depth: number, lanes: number[]) => {
        for (let i = 0; i < MAX_LANES; i++) {
            const mine = lanes.includes(i) ? side : null;
            edgeDepths.current[i] = mine ? depth : 0;
            const prev = edgeSides.current[i];
            if (prev === mine) continue;
            edgeSides.current[i] = mine;
            if (mine) setLaneMotion([i], { dir: mine === "left" ? -1 : 1 });
            else if (prev === "left") setLaneMotion([i], { dir: 1 });
        }
    };
    const applyEdgeRef = useRef(applyEdge);
    applyEdgeRef.current = applyEdge;

    useEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        // Hidden (the single file view is open over the sweep) measures
        // 0 × 0: keep the last real size, or the lanes rescale around the
        // pointer to nothing and come back at the far left of the row.
        const ro = new ResizeObserver(() => {
            if (el.clientWidth === 0 || el.clientHeight === 0) return;
            setBox({ width: el.clientWidth, height: el.clientHeight });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const laneHeight = laneCount > 0 ? box.height / laneCount : box.height;

    // Tag feedback on a file: a soft flash, `n` counting so each restarts.
    const [flashes, setFlashes] = useState<Record<number, { kind: "on" | "already" | "denied"; n: number }>>({});
    const flashCount = useRef(0);

    // The live set speed: scrolling changes it straight away (finer than the
    // rounded setting); the slider and 5 / 6 come in through `speed`. A new
    // speed takes effect at once in every cruising lane (no easing).
    const wheelSpeed = useRef(speed);
    const varispeedRef = useRef(sweepVarispeed);
    varispeedRef.current = sweepVarispeed;
    const applySpeed = useCallback((next: number) => {
        wheelSpeed.current = next;
        motionRef.current.forEach((m, i) => {
            if (!m.boost && edgeDepths.current[i] === 0 && m.dir !== 0) {
                velocities.current[i] = m.dir * next * (varispeedRef.current ? LANE_SPEED_VARY[i] : 1);
            }
        });
    }, []);
    useEffect(() => {
        if (Math.round(wheelSpeed.current) !== speed) applySpeed(speed);
    }, [speed, applySpeed]);

    // ── Picker ───────────────────────────────────────────────────────────
    // The tag pointer's picker (Tab, T or right click; see
    // TagPointerContext) stops every lane while it's open; closing it, they
    // carry on as they were (stopped stays stopped). Lanes paused for a
    // scrub stay paused under it, and come back from it as they were
    // before the scrub.
    const resumeMotion = useRef<(1 | 0 | -1)[] | null>(null);
    useEffect(() => {
        if (picking && active) {
            resumeMotion.current =
                scrubResume.current ?? motionRef.current.map((m) => (m.dir === -1 ? 1 : m.dir));
            cancelScrubResume();
            applyEdgeRef.current(null, 0, []);
            setMotion((m) => m.map(() => ({ dir: 0, boost: false })));
        } else if (!picking && resumeMotion.current) {
            const resume = resumeMotion.current;
            resumeMotion.current = null;
            setMotion(resume.map((dir) => ({ dir, boost: false })));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [picking]);

    // The pointer's lane's file under it: the one the keys act on.
    const activeItem = activeByLane[pointerLane];

    // ── Coverage: time seen ──────────────────────────────────────────────
    // While a tag is up, the lanes add up how long each file is on screen
    // while really being watched (see StripLane), and hand it to the tag
    // pointer (which applies the lean-back guard and saves it).
    // Goes up when the tag changes, so lanes start each file's trip mark over.
    const checkEpoch = useRef(0);
    const tagId = tag?.id;
    useEffect(() => {
        checkEpoch.current += 1;
    }, [tagId]);

    // ── Rotation (R) ─────────────────────────────────────────────────────
    // R adds a turn to the file's rotation setting at once (one undo entry;
    // the file itself is untouched): the media shows turned and the tile
    // takes its new shape straight away (its left edge stays, the files to
    // its right move).
    // A file's record changed (turned here or elsewhere, an undo, new
    // content): every lane showing it updates.
    const replaceItemFile = useCallback((file: DbFile) => {
        for (const h of laneHandles.current) h?.replaceItemFile(file);
    }, []);

    // Deleted (here, by a redo, in Finder): its tile leaves every lane.
    useEffect(
        () =>
            window.api.onMediaRemoved(({ relativePath }) => {
                for (const h of laneHandles.current) h?.removeItemPath(relativePath);
            }),
        [],
    );
    // Back again (its delete undone): the lane it left puts it back.
    useEffect(
        () =>
            window.api.onMediaAdded(({ relativePath, hash }) => {
                for (const h of laneHandles.current) h?.restoreItemPath(relativePath, hash);
            }),
        [],
    );
    // Renamed or moved: every lane showing it follows the new path.
    useEffect(
        () =>
            window.api.onMediaRenamed(({ oldRelativePath, relativePath }) => {
                for (const h of laneHandles.current) h?.renameItemPath(oldRelativePath, relativePath);
            }),
        [],
    );

    useEffect(() => {
        return window.api.onMediaUpdated(({ file }) => {
            if (file) replaceItemFile(file);
        });
    }, [replaceItemFile]);

    // Turning holds the pointer's lane still (at once): it goes again
    // TURN_PAUSE_MS after the last R, as it was.
    const [turningLane, setTurningLane] = useState<number | null>(null);
    const turnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (turnTimer.current) clearTimeout(turnTimer.current);
    }, []);
    const rotateLeft = useCallback(() => {
        const item = activeItem;
        if (!item) return;
        setTurningLane(pointerLaneRef.current);
        if (turnTimer.current) clearTimeout(turnTimer.current);
        turnTimer.current = setTimeout(() => setTurningLane(null), TURN_PAUSE_MS);
        window.api.turnFile(item.file.id).catch((err: unknown) => console.error("Rotate failed:", err));
    }, [activeItem]);

    const { tags } = useFileTags(activeItem?.file.id ?? null);
    const onFile = tag ? tags.find((t) => t.id === tag.id) : undefined;

    // Toggle the tag on a file (Space on the active one, through the tag
    // pointer; or a click on any), with a flash on its tile.
    const flashTile = useCallback((key: number, kind: FlashKind) => {
        const n = ++flashCount.current;
        setFlashes((f) => ({ ...f, [key]: { kind, n } }));
    }, []);
    const toggleOn = useCallback(
        async (item: StripItem) => {
            const kind = await toggleTagOn(item.file);
            if (kind) flashTile(item.key, kind);
        },
        [toggleTagOn, flashTile],
    );

    // The active file is the pointer's target: Space toggles it there.
    useEffect(() => {
        if (!active || !activeItem) return;
        const t: PointerTarget = {
            file: activeItem.file,
            ownPointer: true,
            onFlash: (kind) => flashTile(activeItem.key, kind),
            anchorY: () => pointerRef.current?.getBoundingClientRect().top ?? null,
        };
        setTarget(t);
        return () => clearTarget(t);
    }, [active, activeItem, setTarget, clearTarget, flashTile]);

    const rotateLeftRef = useRef(rotateLeft);
    rotateLeftRef.current = rotateLeft;
    const onTileClick = useCallback(
        (item: StripItem) => (pickingRef.current ? closePicker() : toggleOn(item)),
        [closePicker, toggleOn],
    );

    // Keys
    const state = useRef({ activeItem, speed });
    state.current = { activeItem, speed };
    // A held 1 / 3: the lanes it acts on (letting go affects the same ones),
    // and, for the opposite key, the moment its pause turns into going fast
    // the other way. Only presses the strip itself took (not the picker).
    const held = useRef<Record<"one" | "three", { lanes: number[]; timer: ReturnType<typeof setTimeout> | null; boosting: boolean } | null>>({
        one: null,
        three: null,
    });
    const pressDir = (key: "one" | "three", lanes: number[]) => {
        const dir: 1 | -1 = key === "three" ? 1 : -1;
        releaseDir(key);
        const h = { lanes, timer: null as ReturnType<typeof setTimeout> | null, boosting: false };
        held.current[key] = h;
        const now = motionRef.current;
        const opposite = lanes.filter((i) => (now[i] ?? CRUISE).dir === -dir);
        const others = lanes.filter((i) => !opposite.includes(i));
        // Going this way or paused: fast this way while held.
        if (others.length) {
            setLaneMotion(others, { dir, boost: true });
            h.boosting = true;
        }
        // Going the other way: pause at once; still held after a moment,
        // fast this way.
        if (opposite.length) {
            setLaneMotion(opposite, { dir: 0, boost: false });
            h.timer = setTimeout(() => {
                h.timer = null;
                if (held.current[key] !== h) return;
                setLaneMotion(opposite, { dir, boost: true });
                h.boosting = true;
            }, TURN_HOLD_MS);
        }
    };
    const releaseDir = (key: "one" | "three") => {
        const h = held.current[key];
        if (!h) return;
        held.current[key] = null;
        if (h.timer) clearTimeout(h.timer);
        // Back to the set speed, still going that way.
        if (h.boosting) setLaneMotion(h.lanes, { boost: false });
    };
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping() || pickingRef.current) return;
            const { activeItem, speed } = state.current;
            switch (e.code) {
                case "Digit5":
                case "Digit6":
                    e.preventDefault();
                    onSpeed(
                        Math.max(
                            SPEED_MIN,
                            Math.min(SPEED_MAX, speed + (e.code === "Digit6" ? SPEED_STEP : -SPEED_STEP)),
                        ),
                    );
                    break;
                case "KeyG":
                    e.preventDefault();
                    if (!e.repeat && activeItem) onInspect(activeItem.file);
                    break;
                case "Digit1":
                case "Digit3": {
                    // The lanes' direction (see the top): 3 forward, 1 reverse.
                    e.preventDefault();
                    if (e.repeat) return;
                    cancelScrubResume();
                    pressDir(e.code === "Digit3" ? "three" : "one", targetLanes());
                    break;
                }
                case "Digit2":
                    // The pointer down a lane (wrapping), same height in it.
                    e.preventDefault();
                    if (e.repeat || laneCountRef.current < 2) return;
                    laneOffset.current = (laneOffset.current + 1) % laneCountRef.current;
                    // Aimed somewhere else, like moving the mouse: the next
                    // scrub picks the video under the pointer again.
                    setScrubLock(null);
                    placePointerRef.current();
                    break;
                case "Equal":
                case "NumpadAdd":
                    // + : another lane below (up to 3).
                    e.preventDefault();
                    if (!e.repeat) setLaneCount((n) => Math.min(MAX_LANES, n + 1));
                    break;
                case "Minus":
                case "NumpadSubtract":
                    // − : drop the bottom lane (the top one always stays).
                    e.preventDefault();
                    if (!e.repeat) setLaneCount((n) => Math.max(1, n - 1));
                    break;
                case "KeyQ":
                case "KeyE":
                case "ArrowLeft":
                case "ArrowRight": {
                    // The active video's player steps it (its own keys, as
                    // everywhere); the lanes stop meanwhile (see Scrub pause).
                    e.preventDefault();
                    const key = scrubLock.current ?? (activeItem?.file.media_type === "video" ? activeItem.key : null);
                    if (key != null) {
                        setScrubLock(key);
                        pauseForScrub();
                    }
                    break;
                }
                case "KeyR":
                    e.preventDefault();
                    if (!e.repeat) rotateLeftRef.current();
                    break;
                case "KeyK":
                    e.preventDefault();
                    if (!e.repeat && activeItem) onCompare(activeItem.file);
                    break;
                case "KeyX":
                    // Every video on screen heard, or just the pointer's.
                    e.preventDefault();
                    if (!e.repeat) toggleSweepAllAudio();
                    break;
            }
        };
        // Letting go of 3 (or leaving the window, or the view) ends the
        // fast forward; it keeps going forward at the set speed. Letting go
        // of 1 also turns those lanes forward again.
        const onKeyUp = (e: KeyboardEvent) => {
            if (pickingRef.current) return;
            if (e.code === "Digit3") releaseDir("three");
            if (e.code === "Digit1") releaseDir("one");
        };
        // Leaving the window: no key is held any more; the lanes keep their
        // direction at the set speed.
        const stopBoost = () => {
            releaseDir("one");
            releaseDir("three");
            setMotion((m) => m.map((x) => ({ ...x, boost: false })));
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", stopBoost);
        const release = claimSpaceAndTab();
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", stopBoost);
            stopBoost();
            release();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, onCompare, onSpeed, onInspect, sweepAllLanes]);

    // The strip's mouse handling, as page listeners: the tiles' players are
    // rendered by the media layer, so React's events from them never reach
    // this box (the page's do: they're inside it). Fresh closures each render.
    const boxHandlers = useRef<{
        mousemove: (e: MouseEvent) => void;
        mouseleave: () => void;
        contextmenu: (e: MouseEvent) => void;
        wheel: (e: WheelEvent) => void;
    } | null>(null);
    boxHandlers.current = {
        mousemove: (e: MouseEvent) => {
                // The pointer holds still while the picker is open.
                if (pickingRef.current) return;
                const rect = boxRef.current!.getBoundingClientRect();
                const x = e.clientX - rect.left;
                // Really moved: a 2 shift ends and the pointer follows the
                // mouse again.
                const last = lastScreen.current;
                if (!last || last.x !== e.screenX || last.y !== e.screenY) {
                    laneOffset.current = 0;
                    // Aiming somewhere else: the next scrub picks again.
                    if (scrubLock.current != null) setScrubLock(null);
                }
                lastScreen.current = { x: e.screenX, y: e.screenY };
                mouseX.current = x;
                mouseY.current = e.clientY - rect.top;
                placePointer();
                const left = rect.width * EDGE_ZONE_LEFT;
                const right = rect.width * EDGE_ZONE_RIGHT;
                const full = rect.width * EDGE_FULL_RIGHT;
                const lanes = targetLanes();
                if (x < left) applyEdge("left", 1 - x / left, lanes);
                else if (x > rect.width - right)
                    applyEdge("right", Math.min(1, (x - (rect.width - right)) / (right - full)), lanes);
                else applyEdge(null, 0, []);
        },
        mouseleave: () => {
                if (pickingRef.current) return;
                mouseX.current = null;
                mouseY.current = null;
                lastScreen.current = null;
                applyEdge(null, 0, []);
                // Glide back to where it rests: the top of its (shifted) lane.
                placePointer(true);
        },
        contextmenu: (e: MouseEvent) => {
                // Right click: hold; again: let go.
                e.preventDefault();
                togglePicker();
        },
        wheel: (e: WheelEvent) => {
                // Scrolling (wheel or two fingers) sets the speed: up faster,
                // down slower. Proportional, so a trackpad's many small
                // steps and a wheel's big ones both feel right. Pinch
                // (ctrl + wheel) is left alone.
                if (e.ctrlKey) return;
                const next = wheelSpeed.current * Math.exp(-e.deltaY * 0.002);
                applySpeed(Math.max(SPEED_MIN, Math.min(SPEED_MAX, next)));
                onSpeed(Math.round(wheelSpeed.current));
                    },
    };
    useEffect(() => {
        const box = boxRef.current;
        if (!box) return;
        const on = {
            mousemove: (e: MouseEvent) => boxHandlers.current?.mousemove(e),
            mouseleave: () => boxHandlers.current?.mouseleave(),
            contextmenu: (e: MouseEvent) => boxHandlers.current?.contextmenu(e),
            wheel: (e: WheelEvent) => boxHandlers.current?.wheel(e),
        };
        box.addEventListener("mousemove", on.mousemove);
        box.addEventListener("mouseleave", on.mouseleave);
        box.addEventListener("contextmenu", on.contextmenu);
        box.addEventListener("wheel", on.wheel);
        return () => {
            box.removeEventListener("mousemove", on.mousemove);
            box.removeEventListener("mouseleave", on.mouseleave);
            box.removeEventListener("contextmenu", on.contextmenu);
            box.removeEventListener("wheel", on.wheel);
        };
    }, []);

    const pointerMotion = motion[pointerLane] ?? CRUISE;

    return (
        <div
            ref={boxRef}
            // The pointer stands in for the mouse here, so the cursor hides
            // (back while picking, to click a result).
            className={`relative min-h-0 flex-1 overflow-hidden bg-black select-none ${
                picking ? "" : "cursor-none"
            }`}
        >
            <div className="absolute inset-0 flex flex-col">
                {Array.from({ length: laneCount }, (_, i) => (
                    <StripLane
                        key={i}
                        index={i}
                        rootPath={rootPath}
                        active={active}
                        width={box.width}
                        height={laneHeight}
                        tag={tag}
                        fetchFile={fetchFile}
                        motion={motion[i] ?? CRUISE}
                        speedMult={laneSpeed(i)}
                        holdStill={turningLane === i}
                        wheelSpeed={wheelSpeed}
                        velocities={velocities}
                        edgeDepths={edgeDepths}
                        pickingRef={pickingRef}
                        scrubbingRef={scrubbingRef}
                        checkTagId={checkTagId}
                        checkEpoch={checkEpoch}
                        addSeen={addSeen}
                        isPointerLane={pointerLane === i}
                        mouseX={mouseX}
                        keyCounter={keyCounter}
                        flashes={flashes}
                        onTileClick={onTileClick}
                        lockKey={lockKey}
                        inspectedId={inspectedId}
                        onActive={onLaneActive}
                        onVisible={onLaneVisible}
                        register={registerLane}
                        ending={ending}
                    />
                ))}
            </div>

            {/* The pointer, with the tag it applies (above the player flying
                past while a file view is up) */}
            <Liftable over={boxRef} fade={liftFade}>
            <div
                ref={pointerRef}
                // w-max + nowrap: near an edge it runs off screen rather than wrap.
                className={`pointer-events-none absolute z-20 w-max flex-col items-center whitespace-nowrap ${
                    contentOnly && !picking ? "hidden" : "flex"
                }`}
                // Moved by the mouse handlers above; React only sets the rest spot.
                style={{ left: `${POINTER_AT * 100}%`, top: 0, transform: "translate(-50%, 0)" }}
            >
                <PointerLabel onFile={onFile} originTop={mouseX.current == null} />
            </div>
            </Liftable>

            {/* Direction / stopped (the pointer's lane), and the lanes */}
            <div
                className={`pointer-events-none absolute bottom-3 right-4 z-20 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-neutral-400 ${
                    contentOnly ? "hidden" : ""
                }`}
            >
                {pointerMotion.dir === 1 ? (pointerMotion.boost ? "▶▶" : "▶") : pointerMotion.dir === -1 ? "◀◀" : "❚❚"}{" "}
                {speed} px/s · 5 slower · 6 faster · {laneCount} lane{laneCount === 1 ? "" : "s"} (+ / −) ·{" "}
                {sweepAllAudio ? "all audio (X)" : "pointer's audio (X)"}
            </div>
        </div>
    );
}

// ─── Lane ──────────────────────────────────────────────────────────────────
// One row of the strip: its own files (fetched as it runs out in whichever
// direction it's going; ones far off the other end dropped), moving at its
// own velocity. Files are height-matched, so each is as wide as its shape
// needs. Only the pointer's lane has an active file.

function StripLane({
    index,
    rootPath,
    active,
    width,
    height,
    tag,
    fetchFile,
    motion,
    speedMult,
    holdStill,
    wheelSpeed,
    velocities,
    edgeDepths,
    pickingRef,
    scrubbingRef,
    checkTagId,
    checkEpoch,
    addSeen,
    isPointerLane,
    mouseX,
    keyCounter,
    flashes,
    onTileClick,
    lockKey,
    inspectedId,
    onActive,
    onVisible,
    register,
    ending,
}: {
    ending: LaneEnding;
    index: number;
    rootPath: string;
    active: boolean;
    width: number;
    height: number;
    tag: DbTagWithCategory | null;
    fetchFile: () => Promise<DbFile | null>;
    motion: LaneMotion;
    /** Varispeed: this lane's speed against the set speed. */
    speedMult: number;
    /** A file in it is being turned (R): held still. */
    holdStill: boolean;
    wheelSpeed: React.MutableRefObject<number>;
    velocities: React.MutableRefObject<number[]>;
    edgeDepths: React.MutableRefObject<number[]>;
    pickingRef: React.MutableRefObject<boolean>;
    /** Stopped for a scrub: stop fast. */
    scrubbingRef: React.MutableRefObject<boolean>;
    /** The tag time seen counts toward, or null while nothing counts. */
    checkTagId: React.MutableRefObject<number | null>;
    /** Changes with the tag: start every trip mark over. */
    checkEpoch: React.MutableRefObject<number>;
    addSeen: (fileId: number, seconds: number) => void;
    isPointerLane: boolean;
    mouseX: React.MutableRefObject<number | null>;
    keyCounter: React.MutableRefObject<number>;
    flashes: Record<number, { kind: "on" | "already" | "denied"; n: number }>;
    onTileClick: (item: StripItem) => void;
    /** A scrub's tile: its player stays the focused one meanwhile. */
    lockKey: number | null;
    /** The file open in the file view over the sweep, or null. */
    inspectedId: number | null;
    onActive: (lane: number, item: StripItem | undefined) => void;
    onVisible: (lane: number, loaded: number[], near: number[]) => void;
    register: (lane: number, handle: LaneHandle | null) => void;
}): JSX.Element {
    const rowRef = useRef<HTMLDivElement>(null);
    const [items, setItems] = useState<StripItem[]>([]);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    // The row's left edge, in px from the strip's left edge.
    const offset = useRef(0);
    const boostLevel = useRef(1);
    // Coverage: per tile on its current trip (by item key), the furthest
    // left its left edge has been. Only new ground counts, so a stretch
    // watched again after a rewind (or skipped by fast forward) doesn't.
    const tripMinX = useRef(new Map<number, number>());
    const tripEpoch = useRef(-1);
    const fetching = useRef(false);
    const [exhausted, setExhausted] = useState(false);
    // Out of files: the row ends on a card and stops there, until a file
    // turns up again (a new tag, the toggle, filters, or answers undone).
    const [ended, setEnded] = useState(false);
    const endedRef = useRef(false);
    endedRef.current = ended;
    // Width added or dropped on the left by the last change to `items`,
    // applied to the offset in the same paint so the picture doesn't jump.
    const pendingShift = useRef(0);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [playing, setPlaying] = useState<[number, number]>([0, -1]);
    // On screen (any part of it): only these are heard (X: all of them).
    const [onScreen, setOnScreen] = useState<[number, number]>([0, -1]);
    // Last values handed to React, so frames that change nothing don't render.
    const lastActive = useRef(-1);
    const lastPlaying = useRef<[number, number]>([0, -1]);
    const lastOnScreen = useRef<[number, number]>([0, -1]);
    const isPointerLaneRef = useRef(isPointerLane);
    isPointerLaneRef.current = isPointerLane;
    // The item last reported as active (a replaced file is a new object).
    const activeItemRef = useRef<StripItem | undefined>(undefined);

    // `aspect` is the media's own shape; the tile takes the turned one.
    const widthOf = useCallback(
        (item: StripItem) =>
            (isSideways(item.file.rotation) ? 1 / item.aspect : item.aspect) * height,
        [height],
    );
    // Deleted files' spots, by path, for an undo to put them back.
    const removedSpots = useRef(
        new Map<string, { item: StripItem; prevKey: number | null; nextKey: number | null }>(),
    );

    // A tile under the pointer changing shape (turned with R) keeps the
    // same spot of it under the pointer: while its width eases to the new
    // shape, the row is shifted by the change (see the animation).
    const turnAnchor = useRef<{ key: number; f: number; lastW: number; until: number } | null>(null);
    const replaceItemFile = useCallback((file: DbFile) => {
        const list = itemsRef.current;
        const at = list.findIndex((it) => it.file.id === file.id);
        if (at < 0) return;
        if (isSideways(file.rotation) !== isSideways(list[at].file.rotation)) {
            const left = offset.current + list.slice(0, at).reduce((w, it) => w + widthOf(it), 0);
            const w = widthOf(list[at]);
            const pointer = mouseX.current ?? width * POINTER_AT;
            if (pointer >= left && pointer < left + w) {
                turnAnchor.current = { key: list[at].key, f: (pointer - left) / w, lastW: w, until: performance.now() + 600 };
            }
        }
        const next = list.map((it) => (it.file.id === file.id ? { ...it, file } : it));
        itemsRef.current = next;
        setItems(next);
    }, [widthOf, width]);
    // A removed file's tile goes. Tiles left of the pointer stay put (the
    // row shifts to make up for it); one under or right of the pointer
    // closes up, so the next tile takes its place.
    const removeItemPath = useCallback(
        (relativePath: string) => {
            const list = itemsRef.current;
            const at = list.findIndex((it) => it.file.path === relativePath);
            if (at < 0) return;
            const left = offset.current + list.slice(0, at).reduce((w, it) => w + widthOf(it), 0);
            const pointer = mouseX.current ?? width * POINTER_AT;
            if (left + widthOf(list[at]) <= pointer) pendingShift.current += widthOf(list[at]);
            // Remember its spot (the tile before it; the one after, if it
            // was first) in case an undo brings it back.
            removedSpots.current.set(relativePath, {
                item: list[at],
                prevKey: at > 0 ? list[at - 1].key : null,
                nextKey: at < list.length - 1 ? list[at + 1].key : null,
            });
            // Only the latest few hundred are kept (the rest are long gone).
            while (removedSpots.current.size > 300) {
                removedSpots.current.delete(removedSpots.current.keys().next().value!);
            }
            const next = list.filter((_, i) => i !== at);
            itemsRef.current = next;
            setItems(next);
        },
        [widthOf, width, mouseX],
    );
    const renameItemPath = useCallback((oldRelativePath: string, relativePath: string) => {
        if (!itemsRef.current.some((it) => it.file.path === oldRelativePath)) return;
        const filename = relativePath.split("/").pop() ?? relativePath;
        const next = itemsRef.current.map((it) =>
            it.file.path === oldRelativePath ? { ...it, file: { ...it.file, path: relativePath, filename } } : it,
        );
        itemsRef.current = next;
        setItems(next);
    }, []);
    // A deleted file coming back (undo) goes back between the same
    // neighbours, with the same rule as a delete: a spot fully left of the
    // pointer pushes the tiles left of it further left; otherwise the ones
    // right of it move right. If its spot has left the lane (the tile
    // before it was dropped off the left end, or the row's start moved on),
    // it isn't put back anywhere.
    // Several files deleted together come back together, maybe in any
    // order: one whose neighbour is also on its way back waits for it (it
    // keeps its old key, so the files next to it still find it).
    const waitingRestores = useRef(new Set<string>());
    const restoreItemPath = useCallback(
        (relativePath: string, hash: string) => {
            const spot = removedSpots.current.get(relativePath);
            if (!spot || spot.item.file.content_hash !== hash) return;
            waitingRestores.current.add(relativePath);
            // Try every waiting file until none can go in.
            let list = itemsRef.current;
            let changed = false;
            let progress = true;
            while (progress) {
                progress = false;
                for (const path of [...waitingRestores.current]) {
                    const s = removedSpots.current.get(path)!;
                    const done = () => {
                        waitingRestores.current.delete(path);
                        removedSpots.current.delete(path);
                    };
                    if (list.some((it) => it.file.id === s.item.file.id)) {
                        done();
                        continue;
                    }
                    let at = -1;
                    if (s.prevKey !== null) {
                        at = list.findIndex((it) => it.key === s.prevKey);
                        if (at >= 0) at += 1;
                    } else if (s.nextKey !== null && list[0]?.key === s.nextKey) {
                        // It was first in the row: only if the row still
                        // starts with the tile that followed it.
                        at = 0;
                    }
                    if (at < 0) {
                        // Its neighbour is coming back too: wait for it.
                        // Otherwise its spot has left the lane.
                        const anchor = s.prevKey ?? s.nextKey;
                        const waitFor = [...removedSpots.current.entries()].some(
                            ([p, o]) => p !== path && o.item.key === anchor,
                        );
                        if (!waitFor) done();
                        continue;
                    }
                    // (Plus any shift not painted yet: earlier ones in this batch.)
                    const left =
                        offset.current +
                        pendingShift.current +
                        list.slice(0, at).reduce((w, it) => w + widthOf(it), 0);
                    const pointer = mouseX.current ?? width * POINTER_AT;
                    if (left + widthOf(s.item) <= pointer) pendingShift.current -= widthOf(s.item);
                    list = [...list.slice(0, at), s.item, ...list.slice(at)];
                    done();
                    changed = true;
                    progress = true;
                }
            }
            if (!changed) return;
            itemsRef.current = list;
            setItems(list);
        },
        [widthOf, width, mouseX],
    );
    useEffect(() => {
        register(index, { replaceItemFile, removeItemPath, renameItemPath, restoreItemPath });
        return () => register(index, null);
    }, [register, index, replaceItemFile, removeItemPath, renameItemPath, restoreItemPath]);

    // A tile's real shape once loaded (the media's own, unturned), if the
    // thumbnail's was off (or the file changed since).
    const onShape = useCallback(
        (key: number, aspect: number) => {
            const item = itemsRef.current.find((it) => it.key === key);
            if (!item) return;
            if (Math.abs(aspect - item.aspect) / item.aspect < 0.02) return;
            const next = itemsRef.current.map((it) => (it.key === key ? { ...it, aspect } : it));
            itemsRef.current = next;
            setItems(next);
        },
        [],
    );

    const makeItem = useCallback(async (): Promise<StripItem | null> => {
        const file = await fetchFile();
        if (!file) return null;
        return { key: keyCounter.current++, file, aspect: await measureAspect(file) };
    }, [fetchFile, keyCounter]);

    // Fill the row ahead, behind it when going backwards, and drop what's
    // far off the other end. Only this changes `items`, one fetch at a time.
    const topUp = useCallback(async () => {
        if (fetching.current || exhausted || height === 0) return;
        const total = itemsRef.current.reduce((w, it) => w + widthOf(it), 0);
        const goingBack = velocities.current[index] < 0;
        const needRight = !goingBack && offset.current + total < width + BUFFER_PX;
        const needLeft = goingBack && offset.current > -BUFFER_PX;
        if (!needRight && !needLeft) return;

        fetching.current = true;
        const item = await makeItem();
        fetching.current = false;
        if (!item) {
            setExhausted(true);
            setEnded(true);
            return;
        }
        setEnded(false);
        let next = itemsRef.current;
        let shift = 0;
        if (needRight) {
            next = [...next, item];
            while (next.length > MAX_ITEMS) {
                shift += widthOf(next[0]);
                next = next.slice(1);
            }
        } else {
            next = [item, ...next];
            shift -= widthOf(item);
            while (next.length > MAX_ITEMS) next = next.slice(0, -1);
        }
        pendingShift.current += shift;
        itemsRef.current = next;
        setItems(next);
    }, [width, height, exhausted, makeItem, widthOf, velocities, index]);

    useLayoutEffect(() => {
        if (pendingShift.current === 0) return;
        offset.current += pendingShift.current;
        pendingShift.current = 0;
        if (rowRef.current) rowRef.current.style.transform = `translateX(${offset.current}px)`;
        // Tiles that left the row: their trips are over.
        const keys = new Set(items.map((it) => it.key));
        for (const key of tripMinX.current.keys()) {
            if (!keys.has(key)) tripMinX.current.delete(key);
        }
    }, [items]);

    // The lane changed size (full screen, the window, lanes added or
    // removed): tiles are as wide as the lane is tall, so they all scale.
    // Scale the row around the pointer's resting spot, so what was on
    // screen stays there (instead of stretching away from the row's far-off
    // left edge and landing somewhere back in the queue).
    const lastSize = useRef({ width, height });
    useLayoutEffect(() => {
        const prev = lastSize.current;
        lastSize.current = { width, height };
        if (prev.height <= 0 || prev.width <= 0) return;
        if (prev.height === height && prev.width === width) return;
        const k = height / prev.height;
        const anchorOld = prev.width * POINTER_AT;
        const anchorNew = width * POINTER_AT;
        offset.current = anchorNew - (anchorOld - offset.current) * k;
        if (rowRef.current) rowRef.current.style.transform = `translateX(${offset.current}px)`;
        // Coverage's furthest-left marks were in the old scale: start over.
        tripMinX.current.clear();
    }, [width, height]);

    // A new tag (or the toggle, or filters) can bring files back, and so
    // can waiting.
    useEffect(() => {
        setExhausted(false);
        setEnded(false);
    }, [tag?.id, ending.poolKey]);
    useEffect(() => {
        if (!exhausted) return;
        const t = setTimeout(() => setExhausted(false), 2000);
        return () => clearTimeout(t);
    }, [exhausted]);

    // Everything loaded here (and what's near the screen) is kept from
    // being fetched by any lane again.
    useEffect(() => {
        onVisible(
            index,
            items.map((it) => it.file.id),
            items.slice(playing[0], playing[1] + 1).map((it) => it.file.id),
        );
    }, [items, playing, onVisible, index]);
    useEffect(() => () => onVisible(index, [], []), [onVisible, index]);

    // Not the pointer's lane (any more): no active file.
    useEffect(() => {
        if (!isPointerLane) {
            lastActive.current = -1;
            setActiveIndex(-1);
            onActive(index, undefined);
        }
    }, [isPointerLane, onActive, index]);
    useEffect(() => () => onActive(index, undefined), [onActive, index]);

    // The animation: move, find the file under the pointer (in the pointer's
    // lane), keep the row topped up. Positions go straight to the DOM; React
    // only hears about changes to the active file and the playing range.
    useEffect(() => {
        if (!active) return;
        let raf = 0;
        let last = performance.now();
        const frame = (now: number) => {
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            // Held 1 / 3 jumps ahead and climbs toward the max; let go,
            // straight back. In an edge zone, speed follows how deep the
            // mouse is (squared: gentle at first, steep near the edge).
            const depth = edgeDepths.current[index];
            if (motion.boost) {
                boostLevel.current = Math.max(boostLevel.current, BOOST_START);
                boostLevel.current += (BOOST_MAX - boostLevel.current) * Math.min(1, dt * 3);
            } else if (depth > 0) {
                boostLevel.current = 1 + (BOOST_MAX - 1) * depth * depth;
            } else {
                boostLevel.current = 1;
            }
            const cruise = wheelSpeed.current * speedMult;
            const target = holdStill ? 0 : motion.dir * cruise * boostLevel.current;
            const v = velocities.current[index];
            const scrubbing = scrubbingRef.current;
            // Snappy into and out of fast forward; gentle for everything else.
            // A scrub stops it quickest, so it hardly slides.
            const ease = scrubbing
                ? SCRUB_STOP_EASE
                : motion.boost || depth > 0 || pickingRef.current || Math.abs(v) > cruise * 1.5
                  ? 12
                  : 4;
            // Stopping, starting and turning round happen at once (no
            // ease); speed changes in one direction still ease.
            velocities.current[index] =
                target === 0 || v === 0 || Math.sign(target) !== Math.sign(v)
                    ? target
                    : v + (target - v) * Math.min(1, dt * ease);
            offset.current -= velocities.current[index] * dt;
            // Ended: the row can't run past its end card (it stops with the
            // card at the right edge).
            if (endedRef.current) {
                const total = itemsRef.current.reduce((w, it) => w + widthOf(it), 0) + Math.min(height, width);
                offset.current = Math.max(offset.current, Math.min(0, width - total));
            }
            // A turned tile under the pointer: shift by its width's change so
            // far (its left edge stays, so the spot under the pointer would
            // otherwise slide off).
            const anchor = turnAnchor.current;
            if (anchor) {
                const el = rowRef.current?.querySelector<HTMLElement>(`[data-tile-key="${anchor.key}"]`);
                if (!el || now > anchor.until) turnAnchor.current = null;
                else {
                    const w = el.getBoundingClientRect().width;
                    offset.current += anchor.f * (anchor.lastW - w);
                    anchor.lastW = w;
                }
            }
            if (rowRef.current) rowRef.current.style.transform = `translateX(${offset.current}px)`;

            const list = itemsRef.current;
            const pointer = mouseX.current ?? width * POINTER_AT;
            // Time seen counts only going forward at the lane's own speed:
            // not stopped, rewinding, fast-forwarding, scrubbing or turning
            // a file, and only with the window in front.
            if (tripEpoch.current !== checkEpoch.current) {
                tripEpoch.current = checkEpoch.current;
                tripMinX.current.clear();
            }
            const counting =
                checkTagId.current != null &&
                motion.dir === 1 &&
                !motion.boost &&
                depth === 0 &&
                !scrubbing &&
                !holdStill &&
                velocities.current[index] > 0 &&
                document.hasFocus();
            const marks = tripMinX.current;
            let x = offset.current;
            let under = -1;
            let first = list.length;
            let lastIdx = -1;
            let firstSeen = list.length;
            let lastSeen = -1;
            const margin = Math.max(PLAY_MARGIN_MIN_PX, Math.abs(velocities.current[index]) * PLAY_LEAD_S);
            list.forEach((it, i) => {
                const w = widthOf(it);
                const mark = marks.get(it.key);
                if (mark === undefined || x < mark) {
                    marks.set(it.key, x);
                    const shown = Math.min(x + w, width) - Math.max(x, 0);
                    if (counting && mark !== undefined && shown >= w * CHECK_MIN_VISIBLE) {
                        addSeen(it.file.id, dt);
                    }
                }
                if (pointer >= x && pointer < x + w) under = i;
                if (x + w > -margin && x < width + margin) {
                    first = Math.min(first, i);
                    lastIdx = i;
                }
                if (x + w > 0 && x < width) {
                    firstSeen = Math.min(firstSeen, i);
                    lastSeen = i;
                }
                x += w;
            });
            if (!isPointerLaneRef.current) under = -1;
            if (lastActive.current !== under || (under >= 0 && list[under] !== undefined && activeItemRef.current !== list[under])) {
                lastActive.current = under;
                activeItemRef.current = under >= 0 ? list[under] : undefined;
                setActiveIndex(under);
                onActive(index, activeItemRef.current);
            }
            const p = lastPlaying.current;
            if (p[0] !== first || p[1] !== lastIdx) {
                lastPlaying.current = [first, lastIdx];
                setPlaying([first, lastIdx]);
            }
            const o = lastOnScreen.current;
            if (o[0] !== firstSeen || o[1] !== lastSeen) {
                lastOnScreen.current = [firstSeen, lastSeen];
                setOnScreen([firstSeen, lastSeen]);
            }
            topUp();
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, motion.dir, motion.boost, holdStill, speedMult, width, widthOf, topUp]);

    return (
        <div className="relative min-h-0 flex-1 overflow-hidden">
            <div ref={rowRef} className="absolute inset-y-0 left-0 flex will-change-transform">
                {items.map((it, i) => (
                    <StripTile
                        key={it.key}
                        item={it}
                        width={widthOf(it)}
                        rootPath={rootPath}
                        isActive={isPointerLane && i === activeIndex}
                        focused={active && (lockKey != null ? lockKey === it.key : isPointerLane && i === activeIndex)}
                        inspected={inspectedId === it.file.id}
                        returning={inspectedId != null}
                        play={active && i >= playing[0] && i <= playing[1]}
                        seen={active && i >= onScreen[0] && i <= onScreen[1]}
                        flash={flashes[it.key]}
                        height={height}
                        onShape={onShape}
                        onClick={() => onTileClick(it)}
                    />
                ))}
                {/* Square, but never wider than the lane: in a narrow window
                    it fills the lane, its text centred in it. */}
                {ended && <LaneEndCard size={Math.min(height, width)} tag={tag} ending={ending} />}
            </div>
            {items.length === 0 && !ended && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
                    Loading…
                </div>
            )}
        </div>
    );
}

/** What a lane shows when it runs out of files. */
interface LaneEnding {
    skipAnswered: boolean;
    /** Changes when the pool might have files again. */
    poolKey: string;
    /** Opens the Pass lobby with the tag (null: no tag). */
    onPassTag: (() => void) | null;
}

/** The end of a lane that ran out: a square tile after its last file. */
function LaneEndCard({
    size,
    tag,
    ending,
}: {
    size: number;
    tag: DbTagWithCategory | null;
    ending: LaneEnding;
}): JSX.Element {
    const { activeFilter, loadedFeed, filter } = useTags();
    const { folderPrefixes } = useFolders();
    const feedName =
        loadedFeed && filterKey(loadedFeed.tree) === filterKey(filter) ? loadedFeed.name : null;
    const firm = ending.skipAnswered && tag;
    // Say plainly what's narrowing the pool: collections and the tag
    // filter both count, and either can be why it ran out.
    const someCollections = !!folderPrefixes;
    const filtered = !!pruneFilter(activeFilter);
    const limits = [someCollections && "collections", filtered && "tag filter"].filter(Boolean);
    return (
        <div
            className="relative flex h-full shrink-0 flex-col items-center justify-center gap-3 overflow-y-auto bg-neutral-900 p-5 text-center"
            style={{ width: size }}
        >
            {tag && <TagPill tag={tag} applied />}
            <span className="text-sm text-neutral-200">
                {folderPrefixes?.length === 0
                    ? "No collections selected"
                    : (firm ? "Nothing left without a firm answer" : "No more files") +
                      (limits.length > 0 ? ` in the selected ${limits.join(" and ")}` : "")}
            </span>
            <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                    {limits.length > 0 ? "Limited to" : "Looking at"}
                </span>
                <ScopeSummary folderPrefixes={folderPrefixes} filter={activeFilter} feedName={feedName} />
                {!filtered && <span className="text-[11px] text-neutral-500">No tag filter</span>}
            </div>
            <span className="text-[11px] text-neutral-500">Tab another tag · ` random</span>
            {firm && ending.onPassTag && (
                <button
                    onClick={ending.onPassTag}
                    className="rounded bg-neutral-200 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
                >
                    Pass this tag
                </button>
            )}
        </div>
    );
}

function StripTile({
    item,
    width,
    isActive,
    focused,
    inspected,
    returning,
    play,
    seen,
    flash,
    height,
    onShape,
    onClick,
}: {
    item: StripItem;
    width: number;
    height: number;
    /** Reports the media's real shape (width / height) once loaded. */
    onShape: (key: number, aspect: number) => void;
    rootPath: string;
    isActive: boolean;
    /** Its player answers the playback keys and shows its bar: the
     *  pointer's file (or the one being scrubbed). */
    focused: boolean;
    /** Open in the file view over the sweep: its player is there (and
     *  keeps playing while it flies home). */
    inspected: boolean;
    /** A file view is up: the inspected file's player flies home on closing. */
    returning: boolean;
    /** On screen or about to be: videos play; otherwise they're paused. */
    play: boolean;
    /** Some of it on screen: with X, heard. */
    seen: boolean;
    /** The tag was just added ("on"), was already on and a second press
     *  will remove it ("already"), or couldn't be changed ("denied"). */
    flash?: { kind: "on" | "already" | "denied"; n: number };
    onClick: () => void;
}): JSX.Element {
    // Heard: the pointer's file, or (X) every video with any part on screen
    // (not the ones still off screen getting a head start).
    const { sweepAllAudio } = useSettings();
    const audible = isActive || (sweepAllAudio && seen);

    // The lane's height changed this render (see the width transition).
    // The ref only moves after commit, so a double render agrees.
    const lastHeight = useRef(height);
    const resized = lastHeight.current !== height;
    useLayoutEffect(() => {
        lastHeight.current = height;
    }, [height]);

    return (
        <div
            data-tile-key={item.key}
            className="relative h-full shrink-0 overflow-hidden"
            // A new shape (R) eases in: the left edge stays and the files to
            // the right slide along. (The turn itself snaps.) A lane resize
            // (H, F, the window, + / −) snaps too: the row's offset is
            // rescaled at once, so easing the widths would throw the row off
            // and slide it back.
            style={{ width, transition: resized ? "none" : "width 150ms ease-out" }}
            onClick={onClick}
        >
            {/* A spot: the file's one player (media layer), moving with the
                lane, flown to the file view and back on G. Its clicks come
                through the player (React events from it don't reach here). */}
            <MediaSpot
                file={item.file}
                className="absolute inset-0"
                arriveMs={returning && inspected ? INSPECT_OUT_MS : 0}
                player={{
                    disabled: !(play || inspected),
                    muted: !audible,
                    focused,
                    clickToPauseEnabled: false,
                    keyboardEnabled: false,
                    rotation: item.file.rotation,
                    onAspect: (aspect) => onShape(item.key, aspect),
                    onClick,
                }}
            />
            {/* Tag feedback on the tile's top and bottom edges. */}
            <MediaFlash flash={flash ?? null} />
        </div>
    );
}

// ─── Toolbar ───────────────────────────────────────────────────────────────
// The tag (picked on the pointer: Tab, right click or T), random rerolls and
// the scroll speed.

function SweepToolbar({
    tag,
    skipAnswered,
    onToggleSkipAnswered,
    random,
    onToggleRandom,
    interval,
    onInterval,
    onReroll,
    speed,
    onSpeed,
}: {
    tag: DbTagWithCategory | null;
    skipAnswered: boolean;
    onToggleSkipAnswered: () => void;
    random: boolean;
    onToggleRandom: () => void;
    interval: number;
    onInterval: (seconds: number) => void;
    onReroll: () => void;
    speed: number;
    onSpeed: (speed: number) => void;
}): JSX.Element {
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
            <span className="text-neutral-500">Sweeping for</span>
            <span
                className={`rounded-full px-2.5 py-0.5 font-medium ${
                    tag ? "bg-neutral-200 text-neutral-900" : "bg-neutral-800 text-neutral-500"
                }`}
            >
                {tag?.category && (
                    <span className="mr-1 rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none" style={{ color: tag.category.color }}>
                        {tag.category.icon}
                    </span>
                )}
                {tag?.name ?? "pick a tag (Tab)"}
            </span>

            <button
                onClick={(e) => {
                    onToggleSkipAnswered();
                    e.currentTarget.blur();
                }}
                title={
                    skipAnswered
                        ? "Skipping files already answered for this tag (tagged, or a firm no). Click to show every file."
                        : "Showing every file, answered or not. Click to skip files already answered for this tag."
                }
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    skipAnswered
                        ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                        : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                }`}
            >
                {skipAnswered ? "Skipping answered" : "Showing everything"}
            </button>

            <div className="flex items-center gap-2">
                <button
                    onClick={onToggleRandom}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        random
                            ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                            : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                    }`}
                >
                    Random {random ? "on" : "off"}
                </button>
                {random && (
                    <>
                        <select
                            value={interval}
                            onChange={(e) => {
                                onInterval(Number(e.target.value));
                                // Back to the keys (Space would reopen it).
                                e.currentTarget.blur();
                            }}
                            className="rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-xs text-neutral-300 outline-none"
                            title="New random tag every…"
                        >
                            {INTERVALS.map((s) => (
                                <option key={s} value={s}>
                                    every {s < 60 ? `${s}s` : `${s / 60}m`}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={onReroll}
                            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                            title="New random tag now (`)"
                        >
                            Reroll
                        </button>
                    </>
                )}
            </div>

            <label className="flex items-center gap-2" title="Scroll speed (5 / 6, or scroll)">
                <span className="text-neutral-500">Speed</span>
                <input
                    type="range"
                    min={SPEED_MIN}
                    max={SPEED_MAX}
                    step={10}
                    value={speed}
                    onChange={(e) => onSpeed(Number(e.target.value))}
                    // Leave the keys to the strip once let go.
                    onMouseUp={(e) => e.currentTarget.blur()}
                    className="w-24 accent-neutral-300"
                />
            </label>

        </div>
    );
}
