import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DbFile, DbTag, DbTagWithCategory, View } from "@renderer/shared/types/types";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useKingOfHill } from "@renderer/contexts/KingOfHillContext";
import { publishFileTags, useFileTags } from "@renderer/hooks/useFileTags";
import { claimSpaceAndTab, isTyping } from "@renderer/lib/keys";
import { preloadImage } from "@renderer/lib/imageCache";
import { stepVideo, toMediaUrl, toThumbnailUrl, volumeLevel } from "@renderer/lib/media";
import SingleFileView from "./SingleFileView";

// Sweep: tag one tag at a time, over files that don't have it yet. The tag
// can be picked at random and rerolled on an interval.
//
// One row scrolls steadily right to left, every file at full height (no
// black bars). The file under the pointer is the active one; the pointer
// follows the mouse over the strip.
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

/** The swept tag on a file: its own, inherited, or not there. */
type TagState = "own" | "inherited" | null;

/** Adds or removes the swept tag. An inherited one can't be: returns false. */
async function toggleSweptTag(file: DbFile, tag: DbTag, state: TagState): Promise<boolean> {
    if (state === "inherited") return false;
    const next =
        state === "own"
            ? await window.api.removeTag(file.id, tag.name)
            : await window.api.addTag(file.id, tag.name);
    publishFileTags(file.id, next);
    return true;
}

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
    const { allTags: everyTag, tagMap, activeTags, tagMode } = useTags();
    // Only tags switched on for Sweep (and whose category is) are offered:
    // in the picker, random picks and the roll animation.
    const allTags = useMemo(
        () => everyTag.filter((t) => t.sweep && (!t.category || t.category.sweep)),
        [everyTag],
    );
    const {
        sweepTagId,
        setSweepTagId,
        sweepRandom,
        setSweepRandom,
        sweepInterval,
        setSweepInterval,
        sweepSpeed,
        setSweepSpeed,
    } = useSettings();
    const { crown } = useKingOfHill();

    const tag = sweepTagId != null ? (tagMap.get(sweepTagId) ?? null) : null;
    // G: a file open in the single file view, over the sweep.
    const [inspected, setInspected] = useState<DbFile | null>(null);
    // The pointer's tag picker is open (the strip's keys wait, and so do ours).
    const [picking, setPicking] = useState(false);
    const pickingRef = useRef(false);
    pickingRef.current = picking;

    // Latest filters for fetching, without re-creating the layout.
    const filters = useRef({ folderPrefixes, activeTags, tagMode, tagId: sweepTagId });
    filters.current = { folderPrefixes, activeTags, tagMode, tagId: sweepTagId };

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
    }, [sweepTagId]);

    const fetchFile = useCallback(async (): Promise<DbFile | null> => {
        const { folderPrefixes, activeTags, tagMode, tagId } = filters.current;
        const tagList = activeTags.size > 0 ? [...activeTags] : null;
        const onScreen = visible.current;
        let file = await window.api.getRandomFile(
            folderPrefixes,
            tagList,
            tagMode,
            [...new Set([...seen.current, ...onScreen])],
            tagId,
        );
        // Seen them all: start over, but never repeat what's on screen.
        if (!file && seen.current.size > 0) {
            seen.current = new Set(onScreen);
            file = await window.api.getRandomFile(folderPrefixes, tagList, tagMode, onScreen, tagId);
        }
        if (file) seen.current.add(file.id);
        return file;
    }, []);

    // A new library starts fresh.
    useEffect(() => {
        visible.current = [];
        seen.current = new Set();
    }, [rootPath]);

    // ── Random tag ───────────────────────────────────────────────────────
    const [rolledAt, setRolledAt] = useState(0);

    // Tags swept before this one, most recent last, for going back.
    const tagHistory = useRef<number[]>([]);

    // Counts rerolls, so the strip's pointer can play its roll animation.
    const [rollSeq, setRollSeq] = useState(0);
    const reroll = useCallback(() => {
        const pool = allTags.filter((t) => t.id !== sweepTagId);
        if (pool.length === 0) return;
        if (sweepTagId != null) tagHistory.current.push(sweepTagId);
        setSweepTagId(pool[Math.floor(Math.random() * pool.length)].id);
        setRolledAt(Date.now());
        setRollSeq((n) => n + 1);
    }, [allTags, sweepTagId, setSweepTagId]);

    // Random on with nothing (or a deleted tag) to sweep: pick one now.
    useEffect(() => {
        if (sweepRandom && !tag && allTags.length > 0) reroll();
    }, [sweepRandom, tag, allTags.length, reroll]);

    // Reroll on the interval, counted from the last pick, while sweeping.
    // `deadline` is when it'll fire, for the countdown on the pointer. The
    // picker pauses it; cancelling resumes where it was, picking starts a
    // full countdown.
    const [deadline, setDeadline] = useState<number | null>(null);
    const deadlineRef = useRef<number | null>(null);
    deadlineRef.current = deadline;
    const pausedLeft = useRef<number | null>(null);
    useEffect(() => {
        if (!sweepRandom || !active || inspected || picking) {
            if (picking && deadlineRef.current != null) {
                pausedLeft.current = Math.max(1000, deadlineRef.current - Date.now());
            }
            setDeadline(null);
            return;
        }
        const ms = pausedLeft.current ?? sweepInterval * 1000;
        pausedLeft.current = null;
        setDeadline(Date.now() + ms);
        const t = setTimeout(reroll, ms);
        return () => clearTimeout(t);
    }, [sweepRandom, active, inspected, picking, sweepInterval, rolledAt, reroll]);

    const pickTag = useCallback(
        (t: DbTag) => {
            pausedLeft.current = null;
            if (sweepTagId != null && sweepTagId !== t.id) tagHistory.current.push(sweepTagId);
            setSweepTagId(t.id);
            setRolledAt(Date.now());
        },
        [sweepTagId, setSweepTagId],
    );

    // Earlier tags, most recent first, each once, leaving out the current
    // one and any since deleted or switched off for Sweep: the hold's
    // history stack. Read while rendering (it only changes with the tag).
    const pastTags = (() => {
        const out: DbTagWithCategory[] = [];
        const seenIds = new Set<number>(sweepTagId != null ? [sweepTagId] : []);
        const h = tagHistory.current;
        for (let i = h.length - 1; i >= 0 && out.length < 50; i--) {
            if (seenIds.has(h[i])) continue;
            seenIds.add(h[i]);
            const t = allTags.find((t) => t.id === h[i]);
            if (t) out.push(t);
        }
        return out;
    })();

    const toCompare = useCallback(
        (file: DbFile) => {
            crown(file);
            setView("compare");
        },
        [crown, setView],
    );

    // F: full screen (just the strip: no sidebar, no toolbar). It's the
    // window's own full screen, so Esc reaches us: Esc leaves it (unless the
    // pointer's hold is open; Esc lets go of that first). H: content only,
    // no pointer, toolbar or hints. Esc also leaves the single file view.
    const fullscreen = immersive;
    const [contentOnly, setContentOnly] = useState(false);
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
            } else if (e.code === "KeyH" && !e.repeat) {
                e.preventDefault();
                setContentOnly((c) => !c);
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active, inspected, fullscreen, setFullscreen]);

    // The sweep stays mounted (and paused) under the single file view, so
    // closing it comes back to the same spot.
    const sweeping = active && !inspected;

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden bg-neutral-950">
            {/* Here, not in the toolbar: it isn't rendered in full screen or
                with H, and these are needed then too. */}
            <style>{SWEEP_KEYFRAMES}</style>
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
                        onToggleRandom={() => {
                            setSweepRandom(!sweepRandom);
                            setRolledAt(Date.now());
                        }}
                        interval={sweepInterval}
                        onInterval={(s) => {
                            setSweepInterval(s);
                            setRolledAt(Date.now());
                        }}
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
                        onReroll={reroll}
                        onPickTag={pickTag}
                        pastTags={pastTags}
                        onPickingChange={setPicking}
                        rollSeq={rollSeq}
                        allTags={allTags}
                        countdown={deadline ? { deadline, interval: sweepInterval } : null}
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

const SWEEP_KEYFRAMES = `
@keyframes sweep-countdown { from { width: 100%; } to { width: 0%; } }
@keyframes sweep-flash { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
@keyframes sweep-flash-twice { 0% { opacity: 0; } 12% { opacity: 1; } 35% { opacity: 0.1; } 50% { opacity: 1; } 100% { opacity: 0; } }
@keyframes sweep-ending { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.sweep-countdown-fill[data-ending="1"] { animation: sweep-ending 0.7s ease-in-out infinite; }
`;

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
/** How many tags show on each side of the one at the history cursor. */
const STACK_SHOWN = 2;

/** Where a history pill sits: slot 0 is the main pill's place, 1–3 rise
 *  above it smaller and fainter, -1 (newer than the cursor) drops away
 *  below. `leaving`: a search is starting, so they all fade. */
function stackSlotStyle(slot: number): React.CSSProperties {
    // A rolodex: the card at the cursor faces you; older ones (above) and
    // newer ones (below) shrink the further they are.
    const d = Math.min(Math.abs(slot), STACK_RISE.length - 1);
    const dir = Math.sign(slot); // 1 above, -1 below
    return {
        transform:
            `translateX(-50%) translateY(${-dir * STACK_RISE[d]}px) scale(${STACK_SCALE[d]})`,
        opacity: STACK_OPACITY[d],
        zIndex: 10 - d,
        transition: `transform ${STACK_MS}ms ease-out, opacity ${STACK_MS}ms ease-out, background-color ${STACK_MS}ms`,
    };
}

/** Per distance from the cursor: how far a card sits (px), its size and
 *  how visible it is. The last entry is just past what's shown. */
const STACK_RISE = [0, 22, 40, 54];
const STACK_SCALE = [1, 0.82, 0.68, 0.56];
// Fully opaque (cards behind don't show through), just gone past what's shown.
const STACK_OPACITY = [1, 1, 1, 0];

/** How long the history stack takes to slide one step (ms). */
const STACK_MS = 120;
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

/**
 * The hold's search: tags matching `q`, best first, at most 8. Forgiving,
 * since only tags that exist can be picked:
 *   0  the name starts with it       1  a word in it starts with it
 *   2  it's somewhere in the name    3+ a typo or two away from the start
 *   of the name or a word (from 3 letters typed; 2 typos from 6)
 *   6  its letters appear in order (from 2 letters typed)
 * Ties: shorter names first, then alphabetical.
 */
function searchTags(q: string, tags: DbTagWithCategory[]): DbTagWithCategory[] {
    if (!q) return [];
    const maxTypos = q.length >= 6 ? 2 : q.length >= 3 ? 1 : 0;
    const scored: { tag: DbTagWithCategory; score: number }[] = [];
    for (const tag of tags) {
        const name = tag.name;
        const words = name.split(/[\s\-_]+/).filter(Boolean);
        let score = Infinity;
        if (name.startsWith(q)) score = 0;
        else if (words.some((w) => w.startsWith(q))) score = 1;
        else if (name.includes(q)) score = 2;
        else {
            if (maxTypos > 0) {
                // Against the start of the name and of each word, a letter
                // shorter or longer too (a dropped or doubled letter).
                let best = Infinity;
                for (const w of [name, ...words]) {
                    for (const len of [q.length - 1, q.length, q.length + 1]) {
                        if (len < 1 || len > w.length) continue;
                        best = Math.min(best, typos(q, w.slice(0, len)));
                    }
                }
                if (best <= maxTypos) score = 3 + best;
            }
            if (score === Infinity && q.length >= 2 && inOrder(q, name)) score = 6;
        }
        if (score !== Infinity) scored.push({ tag, score });
    }
    return scored
        .sort(
            (a, b) =>
                a.score - b.score ||
                a.tag.name.length - b.tag.name.length ||
                a.tag.name.localeCompare(b.tag.name),
        )
        .slice(0, 8)
        .map((s) => s.tag);
}

/** Edits (insert, delete, change, swap two neighbours) to turn a into b. */
function typos(a: string, b: string): number {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[a.length][b.length];
}

/** Whether all of q's letters appear in s, in order. */
function inOrder(q: string, s: string): boolean {
    let i = 0;
    for (const c of s) if (c === q[i]) i++;
    return i === q.length;
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
    onReroll,
    onPickTag,
    pastTags,
    onPickingChange,
    rollSeq,
    allTags,
    countdown,
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
    onReroll: () => void;
    /** A tag chosen in the pointer's picker. */
    onPickTag: (tag: DbTagWithCategory) => void;
    /** Earlier tags, most recent first: the hold's history stack. */
    pastTags: DbTagWithCategory[];
    /** The picker opened or closed. */
    onPickingChange: (open: boolean) => void;
    /** Goes up on each reroll: the pointer rolls through tag names. */
    rollSeq: number;
    allTags: DbTagWithCategory[];
    /** Random on: when the next reroll fires (ms), shown on the pointer. */
    countdown: { deadline: number; interval: number } | null;
    onInspect: (file: DbFile) => void;
    fetchFile: () => Promise<DbFile | null>;
    setVisible: (ids: number[]) => void;
    onCompare: (file: DbFile) => void;
}): JSX.Element {
    const { sweepVarispeed, sweepAllLanes } = useSettings();
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

    // Reroll animation: tag names flick past on the pointer, slowing down,
    // then it lands on the new tag.
    const [rolling, setRolling] = useState<DbTagWithCategory | null>(null);
    // Until the roll lands, tagging still uses the tag that was showing
    // before it: the new one hasn't been seen yet.
    const [rollFrom, setRollFrom] = useState<DbTagWithCategory | null>(null);
    const shownTag = useRef(tag);
    const firstRoll = useRef(rollSeq);
    useEffect(() => {
        if (rollSeq === firstRoll.current || allTags.length < 2) return;
        setRollFrom(shownTag.current);
        const steps = [40, 45, 50, 60, 70, 85, 105, 130, 160];
        const timers: ReturnType<typeof setTimeout>[] = [];
        let at = 0;
        steps.forEach((delay) => {
            at += delay;
            timers.push(
                setTimeout(
                    () => setRolling(allTags[Math.floor(Math.random() * allTags.length)]),
                    at - delay,
                ),
            );
        });
        timers.push(
            setTimeout(() => {
                setRolling(null);
                setRollFrom(null);
            }, at),
        );
        return () => {
            timers.forEach(clearTimeout);
            setRolling(null);
            setRollFrom(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rollSeq]);
    // After the roll effect, so it still sees the tag from before a reroll.
    useEffect(() => {
        shownTag.current = tag;
    }, [tag]);
    // The tag a press applies: the one on screen (the old one mid-roll).
    const applyTag = rollFrom ?? tag;

    // The countdown bar's fill, sized from the deadline every frame (so it's
    // right whatever happened in between: full screen, H, a hidden view).
    const countdownFill = useRef<HTMLDivElement>(null);
    const countdownNow = useRef(countdown);
    countdownNow.current = countdown;
    useEffect(() => {
        if (!active) return;
        let raf = 0;
        const frame = () => {
            const cd = countdownNow.current;
            const fill = countdownFill.current;
            if (cd && fill) {
                const left = Math.max(0, cd.deadline - Date.now());
                fill.style.width = `${(left / (cd.interval * 1000)) * 100}%`;
                // The last 3 seconds pulse.
                fill.dataset.ending = left < 3000 ? "1" : "0";
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [active]);

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

    // ── Hold (Tab, right click or T) ─────────────────────────────────────
    // Stops every lane and enlarges the pointer. Typing replaces the pill's
    // text, searching the tags offered in Sweep (forgiving small typos),
    // with suggestions below (8 at most): Shift+Tab or ↓ steps down, round
    // to the top after the last, ↑ up; Tab, Space, Enter or a click picks.
    // Before typing, the history rolodex: Tab back, Shift+Tab forward, Space
    // picks. Esc lets go (the tag stays). While it's open, letters and
    // digits type, so the strip's hotkeys wait.
    const [picking, setPicking] = useState(false);
    const pickingRef = useRef(false);
    pickingRef.current = picking;
    const [query, setQuery] = useState("");
    // Searching: the front pill shows what's typed (started by typing a
    // letter or digit). Before that, the hold shows the history rolodex.
    const [searchMode, setSearchMode] = useState(false);
    const searchModeRef = useRef(false);
    searchModeRef.current = searchMode;
    const [highlight, setHighlight] = useState(0);
    // The history stack: 0 is the current tag, 1 the one before, and so
    // on. The one at the cursor sits in the main pill's place; up to 2 older
    // ones above it and 2 newer ones below, like a rolodex. Space on the
    // current tag just lets go.
    const [cursor, setCursor] = useState(0);
    const stack = useMemo(() => (tag ? [tag, ...pastTags] : pastTags), [tag, pastTags]);
    // Each lane's direction to carry on with when it closes (stopped stays
    // stopped).
    const resumeMotion = useRef<(1 | 0 | -1)[]>(Array(MAX_LANES).fill(1));
    // Results open above the pointer when it's in the lower half.
    const [resultsAbove, setResultsAbove] = useState(false);
    const matches = useMemo(() => searchTags(query.trim(), allTags), [query, allTags]);
    useEffect(() => setHighlight(0), [query]);

    const openPicker = useCallback(() => {
        if (pickingRef.current) return;
        resumeMotion.current = motionRef.current.map((m) => (m.dir === -1 ? 1 : m.dir));
        applyEdgeRef.current(null, 0, []);
        setMotion((m) => m.map(() => ({ dir: 0, boost: false })));
        setQuery("");
        setSearchMode(false);
        setCursor(0);
        const el = pointerRef.current;
        const boxEl = boxRef.current;
        if (el && boxEl) {
            const r = el.getBoundingClientRect();
            const b = boxEl.getBoundingClientRect();
            setResultsAbove(r.top - b.top > b.height / 2);
        }
        setPicking(true);
        onPickingChange(true);
    }, [onPickingChange]);

    const closePicker = useCallback(
        (picked?: DbTagWithCategory) => {
            if (!pickingRef.current) return;
            setPicking(false);
            setSearchMode(false);
            onPickingChange(false);
            setMotion(resumeMotion.current.map((dir) => ({ dir, boost: false })));
            if (picked) onPickTag(picked);
        },
        [onPickingChange, onPickTag],
    );

    // Typing a letter or digit turns the front pill into the search, right
    // there (the rest of the rolodex goes).
    const startSearch = useCallback((first: string) => {
        setQuery((q) => q + first);
        setSearchMode(true);
    }, []);

    // Leaving (file view, another view) closes it.
    useEffect(() => {
        if (!active) closePicker();
    }, [active, closePicker]);

    // The pointer's lane's file under it: the one the keys act on.
    const activeItem = activeByLane[pointerLane];

    // Caught first (capture) and kept from everything else: the app-wide T,
    // the view's F / H, the strip's own keys.
    // (toggleOn is filled in once it exists, below.)
    const pickState = useRef({
        matches,
        highlight,
        query,
        activeItem,
        toggleOn: (_item: StripItem) => {},
    });
    pickState.current.matches = matches;
    pickState.current.highlight = highlight;
    pickState.current.query = query;
    pickState.current.activeItem = activeItem;
    const stackState = useRef({ stack, cursor });
    stackState.current = { stack, cursor };
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (!pickingRef.current) {
                if ((e.code === "Tab" || e.code === "KeyT") && !isTyping()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (!e.repeat) openPicker();
                }
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            const { matches, highlight, query } = pickState.current;
            const searching = searchModeRef.current;
            const step = (by: 1 | -1) =>
                setHighlight((i) => (matches.length ? (i + by + matches.length) % matches.length : 0));
            const { stack, cursor } = stackState.current;
            if (e.key === "Escape") {
                closePicker();
            } else if (e.code === "Tab" && !searching) {
                // The history stack: Tab further back, Shift+Tab toward now.
                setCursor((c) =>
                    e.shiftKey ? Math.max(c - 1, 0) : Math.min(c + 1, Math.max(0, stack.length - 1)),
                );
            } else if (e.code === "Tab" && e.shiftKey) {
                // Next suggestion, round to the top after the last.
                step(1);
            } else if (e.key === "Enter" || e.code === "Space" || e.code === "Tab") {
                if (e.repeat) return;
                if (searching) {
                    if (matches[highlight]) closePicker(matches[highlight]);
                } else if (cursor > 0) {
                    // An earlier tag: take it and carry on.
                    closePicker(stack[cursor]);
                } else {
                    // The current tag: just let go (its countdown carries on).
                    closePicker();
                }
            } else if (e.key === "ArrowDown") {
                step(1);
            } else if (e.key === "ArrowUp") {
                step(-1);
            } else if (e.key === "Backspace") {
                // Past the last letter: back to the history stack.
                if (query) setQuery((q) => q.slice(0, -1));
                else if (searching) setSearchMode(false);
            } else if (e.key.length === 1) {
                if (searching) setQuery((q) => q + e.key.toLowerCase());
                else startSearch(e.key.toLowerCase());
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active, openPicker, closePicker, startSearch]);

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

    // Toggle the tag on a file (Space: the active one; or a click). Its
    // current tags are read fresh, so any file works.
    // Failsafe: a file that already had the swept tag before we touched it
    // here (added some other way) isn't untagged by the first click or
    // Space: that just flashes as if adding it. The second one removes it.
    // Tags added here come off in one, as usual. Per tag: a new tag starts
    // over.
    const addedHere = useRef(new Set<number>());
    const confirmed = useRef(new Set<number>());
    useEffect(() => {
        addedHere.current = new Set();
        confirmed.current = new Set();
    }, [tag?.id]);

    const toggleOn = useCallback(
        async (item: StripItem) => {
            const tag = applyTag;
            if (!tag) return;
            const current = await window.api.getTags(item.file.id);
            const has = current.find((t) => t.id === tag.id);
            const state: TagState = has ? (has.inherited ? "inherited" : "own") : null;
            const flash = (kind: "on" | "already" | "denied") => {
                const n = ++flashCount.current;
                setFlashes((f) => ({ ...f, [item.key]: { kind, n } }));
            };
            const id = item.file.id;
            if (state === "own" && !addedHere.current.has(id) && !confirmed.current.has(id)) {
                confirmed.current.add(id);
                flash("already");
                return;
            }
            const ok = await toggleSweptTag(item.file, tag, state);
            if (ok && state === null) addedHere.current.add(id);
            if (ok && state === "own") {
                addedHere.current.delete(id);
                confirmed.current.delete(id);
            }
            if (!ok) flash("denied");
            else if (state === null) flash("on");
        },
        [applyTag],
    );
    pickState.current.toggleOn = toggleOn;

    const rotateLeftRef = useRef(rotateLeft);
    rotateLeftRef.current = rotateLeft;
    const onTileClick = useCallback(
        (item: StripItem) => (pickingRef.current ? closePicker() : toggleOn(item)),
        [closePicker, toggleOn],
    );

    // Keys
    const state = useRef({ activeItem, toggleOn, speed });
    state.current = { activeItem, toggleOn, speed };
    // The lanes a held 1 / 3 started on (letting go affects the same ones).
    const heldLanes = useRef<{ one: number[]; three: number[] }>({ one: [], three: [] });
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping() || pickingRef.current) return;
            const { activeItem, toggleOn, speed } = state.current;
            switch (e.code) {
                case "Space":
                    e.preventDefault();
                    if (!e.repeat && activeItem) toggleOn(activeItem);
                    break;
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
                case "Backquote":
                    e.preventDefault();
                    if (!e.repeat) onReroll();
                    break;
                case "KeyG":
                    e.preventDefault();
                    if (!e.repeat && activeItem) onInspect(activeItem.file);
                    break;
                case "Digit1": {
                    // Fast reverse while held (forward again on release).
                    e.preventDefault();
                    if (e.repeat) return;
                    const lanes = targetLanes();
                    heldLanes.current.one = lanes;
                    setLaneMotion(lanes, { dir: -1, boost: true });
                    break;
                }
                case "Digit6":
                    // Stop (the lane under the cursor, or all of them).
                    e.preventDefault();
                    setLaneMotion(targetLanes(), { dir: 0, boost: false });
                    break;
                case "Digit3": {
                    e.preventDefault();
                    if (e.repeat) return;
                    const lanes = targetLanes();
                    heldLanes.current.three = lanes;
                    setLaneMotion(lanes, { dir: 1, boost: true });
                    break;
                }
                case "Digit2":
                    // The pointer down a lane (wrapping), same height in it.
                    e.preventDefault();
                    if (e.repeat || laneCountRef.current < 2) return;
                    laneOffset.current = (laneOffset.current + 1) % laneCountRef.current;
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
                    // Scrub the active video, as everywhere else.
                    e.preventDefault();
                    const video = activeItem ? videoEls.current.get(activeItem.key) : undefined;
                    if (video) stepVideo(video, e.code === "KeyQ" || e.code === "ArrowLeft" ? -1 : 1);
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
            if (e.code === "Digit3") setLaneMotion(heldLanes.current.three, { boost: false });
            if (e.code === "Digit1") setLaneMotion(heldLanes.current.one, { dir: 1, boost: false });
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
    }, [active, onCompare, onSpeed, onReroll, onInspect, sweepAllLanes]);

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
                if (!last || last.x !== e.screenX || last.y !== e.screenY) laneOffset.current = 0;
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
                if (pickingRef.current) closePicker();
                else openPicker();
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
                {/* Enlarged while picking, growing away from the tip. */}
                <div
                    className={`flex flex-col items-center transition-transform duration-150 ${
                        picking ? "scale-[1.25]" : ""
                    } ${mouseX.current == null ? "origin-top" : "origin-bottom"}`}
                >
                <div className="relative mt-2 flex flex-col items-stretch">
                {/* The history stack, a rolodex over the main pill: the tag
                    at the cursor in its place, up to 2 older ones above and
                    (after Tab) up to 2 newer ones below, smaller the further
                    they are. Each keeps its element, so moving the cursor rolls them. */}
                {picking && !searchMode &&
                    stack.map((t, i) => {
                        const slot = i - cursor;
                        if (slot < -STACK_SHOWN - 1 || slot > STACK_SHOWN + 1) return null;
                        return (
                            <div
                                key={t.id}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    // The current one just lets go.
                                    closePicker(i === 0 ? undefined : t);
                                }}
                                title={i === 0 ? "Keep this tag" : "Back to this tag (Space)"}
                                className={`pointer-events-auto absolute left-1/2 top-0 flex min-w-[5rem] cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium shadow-lg backdrop-blur ${
                                    slot === 0
                                        ? "bg-neutral-900 text-neutral-100 ring-1 ring-white/50"
                                        : "bg-neutral-900 text-neutral-400"
                                }`}
                                style={stackSlotStyle(slot)}
                            >
                                {t.category && (
                                    <span
                                        className="rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none"
                                        style={{ color: t.category.color }}
                                    >
                                        {t.category.icon}
                                    </span>
                                )}
                                {i === 0 && onFile ? `✓ ${t.name}` : t.name}
                            </div>
                        );
                    })}
                <div
                    style={
                        // In the hold's stack view the stack shows its own
                        // pill here; this one keeps the place.
                        picking && !searchMode ? { visibility: "hidden" } : undefined
                    }
                    // min-w: one typed letter mustn't shrink it to a dot.
                    className={`relative flex min-w-[5rem] items-center justify-center gap-1.5 overflow-hidden rounded-full px-3 py-1 text-xs font-medium shadow-lg backdrop-blur transition-colors ${
                        picking
                            ? "bg-neutral-900 text-neutral-100 ring-1 ring-white/50"
                            : onFile && !rolling
                              ? "bg-neutral-100 text-neutral-900"
                              : "bg-black/70 text-neutral-200"
                    } ${onFile?.inherited && !rolling && !picking ? "opacity-60" : ""}`}
                    title={
                        onFile?.inherited
                            ? onFile.inheritedVia
                                ? `Comes with "${onFile.inheritedVia}"`
                                : "From the folder's tags"
                            : undefined
                    }
                >
                    {picking && searchMode ? (
                        // What's typed, live (the pill is the search).
                        <span className="flex items-center">
                            <span>{query}</span>
                            <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-neutral-200" />
                        </span>
                    ) : (() => {
                        const shown = rolling ?? tag;
                        return (
                            <>
                                {shown?.category && (
                                    // Dark backing: the label turns white, and so are some category colors.
                                    <span className="rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none" style={{ color: shown.category.color }}>
                                        {shown.category.icon}
                                    </span>
                                )}
                                {rolling
                                    ? rolling.name
                                    : tag
                                      ? onFile
                                          ? `✓ ${tag.name}`
                                          : tag.name
                                      : "pick a tag"}
                            </>
                        );
                    })()}
                </div>
                {/* Time left until the next random tag (as wide as the label) */}
                {countdown && !rolling && !picking && (
                    <div className="mx-2 mt-1 h-1.5 overflow-hidden rounded-full bg-black/60 shadow">
                        <div
                            ref={countdownFill}
                            className="sweep-countdown-fill h-full rounded-full bg-neutral-200"
                            style={{ width: "100%" }}
                        />
                    </div>
                )}
                </div>
                {/* Hidden in the hold (still taking its space, so nothing shifts). */}
                <svg width="22" height="14" viewBox="0 0 22 14" className={`drop-shadow ${picking ? "invisible" : ""}`}>
                    <path d="M1 1 H21 L11 13 Z" fill={onFile && !picking ? "#f5f5f5" : "rgba(0,0,0,0.7)"} stroke="#f5f5f5" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
                </div>

                {/* Suggestions, while something's typed */}
                {picking && searchMode && query && (
                    <div
                        className={`pointer-events-auto absolute left-1/2 min-w-[12rem] -translate-x-1/2 overflow-hidden rounded-md border border-neutral-700 bg-neutral-950/95 text-xs shadow-xl backdrop-blur ${
                            resultsAbove ? "bottom-full mb-2" : "top-full mt-2"
                        }`}
                    >
                        {matches.length > 0 ? (
                            matches.map((t, i) => (
                                <button
                                    key={t.id}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        closePicker(t);
                                    }}
                                    onMouseEnter={() => setHighlight(i)}
                                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                                        i === highlight ? "bg-neutral-800 text-white" : "text-neutral-300"
                                    }`}
                                >
                                    <span className="w-3 text-center text-[10px]" style={{ color: t.category?.color }}>
                                        {t.category?.icon ?? ""}
                                    </span>
                                    {t.name}
                                </button>
                            ))
                        ) : (
                            <div className="px-3 py-2 text-neutral-500">No tags match</div>
                        )}
                    </div>
                )}
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
            // Snappy into and out of fast forward; gentle for everything else.
            const ease = motion.boost || depth > 0 || pickingRef.current || Math.abs(v) > cruise * 1.5 ? 12 : 4;
            velocities.current[index] = v + (target - v) * Math.min(1, dt * ease);
            offset.current -= velocities.current[index] * dt;
            if (rowRef.current) rowRef.current.style.transform = `translateX(${offset.current}px)`;

            const list = itemsRef.current;
            const pointer = mouseX.current ?? width * POINTER_AT;
            let x = offset.current;
            let under = -1;
            let first = list.length;
            let lastIdx = -1;
            list.forEach((it, i) => {
                const w = widthOf(it);
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
    ["Esc / right click", "let go of the hold (Esc also leaves full screen)"],
    ["hold 1", "rewind"],
    ["6", "stop"],
    ["3", "go (hold: faster)"],
    ["4 / 5, scroll", "slower / faster"],
    ["+ / −", "add a lane below / remove the bottom one (up to 3)"],
    ["2", "pointer to the next lane (same height in it)"],
    ["`", "new random tag"],
    ["Q / E", "scrub the video back / forward"],
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
