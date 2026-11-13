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
import { preloadImage } from "@renderer/lib/imageCache";
import { stepVideo, toMediaUrl, toThumbnailUrl, volumeLevel } from "@renderer/lib/media";
import SingleFileView from "./SingleFileView";

// Sweep: tag one tag at a time, over files that don't have it yet. The tag
// can be picked at random and rerolled on an interval.
//
// One row scrolls steadily right to left, every file at full height (no
// black bars). The file under the pointer is the active one; the pointer
// follows the mouse over the strip. The tag is the app-wide tag pointer's
// (contexts/TagPointerContext): its keys (Space, Tab / T / right click, `,
// H) work the same here as everywhere; Sweep adds the strip's own.
//   Space  toggle the tag on the active file (or click any file)
//   1  held: fast reverse; on release, forward again at the set speed
//   3  forward again (held: fast forward)    6  stop
//   2  pointer to the next lane (2–3 lanes), same height in it
//   Fast either way is 4× at once, climbing to 20×; so do the edges.
//   4 / 5  set speed down / up (or scroll)    `  new random tag
//   Tab / right click / T  hold: the strip stops and the pointer grows,
//     with earlier tags stacked above it (smaller and smaller, 3 at a time):
//     Tab steps back through them, Shift+Tab forward again, Space (or a
//     click) picks one. Or type to search (suggestions below: Shift+Tab or ↓
//     step down, wrapping; Tab, Space, Enter or a click picks). Esc or right
//     click lets go.
//   + / −  add a lane below / remove the bottom one (1 to 3 lanes; the
//          pointer's lane is the one the keys act on)
//   G  open in file view    R  rotate left    K  to Compare (king)
//   F  full screen (Esc leaves it)
//   H  hide menus

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
    } = useSettings();
    const { tag, reroll, pickingRef, hidden } = useTagPointer();
    const { crown } = useKingOfHill();

    const sweepTagId = tag?.id ?? null;
    // G: a file open in the single file view, over the sweep.
    const [inspected, setInspected] = useState<DbFile | null>(null);

    // Latest filters for fetching, without re-creating the layout.
    const filters = useRef({ folderPrefixes, activeFilter, tagId: sweepTagId });
    filters.current = { folderPrefixes, activeFilter, tagId: sweepTagId };

    // What's on screen now (never fetched again while it is), and what's
    // been shown since the tag was picked (not fetched again unless every
    // file has been).
    const visible = useRef<number[]>([]);
    const setVisible = useCallback((ids: number[]) => {
        visible.current = ids;
    }, []);
    const seen = useRef(new Set<number>());
    useEffect(() => {
        seen.current = new Set(visible.current);
    }, [sweepTagId, activeFilterKey]);

    const fetchFile = useCallback(async (): Promise<DbFile | null> => {
        const { folderPrefixes, activeFilter, tagId } = filters.current;
        const onScreen = visible.current;
        let file = await window.api.getRandomFile(
            folderPrefixes,
            activeFilter,
            [...new Set([...seen.current, ...onScreen])],
            tagId,
        );
        // Seen them all: start over, but never repeat what's on screen.
        if (!file && seen.current.size > 0) {
            seen.current = new Set(onScreen);
            file = await window.api.getRandomFile(folderPrefixes, activeFilter, onScreen, tagId);
        }
        if (file) seen.current.add(file.id);
        return file;
    }, []);

    // A new library starts fresh.
    useEffect(() => {
        visible.current = [];
        seen.current = new Set();
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
    const fullscreen = immersive;
    const contentOnly = hidden;
    // Whether F put the window in full screen (so leaving doesn't take it
    // out of a full screen the user chose themselves).
    const windowFullscreenByUs = useRef(false);
    const setFullscreen = useCallback(
        (on: boolean) => {
            setImmersive(on);
            if (on) {
                windowFullscreenByUs.current = true;
                window.api.setFullscreen(true);
            } else if (windowFullscreenByUs.current) {
                windowFullscreenByUs.current = false;
                window.api.setFullscreen(false);
            }
        },
        [setImmersive],
    );
    // The window left full screen some other way (the green button).
    useEffect(() => {
        if (!immersive) windowFullscreenByUs.current = false;
    }, [immersive]);
    // Leaving the view leaves full screen too.
    useEffect(() => {
        if (!active && immersive) setFullscreen(false);
    }, [active, immersive, setFullscreen]);

    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (inspected) {
                if (e.code === "Escape") setInspected(null);
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
    }, [active, inspected, fullscreen, setFullscreen, pickingRef]);

    // The sweep stays mounted (and paused) under the single file view, so
    // closing it comes back to the same spot.
    const sweeping = active && !inspected;

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden bg-neutral-950">
            {inspected && (
                <SingleFileView
                    file={inspected}
                    active={active}
                    setView={setView}
                    onClose={() => setInspected(null)}
                />
            )}
            <div className={inspected ? "hidden" : "relative flex flex-1 flex-col overflow-hidden"}>
                {/* No toolbar in full screen: just the strip. */}
                {!contentOnly && !fullscreen && (
                    <SweepToolbar
                        tag={tag}
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
                        onInspect={setInspected}
                        fetchFile={fetchFile}
                        setVisible={setVisible}
                        onCompare={toCompare}
                        contentOnly={contentOnly}
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
/** Videos this far (px) off screen still play, so they're moving on arrival. */
const PLAY_MARGIN_PX = 300;
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
/** 4 / 5 change the set speed by this much (px/s), within these limits. */
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
async function measureAspect(file: DbFile): Promise<number> {
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

/** Most lanes (+ adds one below, − removes the bottom one). */
const MAX_LANES = 3;
/** With varispeed on, each lane's speed against the set speed (the top lane
 *  always runs at it). */
const LANE_SPEED_VARY = [1, 0.86, 1.14];

type LaneMotion = { dir: 1 | 0 | -1; boost: boolean };
const CRUISE: LaneMotion = { dir: 1, boost: false };

/** What a lane hands the strip so it can update the lane's files. */
interface LaneHandle {
    replaceItemFile: (file: DbFile, turns?: number) => void;
}

function SweepStrip({
    rootPath,
    active,
    tag,
    speed,
    onSpeed,
    onInspect,
    fetchFile,
    setVisible,
    onCompare,
    contentOnly,
}: {
    rootPath: string;
    active: boolean;
    tag: DbTagWithCategory | null;
    /** H: just the files, no pointer or hints (the keys still work). */
    contentOnly: boolean;
    speed: number;
    onSpeed: (speed: number) => void;
    onInspect: (file: DbFile) => void;
    fetchFile: () => Promise<DbFile | null>;
    setVisible: (ids: number[]) => void;
    onCompare: (file: DbFile) => void;
}): JSX.Element {
    const { sweepVarispeed, sweepAllLanes, sweepScrubHold } = useSettings();
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
    // held. 1 / 3 / 6 and the edge zones move the lane under the cursor (or
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
    // (a rewind comes back as forward). Pressing 1 / 3 / 6, opening the
    // picker or leaving ends it: you've taken over.
    const scrubHoldRef = useRef(sweepScrubHold);
    scrubHoldRef.current = sweepScrubHold;
    // Lanes are stopped for a scrub (they ease to a halt fast).
    const scrubbingRef = useRef(false);
    // The tile key of the video being scrubbed.
    const scrubLock = useRef<number | null>(null);
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
        scrubLock.current = null;
    }, []);
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
    // What's on screen in every lane, so no lane fetches it again.
    const visibleByLane = useRef<number[][]>([]);
    const onLaneVisible = useCallback(
        (i: number, ids: number[]) => {
            visibleByLane.current[i] = ids;
            setVisible(visibleByLane.current.slice(0, laneCountRef.current).flat());
        },
        [setVisible],
    );
    // Unique tile keys across lanes (flashes are keyed by them).
    const keyCounter = useRef(0);
    // Each tile's <video>, by tile key (Q / E scrub the active one).
    const videoEls = useRef(new Map<number, HTMLVideoElement>());
    const onTileVideo = useCallback((key: number, el: HTMLVideoElement | null) => {
        if (el) videoEls.current.set(key, el);
        else videoEls.current.delete(key);
    }, []);

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
    // The lanes 1 / 3 / 6 and the edge zones act on.
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
        const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const laneHeight = laneCount > 0 ? box.height / laneCount : box.height;

    // Tag feedback on a file: a soft flash, `n` counting so each restarts.
    const [flashes, setFlashes] = useState<Record<number, { kind: "on" | "already" | "denied"; n: number }>>({});
    const flashCount = useRef(0);

    // The live set speed: scrolling changes it straight away (finer than the
    // rounded setting); the slider and 4 / 5 come in through `speed`. A new
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
    // Quarter turns left being previewed per file. The tile keeps its width
    // meanwhile, the turned media zoomed to fill it, so pressing R again
    // (90, 180, 270) never needs the mouse moved. Its lane eases to a stop
    // while rotating. The file is saved once pressing stops (or the pointer
    // moves to another file); the new version is loaded out of sight, then
    // swaps in at once and only then does the tile take its new width: its
    // left edge stays, the files to its right move. Only that refit animates.
    // The pending turns live in the ref (updated at once, so a save that
    // finishes can tell straight away whether more presses came in); the
    // state is a copy for drawing.
    const rotTurnsRef = useRef<Record<number, number>>({});
    const [rotTurns, setRotTurnsState] = useState<Record<number, number>>({});
    const setRotTurns = (update: (p: Record<number, number>) => Record<number, number>) => {
        rotTurnsRef.current = update(rotTurnsRef.current);
        setRotTurnsState(rotTurnsRef.current);
    };
    // The lane whose file is being turned (it holds still), or null.
    const [rotatingLane, setRotatingLane] = useState<number | null>(null);
    const rotFiles = useRef(new Map<number, DbFile>()); // file to save, per id
    const rotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rotSaving = useRef(new Set<number>());

    // A file's record changed (rotated here or elsewhere: new content, new
    // hash): every lane showing it updates. `turns`: quarter turns it was
    // turned, to swap its shape.
    const replaceItemFile = useCallback((file: DbFile, turns = 0) => {
        for (const h of laneHandles.current) h?.replaceItemFile(file, turns);
    }, []);

    // Rotated somewhere else: show the new version (its shape is checked
    // when it loads). Our own rotation swaps in itself once loaded.
    useEffect(() => {
        return window.api.onMediaUpdated(({ file }) => {
            if (!file) return;
            if (rotSaving.current.has(file.id) || rotTurnsRef.current[file.id]) return;
            replaceItemFile(file);
        });
    }, [replaceItemFile]);

    const turnsOf = useCallback((fileId: number) => rotTurns[fileId] ?? 0, [rotTurns]);
    const isTurning = useCallback((fileId: number) => !!rotTurnsRef.current[fileId], []);

    const saveRotation = useCallback(
        async (id: number) => {
            const file = rotFiles.current.get(id);
            const turns = rotTurnsRef.current[id] ?? 0;
            if (!file || rotSaving.current.has(id)) return;
            const clear = (saved: number) =>
                setRotTurns((p) => {
                    const n = { ...p };
                    const left = (n[id] ?? 0) - saved;
                    if (left > 0) n[id] = left;
                    else delete n[id];
                    return n;
                });
            if (turns % 4 === 0) {
                rotFiles.current.delete(id);
                clear(turns); // full circle: nothing to save
                return;
            }
            rotSaving.current.add(id);
            try {
                const updated = await window.api.rotateFile(file.path, turns);
                const url = toMediaUrl(rootPath, updated.path, updated.content_hash);
                // Loaded before it's shown, so the swap is seamless.
                await Promise.race([
                    updated.media_type === "video"
                        ? new Promise<void>((resolve) => {
                              const v = document.createElement("video");
                              v.muted = true;
                              v.preload = "auto";
                              v.onloadeddata = () => resolve();
                              v.onerror = () => resolve();
                              v.src = url;
                          })
                        : preloadImage(url),
                    new Promise((resolve) => setTimeout(resolve, 1500)),
                ]);
                rotFiles.current.set(id, updated);
                // One render: new version, new shape, preview dropped.
                replaceItemFile(updated, turns);
                clear(turns);
            } catch (err) {
                console.error("Rotate failed:", err);
                clear(turns);
            } finally {
                rotSaving.current.delete(id);
            }
            // Pressed again while saving: save those too.
            if (rotTurnsRef.current[id]) saveRotation(id);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [rootPath, replaceItemFile],
    );

    const rotateLeft = useCallback(() => {
        const item = activeItem;
        if (!item) return;
        const id = item.file.id;
        if (!rotFiles.current.has(id)) rotFiles.current.set(id, item.file);
        setRotTurns((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));
        setRotatingLane(pointerLaneRef.current);
        if (rotTimer.current) clearTimeout(rotTimer.current);
        rotTimer.current = setTimeout(() => saveRotation(id), 900);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeItem, saveRotation]);

    // The pointer moved to another file: save what was being turned now.
    const rotActiveId = activeItem?.file.id;
    useEffect(() => {
        for (const id of Object.keys(rotTurnsRef.current).map(Number)) {
            if (id !== rotActiveId) saveRotation(id);
        }
    }, [rotActiveId, saveRotation]);

    // Nothing left to turn or save: its lane carries on.
    useEffect(() => {
        if (rotatingLane != null && Object.keys(rotTurns).length === 0) setRotatingLane(null);
    }, [rotatingLane, rotTurns]);

    // Leaving: save anything still pending.
    useEffect(() => {
        if (active) return;
        for (const id of Object.keys(rotTurnsRef.current).map(Number)) saveRotation(id);
    }, [active, saveRotation]);

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
    // The lanes a held 1 / 3 started on (letting go affects the same ones).
    const heldLanes = useRef<{ one: number[]; three: number[] }>({ one: [], three: [] });
    // Whether the strip itself took the 1 / 3 press (not the picker), so
    // only those releases move lanes.
    const heldDown = useRef({ one: false, three: false });
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping() || pickingRef.current) return;
            const { activeItem, speed } = state.current;
            switch (e.code) {
                case "Digit4":
                case "Digit5":
                    e.preventDefault();
                    onSpeed(
                        Math.max(
                            SPEED_MIN,
                            Math.min(SPEED_MAX, speed + (e.code === "Digit5" ? SPEED_STEP : -SPEED_STEP)),
                        ),
                    );
                    break;
                case "KeyG":
                    e.preventDefault();
                    if (!e.repeat && activeItem) onInspect(activeItem.file);
                    break;
                case "Digit1": {
                    // Fast reverse while held (forward again on release).
                    e.preventDefault();
                    if (e.repeat) return;
                    cancelScrubResume();
                    const lanes = targetLanes();
                    heldLanes.current.one = lanes;
                    heldDown.current.one = true;
                    setLaneMotion(lanes, { dir: -1, boost: true });
                    break;
                }
                case "Digit6":
                    // Stop (the lane under the cursor, or all of them).
                    e.preventDefault();
                    cancelScrubResume();
                    setLaneMotion(targetLanes(), { dir: 0, boost: false });
                    break;
                case "Digit3": {
                    e.preventDefault();
                    if (e.repeat) return;
                    cancelScrubResume();
                    const lanes = targetLanes();
                    heldLanes.current.three = lanes;
                    heldDown.current.three = true;
                    setLaneMotion(lanes, { dir: 1, boost: true });
                    break;
                }
                case "Digit2":
                    // The pointer down a lane (wrapping), same height in it.
                    e.preventDefault();
                    if (e.repeat || laneCountRef.current < 2) return;
                    laneOffset.current = (laneOffset.current + 1) % laneCountRef.current;
                    // Aimed somewhere else, like moving the mouse: the next
                    // scrub picks the video under the pointer again.
                    scrubLock.current = null;
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
                    // Scrub the active video, as everywhere else. The lanes
                    // stop meanwhile (see Scrub pause).
                    e.preventDefault();
                    const key = scrubLock.current ?? activeItem?.key;
                    const video = key != null ? videoEls.current.get(key) : undefined;
                    if (key != null && video) {
                        scrubLock.current = key;
                        pauseForScrub();
                        stepVideo(video, e.code === "KeyQ" || e.code === "ArrowLeft" ? -1 : 1);
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
            }
        };
        // Letting go of 3 (or leaving the window, or the view) ends the
        // fast forward; it keeps going forward at the set speed. Letting go
        // of 1 also turns those lanes forward again.
        const onKeyUp = (e: KeyboardEvent) => {
            if (pickingRef.current) return;
            if (e.code === "Digit3" && heldDown.current.three) {
                heldDown.current.three = false;
                setLaneMotion(heldLanes.current.three, { boost: false });
            }
            if (e.code === "Digit1" && heldDown.current.one) {
                heldDown.current.one = false;
                setLaneMotion(heldLanes.current.one, { dir: 1, boost: false });
            }
        };
        const stopBoost = () =>
            setMotion((m) => m.map((x) => ({ dir: x.dir === -1 ? 1 : x.dir, boost: false })));
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

    const pointerMotion = motion[pointerLane] ?? CRUISE;

    return (
        <div
            ref={boxRef}
            // The pointer stands in for the mouse here, so the cursor hides
            // (back while picking, to click a result).
            className={`relative min-h-0 flex-1 overflow-hidden bg-black select-none ${
                picking ? "" : "cursor-none"
            }`}
            onMouseMove={(e) => {
                // The pointer holds still while the picker is open.
                if (pickingRef.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                // Really moved: a 2 shift ends and the pointer follows the
                // mouse again.
                const last = lastScreen.current;
                if (!last || last.x !== e.screenX || last.y !== e.screenY) {
                    laneOffset.current = 0;
                    // Aiming somewhere else: the next scrub picks again.
                    scrubLock.current = null;
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
            }}
            onMouseLeave={() => {
                if (pickingRef.current) return;
                mouseX.current = null;
                mouseY.current = null;
                lastScreen.current = null;
                applyEdge(null, 0, []);
                // Glide back to where it rests: the top of its (shifted) lane.
                placePointer(true);
            }}
            onContextMenu={(e) => {
                // Right click: hold; again: let go.
                e.preventDefault();
                togglePicker();
            }}
            onWheel={(e) => {
                // Scrolling (wheel or two fingers) sets the speed: up faster,
                // down slower. Proportional, so a trackpad's many small
                // steps and a wheel's big ones both feel right. Pinch
                // (ctrl + wheel) is left alone.
                if (e.ctrlKey) return;
                const next = wheelSpeed.current * Math.exp(-e.deltaY * 0.002);
                applySpeed(Math.max(SPEED_MIN, Math.min(SPEED_MAX, next)));
                onSpeed(Math.round(wheelSpeed.current));
            }}
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
                        holdStill={rotatingLane === i}
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
                        turnsOf={turnsOf}
                        isTurning={isTurning}
                        onTileClick={onTileClick}
                        onTileVideo={onTileVideo}
                        onActive={onLaneActive}
                        onVisible={onLaneVisible}
                        register={registerLane}
                    />
                ))}
            </div>

            {/* The pointer, with the tag it applies */}
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

            {/* Direction / stopped (the pointer's lane), and the lanes */}
            <div
                className={`pointer-events-none absolute bottom-3 right-4 z-20 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-neutral-400 ${
                    contentOnly ? "hidden" : ""
                }`}
            >
                {pointerMotion.dir === 1 ? (pointerMotion.boost ? "▶▶" : "▶") : pointerMotion.dir === -1 ? "◀◀" : "❚❚"}{" "}
                {speed} px/s · 4 slower · 5 faster · {laneCount} lane{laneCount === 1 ? "" : "s"} (+ / −)
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
    turnsOf,
    isTurning,
    onTileClick,
    onTileVideo,
    onActive,
    onVisible,
    register,
}: {
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
    /** A file in it is being rotated: ease to a stop. */
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
    turnsOf: (fileId: number) => number;
    isTurning: (fileId: number) => boolean;
    onTileClick: (item: StripItem) => void;
    onTileVideo: (key: number, el: HTMLVideoElement | null) => void;
    onActive: (lane: number, item: StripItem | undefined) => void;
    onVisible: (lane: number, ids: number[]) => void;
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
    // Width added or dropped on the left by the last change to `items`,
    // applied to the offset in the same paint so the picture doesn't jump.
    const pendingShift = useRef(0);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [playing, setPlaying] = useState<[number, number]>([0, -1]);
    // Last values handed to React, so frames that change nothing don't render.
    const lastActive = useRef(-1);
    const lastPlaying = useRef<[number, number]>([0, -1]);
    const isPointerLaneRef = useRef(isPointerLane);
    isPointerLaneRef.current = isPointerLane;
    // The item last reported as active (a replaced file is a new object).
    const activeItemRef = useRef<StripItem | undefined>(undefined);

    const widthOf = useCallback((item: StripItem) => item.aspect * height, [height]);

    const replaceItemFile = useCallback((file: DbFile, turns = 0) => {
        if (!itemsRef.current.some((it) => it.file.id === file.id)) return;
        const next = itemsRef.current.map((it) =>
            it.file.id === file.id ? { ...it, file, aspect: turns % 2 ? 1 / it.aspect : it.aspect } : it,
        );
        itemsRef.current = next;
        setItems(next);
    }, []);
    useEffect(() => {
        register(index, { replaceItemFile });
        return () => register(index, null);
    }, [register, index, replaceItemFile]);

    // A tile's real shape once loaded, if the thumbnail's was off (or the
    // file changed since). Not while a rotation is being previewed.
    const onShape = useCallback(
        (key: number, aspect: number) => {
            const item = itemsRef.current.find((it) => it.key === key);
            if (!item || isTurning(item.file.id)) return;
            if (Math.abs(aspect - item.aspect) / item.aspect < 0.02) return;
            const next = itemsRef.current.map((it) => (it.key === key ? { ...it, aspect } : it));
            itemsRef.current = next;
            setItems(next);
        },
        [isTurning],
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
            return;
        }
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

    // A new tag can bring files back, and so can waiting.
    useEffect(() => {
        setExhausted(false);
    }, [tag?.id]);
    useEffect(() => {
        if (!exhausted) return;
        const t = setTimeout(() => setExhausted(false), 2000);
        return () => clearTimeout(t);
    }, [exhausted]);

    // Only what's on screen (or nearly) is kept from repeating.
    useEffect(() => {
        onVisible(index, items.slice(playing[0], playing[1] + 1).map((it) => it.file.id));
    }, [items, playing, onVisible, index]);
    useEffect(() => () => onVisible(index, []), [onVisible, index]);

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
            // Rotating one of its files: ease to a stop.
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
            velocities.current[index] = v + (target - v) * Math.min(1, dt * ease);
            offset.current -= velocities.current[index] * dt;
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
                if (x + w > -PLAY_MARGIN_PX && x < width + PLAY_MARGIN_PX) {
                    first = Math.min(first, i);
                    lastIdx = i;
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
                        play={active && i >= playing[0] && i <= playing[1]}
                        flash={flashes[it.key]}
                        height={height}
                        turns={turnsOf(it.file.id)}
                        onShape={onShape}
                        onVideo={onTileVideo}
                        onClick={() => onTileClick(it)}
                    />
                ))}
            </div>
            {items.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
                    {exhausted
                        ? tag
                            ? `No files without "${tag.name}" in the current filters`
                            : "No files in the current filters"
                        : "Loading…"}
                </div>
            )}
        </div>
    );
}

function StripTile({
    item,
    width,
    rootPath,
    isActive,
    play,
    flash,
    height,
    turns,
    onShape,
    onVideo,
    onClick,
}: {
    item: StripItem;
    width: number;
    height: number;
    /** Quarter turns left being previewed (R), before the save lands; the
     *  tile keeps its width meanwhile. */
    turns: number;
    /** Reports the media's real shape (width / height) once loaded. */
    onShape: (key: number, aspect: number) => void;
    /** Hands over its <video> (null when it goes), for scrubbing. */
    onVideo: (key: number, el: HTMLVideoElement | null) => void;
    rootPath: string;
    isActive: boolean;
    /** On screen (or nearly): videos play; otherwise they're paused. */
    play: boolean;
    /** The tag was just added ("on"), was already on and a second press
     *  will remove it ("already"), or couldn't be changed ("denied"). */
    flash?: { kind: "on" | "already" | "denied"; n: number };
    onClick: () => void;
}): JSX.Element {
    const { volume } = useSettings();
    const videoRef = useRef<HTMLVideoElement>(null);
    const url = toMediaUrl(rootPath, item.file.path, item.file.content_hash);

    // A preview turn: the tile keeps its width and the media is turned
    // inside it, zoomed to fill it. It snaps (no animation).
    const sideways = turns % 2 === 1;
    const mediaStyle: React.CSSProperties = {
        position: "absolute",
        width: sideways ? height : "100%",
        height: sideways ? width : "100%",
        left: sideways ? (width - height) / 2 : 0,
        top: sideways ? (height - width) / 2 : 0,
        maxWidth: "none",
        transform: turns ? `rotate(${-90 * turns}deg)` : undefined,
    };

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (play) v.play().catch(() => {});
        else v.pause();
    }, [play]);

    useEffect(() => {
        if (videoRef.current) videoRef.current.volume = volumeLevel(volume);
    }, [volume]);

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        onVideo(item.key, v);
        return () => onVideo(item.key, null);
    }, [onVideo, item.key, url]);

    return (
        <div
            className="relative h-full shrink-0 overflow-hidden"
            // A new shape (after a rotation saves) eases in: the left edge
            // stays and the files to the right slide along. (The turn
            // itself snaps.)
            style={{ width, transition: "width 250ms ease-out" }}
            onClick={onClick}
        >
            {item.file.media_type === "video" ? (
                <video
                    ref={videoRef}
                    src={url}
                    className="object-cover"
                    style={mediaStyle}
                    onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.videoWidth && v.videoHeight) onShape(item.key, v.videoWidth / v.videoHeight);
                    }}
                    muted={!isActive}
                    loop
                    playsInline
                    preload="metadata"
                />
            ) : (
                <img
                    src={url}
                    className="object-cover"
                    style={mediaStyle}
                    draggable={false}
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        if (img.naturalWidth && img.naturalHeight) {
                            onShape(item.key, img.naturalWidth / img.naturalHeight);
                        }
                    }}
                />
            )}
            {/* Tag feedback: thin top and bottom edges flash, soft white for
                added, soft red for an inherited tag that can't change here. */}
            {flash && (
                <React.Fragment key={flash.n}>
                    {["top-0", "bottom-0"].map((edge) => (
                        <div
                            key={edge}
                            className={`pointer-events-none absolute inset-x-0 ${edge} h-[3px] ${
                                flash.kind === "on"
                                    ? "bg-white/80"
                                    : flash.kind === "already"
                                      ? "bg-amber-300/90"
                                      : "bg-red-400/80"
                            }`}
                            style={{
                                // "Already on here": amber, blinking twice.
                                animation:
                                    flash.kind === "already"
                                        ? "sweep-flash-twice 900ms ease-out forwards"
                                        : "sweep-flash 900ms ease-out forwards",
                            }}
                        />
                    ))}
                </React.Fragment>
            )}
        </div>
    );
}

// ─── Key hints ─────────────────────────────────────────────────────────────
// Shown in full at the end of the toolbar when they fit; otherwise folded
// into a "Keys" button with the list on hover. They take only the space
// left over, so they never push the toolbar onto a second line.

const STRIP_HINTS: [string, string][] = [
    ["Space / click", "toggle the tag"],
    ["Tab / right click / T", "hold: Tab back through earlier tags, Shift+Tab forward, Space picks; or type to search"],
    ["Tab Tab", "back to the previous tag (resting on an earlier tag picks it)"],
    ["Tab + 1 / 2 / 3", "rolodex of tags in the same category / often on the same files / not offered in the tag pointer (3: type to search); Tab / Shift+Tab move, rest or Space picks, Esc leaves"],
    ["Esc / right click", "let go of the hold (Esc also leaves full screen)"],
    ["hold 1", "rewind"],
    ["6", "stop"],
    ["3", "go (hold: faster)"],
    ["4 / 5, scroll", "slower / faster"],
    ["+ / −", "add a lane below / remove the bottom one (up to 3)"],
    ["2", "pointer to the next lane (same height in it)"],
    ["`", "new random tag"],
    ["Q / E", "scrub the video back / forward (lanes stop meanwhile)"],
    ["G", "open in file view"],
    ["R", "rotate left"],
    ["K", "send to Compare (king)"],
    ["F", "full screen"],
    ["H", "hide the pointer and menus"],
];

function KeyHints({ hints }: { hints: [string, string][] }): JSX.Element {
    const boxRef = useRef<HTMLDivElement>(null);
    const fullRef = useRef<HTMLSpanElement>(null);
    const [fits, setFits] = useState(true);

    useEffect(() => {
        const box = boxRef.current;
        const full = fullRef.current;
        if (!box || !full) return;
        const check = () => setFits(full.scrollWidth <= box.clientWidth);
        const ro = new ResizeObserver(check);
        ro.observe(box);
        check();
        return () => ro.disconnect();
    }, [hints]);

    const line = hints.map(([k, v]) => `${k} ${v}`).join(" · ");

    return (
        // basis-0: it only ever takes leftover space, so it can't wrap the row.
        <div ref={boxRef} className="relative ml-auto flex min-w-[3rem] flex-1 basis-0 justify-end">
            {/* Measures the full line without showing it. */}
            <span
                ref={fullRef}
                aria-hidden
                className="pointer-events-none invisible absolute right-0 whitespace-nowrap"
            >
                {line}
            </span>
            {fits ? (
                <span className="whitespace-nowrap text-neutral-600">{line}</span>
            ) : (
                <div className="group relative">
                    <span className="cursor-default rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500 group-hover:text-neutral-300">
                        Keys
                    </span>
                    <div className="pointer-events-none invisible absolute right-0 top-full z-50 mt-2 w-max rounded-md border border-neutral-700 bg-neutral-950 p-2.5 shadow-xl group-hover:visible">
                        <table className="text-[11px]">
                            <tbody>
                                {hints.map(([k, v]) => (
                                    <tr key={k}>
                                        <td className="pr-3 text-right font-mono text-neutral-300">{k}</td>
                                        <td className="py-0.5 text-neutral-500">{v}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Toolbar ───────────────────────────────────────────────────────────────
// The tag (picked on the pointer: Tab, right click or T), random rerolls and
// the scroll speed.

function SweepToolbar({
    tag,
    random,
    onToggleRandom,
    interval,
    onInterval,
    onReroll,
    speed,
    onSpeed,
}: {
    tag: DbTagWithCategory | null;
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

            <label className="flex items-center gap-2" title="Scroll speed (4 / 5, or scroll)">
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

            <KeyHints hints={STRIP_HINTS} />
        </div>
    );
}
