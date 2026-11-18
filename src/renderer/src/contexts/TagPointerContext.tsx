import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type { DbFile, DbTagWithCategory } from "@renderer/shared/types/types";
import { useTags } from "./TagsContext";
import { useSettings } from "./SettingsContext";
import { publishFileTags } from "@renderer/hooks/useFileTags";
import { isTyping } from "@renderer/lib/keys";
import { byTagOrder } from "@renderer/lib/tagGroups";

// The tag pointer: one tag carried on the cursor wherever it's over media
// (Sweep, Compare, the scroll and single file views; not Browse's grid).
// The same keys everywhere a pointer surface is active:
//   Space  toggle the tag on the file under the pointer
//   Tab / T (or right click on media)  hold: the picker. Tab steps back
//     through earlier tags, Shift+Tab forward, Space picks; or type to
//     search. Tab (or T) held + 1 / 2 / 3: same category / related / not
//     offered. Esc (or right click) lets go.
//   `  new random tag (and, with Random on, a new one every interval)
//   H  put the pointer away (no pointer, nothing counted) / bring it back
// Coverage: while a tag is up, time a file is really looked at with it
// counts toward a "no" (see sweep coverage). Only Sweep counts it (its lanes
// report their own time); the other views count nothing.

/** Offered in the tag pointer: on itself, and its category (if any) too. */
export function inTagPointer(t: DbTagWithCategory): boolean {
    return !!t.sweep && (!t.category || !!t.category.sweep);
}

export type FlashKind = "on" | "already" | "denied";

/** The file under the pointer, as a surface reports it. */
export interface PointerTarget {
    file: DbFile;
    /** Sweep draws its own pointer (it has lanes and a resting spot);
     *  everywhere else the cursor overlay draws it. */
    ownPointer?: boolean;
    /** Feedback after a toggle (Sweep flashes the tile). */
    onFlash?: (kind: FlashKind) => void;
    /** The pointer's height on screen (px), for which way search results
     *  open. Default: the mouse. */
    anchorY?: () => number | null;
    /** Off Sweep: draw the pointer here (screen px) instead of on the
     *  mouse, e.g. moved to Compare's other side by 1 / 3. */
    pointAt?: { x: number; y: number };
}

type ListMode = "category" | "related" | "excluded";

/** Stepping through the history rolodex, resting this long (ms) on an
 *  earlier tag picks it (Space picks at once). So Tab, Tab goes back to
 *  the previous tag. */
const HISTORY_PICK_MS = 2000;
/** The same in the Tab + 1 / 2 / 3 lists. */
const LIST_PICK_MS = HISTORY_PICK_MS;
/** Tab+3's front card: "search…" (typing there searches the excluded tags). */
export const SEARCH_CARD = { id: -1, name: "search…" } as DbTagWithCategory;

/** Coverage: time seen is saved this often (and on tag change, leaving or
 *  the window losing focus). */
const CHECK_FLUSH_MS = 5000;
/** Lean-back guard: time seen since the last input is dropped once this
 *  many different files have gone by without one, and at least this long
 *  has passed. Generous on purpose: a missed "no" gets collected another
 *  time, a wrong one makes coverage look further along than it is. Counted
 *  in files, so it scales with Sweep's speed, lanes and tile widths. */
const IDLE_FILES = 30;
const IDLE_MIN_MS = 20000;

/**
 * The picker's search: tags matching `q`, best first, at most 8. Forgiving,
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

interface TagPointerValue {
    /** A pointer surface is active (the keys work). */
    enabled: boolean;
    /** The tag being carried (null: none picked). */
    tag: DbTagWithCategory | null;
    /** Tags offered in the pointer, and the rest (Tab+3 reaches them). */
    offeredTags: DbTagWithCategory[];
    excludedTags: DbTagWithCategory[];
    /** H: put away. No pointer drawn, nothing counted, nothing tagged, no
     *  rerolls (random pauses). Tab / T / right click bring it back. */
    hidden: boolean;
    /** The tag a press applies: the one on screen (the old one mid-roll). */
    applyTag: DbTagWithCategory | null;
    /** Mid-reroll: tag names flicking past (null otherwise). */
    rolling: DbTagWithCategory | null;
    /** Random on: when the next reroll fires, for the countdown bar. */
    countdown: { deadline: number; interval: number } | null;
    reroll: () => void;
    // ── Picker ──
    picking: boolean;
    pickingRef: React.MutableRefObject<boolean>;
    openPicker: () => void;
    closePicker: (picked?: DbTagWithCategory) => void;
    togglePicker: () => void;
    query: string;
    searchMode: boolean;
    setSearchMode: (on: boolean) => void;
    highlight: number;
    setHighlight: (i: number) => void;
    matches: DbTagWithCategory[];
    stack: DbTagWithCategory[];
    cursor: number;
    listMode: ListMode | null;
    listItems: DbTagWithCategory[];
    listIndex: number;
    /** Related tags, null while loading. */
    related: DbTagWithCategory[] | null;
    pickFill: { seq: number; ms: number } | null;
    resultsAbove: boolean;
    // ── Target ──
    target: PointerTarget | null;
    setTarget: (t: PointerTarget | null) => void;
    /** Clears the target if it's still `t` (a later one wins). */
    clearTarget: (t: PointerTarget) => void;
    /** Space or a click: toggle the tag on a file. */
    toggleTagOn: (file: DbFile) => Promise<FlashKind | null>;
    // ── Coverage ──
    /** The tag time counts for right now (null: nothing counts). */
    checkTagId: React.MutableRefObject<number | null>;
    /** Sweep's lanes: time a file was really watched with the tag up. */
    addSeen: (fileId: number, seconds: number) => void;
    // ── Surfaces ──
    registerSurface: () => () => void;
    // ── Pass mode ──
    /** A Sweep pass is running: its tag replaces the carried one, the
     *  picker only reorders the job's tags, and nothing random happens. */
    passMode: PassPointer | null;
    setPassMode: (p: PassPointer | null) => void;
}

/** What a running pass hands the pointer. */
export interface PassPointer {
    /** The tag being passed on (null: on the end card). */
    tagId: number | null;
    /** The job's tags still to come, in order. */
    upcoming: number[];
    /** A pair's upper tag (V), by its lower tag, for the current tag and
     *  those to come: the picker shows both. */
    partners: Record<number, number>;
    /** Picked in the picker: that tag comes up now, the current one goes
     *  to the end of the queue. */
    onPick: (tagId: number) => void;
}

const TagPointerContext = createContext<TagPointerValue | null>(null);

export function useTagPointer(): TagPointerValue {
    const v = useContext(TagPointerContext);
    if (!v) throw new Error("useTagPointer outside TagPointerProvider");
    return v;
}

/** A view that shows media with the pointer over it: while `active`, the
 *  pointer's keys work. */
export function useTagPointerSurface(active: boolean): void {
    const { registerSurface } = useTagPointer();
    useEffect(() => {
        if (!active) return;
        return registerSurface();
    }, [active, registerSurface]);
}

/** A toggle's feedback on the media, `n` counting so each one restarts. */
/** "skip": a pass's 2 (no answer), flashed across its whole lane. */
export type MediaFlashState = { kind: FlashKind | "skip"; n: number } | null;

/** While the pointer shows over media, the cursor hides (the pointer's
 *  triangle stands in for it), over everything in it too. */
export function usePointerCursorClass(active: boolean): string {
    const { enabled, hidden, picking } = useTagPointer();
    return active && enabled && !hidden && !picking ? "cursor-none [&_*]:!cursor-none" : "";
}

/**
 * For a piece of media off Sweep: hovering it makes `file` the pointer's
 * target (Space toggles on it, its time counts), right click holds the
 * picker, and the cursor hides (the overlay draws the pointer in its place).
 * `flash`: the last toggle's feedback, for <MediaFlash>.
 */
export function usePointerTarget(
    file: DbFile | null,
    active: boolean,
): {
    handlers: {
        onMouseEnter: () => void;
        onMouseLeave: () => void;
        onContextMenu: (e: React.MouseEvent) => void;
    };
    cursorClass: string;
    flash: MediaFlashState;
} {
    const { setTarget, clearTarget, togglePicker } = useTagPointer();
    const cursorClass = usePointerCursorClass(active);
    const hovered = useRef(false);
    const [flash, setFlash] = useState<MediaFlashState>(null);
    const target = useMemo<PointerTarget | null>(
        () =>
            file
                ? { file, onFlash: (kind) => setFlash((f) => ({ kind, n: (f?.n ?? 0) + 1 })) }
                : null,
        [file],
    );
    const current = useRef<PointerTarget | null>(null);
    useEffect(() => {
        const prev = current.current;
        if (hovered.current && active && target) {
            current.current = target;
            setTarget(target);
        } else if (prev) {
            current.current = null;
            clearTarget(prev);
        }
    }, [target, active, setTarget, clearTarget]);
    useEffect(
        () => () => {
            if (current.current) clearTarget(current.current);
        },
        [clearTarget],
    );
    return {
        handlers: {
            onMouseEnter: () => {
                hovered.current = true;
                if (active && target) {
                    current.current = target;
                    setTarget(target);
                }
            },
            onMouseLeave: () => {
                hovered.current = false;
                if (current.current) clearTarget(current.current);
                current.current = null;
            },
            onContextMenu: (e) => {
                if (!active) return;
                e.preventDefault();
                togglePicker();
            },
        },
        cursorClass,
        flash,
    };
}

export function TagPointerProvider({ children }: { children: React.ReactNode }) {
    const { allTags: everyTag, tagMap } = useTags();
    const {
        sweepTagId,
        setSweepTagId,
        sweepRandom,
        sweepInterval,
    } = useSettings();

    const offeredTags = useMemo(() => everyTag.filter(inTagPointer), [everyTag]);
    const excludedTags = useMemo(() => everyTag.filter((t) => !inTagPointer(t)), [everyTag]);

    // A running pass: its tag is carried instead of Sweep's, and there's
    // no randomness (no `, no rerolls), no H, no Tab+1/2/3.
    const [passMode, setPassModeState] = useState<PassPointer | null>(null);
    const passRef = useRef<PassPointer | null>(null);
    passRef.current = passMode;

    const tag = passMode
        ? passMode.tagId != null
            ? (tagMap.get(passMode.tagId) ?? null)
            : null
        : sweepTagId != null
          ? (tagMap.get(sweepTagId) ?? null)
          : null;

    // ── Surfaces ─────────────────────────────────────────────────────────
    const [surfaces, setSurfaces] = useState(0);
    const registerSurface = useCallback(() => {
        setSurfaces((n) => n + 1);
        return () => setSurfaces((n) => n - 1);
    }, []);
    const enabled = surfaces > 0;

    const [hidden, setHidden] = useState(false);
    const hiddenRef = useRef(false);
    hiddenRef.current = hidden;
    // The pointer is always on in a pass.
    const setPassMode = useCallback((p: PassPointer | null) => {
        if (p) setHidden(false);
        setPassModeState(p);
    }, []);

    const [picking, setPicking] = useState(false);
    const pickingRef = useRef(false);
    pickingRef.current = picking;

    // ── Target ───────────────────────────────────────────────────────────
    const [target, setTargetState] = useState<PointerTarget | null>(null);
    const targetRef = useRef<PointerTarget | null>(null);
    // Left while the picker was open: cleared once it closes (so the
    // overlay stays to click a result).
    const leftWhilePicking = useRef(false);
    const setTarget = useCallback((t: PointerTarget | null) => {
        leftWhilePicking.current = false;
        targetRef.current = t;
        setTargetState(t);
    }, []);
    const clearTarget = useCallback((t: PointerTarget) => {
        if (targetRef.current !== t) return;
        if (pickingRef.current && !t.ownPointer) {
            leftWhilePicking.current = true;
            return;
        }
        targetRef.current = null;
        setTargetState(null);
    }, []);

    // The mouse, for which way search results open.
    const mouseY = useRef(0);
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            mouseY.current = e.clientY;
        };
        window.addEventListener("mousemove", onMove, true);
        return () => window.removeEventListener("mousemove", onMove, true);
    }, []);

    // ── Tag, history, random ─────────────────────────────────────────────
    const [rolledAt, setRolledAt] = useState(0);
    // Tags carried before this one, most recent last, for going back.
    const tagHistory = useRef<number[]>([]);
    // Counts rerolls, so the pointer can play its roll animation.
    const [rollSeq, setRollSeq] = useState(0);
    const reroll = useCallback(() => {
        if (passRef.current) return;
        const pool = offeredTags.filter((t) => t.id !== sweepTagId);
        if (pool.length === 0) return;
        if (sweepTagId != null) tagHistory.current.push(sweepTagId);
        setSweepTagId(pool[Math.floor(Math.random() * pool.length)].id);
        setRolledAt(Date.now());
        setRollSeq((n) => n + 1);
    }, [offeredTags, sweepTagId, setSweepTagId]);

    // Random on with nothing (or a deleted tag) to carry: pick one now.
    useEffect(() => {
        if (sweepRandom && !passMode && !tag && offeredTags.length > 0) reroll();
    }, [sweepRandom, passMode, tag, offeredTags.length, reroll]);

    // Random toggled or the interval changed: count from now.
    const firstRandom = useRef(true);
    useEffect(() => {
        if (firstRandom.current) {
            firstRandom.current = false;
            return;
        }
        setRolledAt(Date.now());
    }, [sweepRandom, sweepInterval]);

    // Reroll on the interval, counted from the last pick, while a surface
    // is up. `deadline` is when it'll fire, for the countdown bar. The
    // picker and putting the pointer away (H) pause it: the tag never
    // changes out of sight. Cancelling the picker or coming back resumes
    // where it was; picking starts a full countdown.
    const [deadline, setDeadline] = useState<number | null>(null);
    const deadlineRef = useRef<number | null>(null);
    deadlineRef.current = deadline;
    const pausedLeft = useRef<number | null>(null);
    useEffect(() => {
        if (!sweepRandom || passMode || !enabled || picking || hidden) {
            if ((picking || hidden) && deadlineRef.current != null) {
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
    }, [sweepRandom, passMode, enabled, picking, hidden, sweepInterval, rolledAt, reroll]);

    const pickTag = useCallback(
        (t: DbTagWithCategory) => {
            // In a pass, picking reorders the job (the run decides the tag).
            const pass = passRef.current;
            if (pass) {
                if (t.id !== pass.tagId) pass.onPick(t.id);
                return;
            }
            pausedLeft.current = null;
            if (sweepTagId != null && sweepTagId !== t.id) tagHistory.current.push(sweepTagId);
            setSweepTagId(t.id);
            setRolledAt(Date.now());
        },
        [sweepTagId, setSweepTagId],
    );

    // Earlier tags, most recent first, each once, leaving out the current
    // one and any since deleted: the picker's history stack. Read while
    // rendering (it only changes with the tag).
    const pastTags = (() => {
        // In a pass, the "history" is the job's tags still to come.
        if (passMode) {
            return passMode.upcoming
                .map((id) => tagMap.get(id))
                .filter((t): t is DbTagWithCategory => !!t);
        }
        const out: DbTagWithCategory[] = [];
        const seenIds = new Set<number>(sweepTagId != null ? [sweepTagId] : []);
        const h = tagHistory.current;
        for (let i = h.length - 1; i >= 0 && out.length < 50; i--) {
            if (seenIds.has(h[i])) continue;
            seenIds.add(h[i]);
            // Any tag still there, including one picked through Tab+3.
            const t = tagMap.get(h[i]);
            if (t) out.push(t);
        }
        return out;
    })();

    // Reroll animation: tag names flick past, slowing down, then it lands
    // on the new tag. Until it lands, presses still use the tag that was
    // showing before: the new one hasn't been seen yet.
    const [rolling, setRolling] = useState<DbTagWithCategory | null>(null);
    const [rollFrom, setRollFrom] = useState<DbTagWithCategory | null>(null);
    const shownTag = useRef(tag);
    const firstRoll = useRef(rollSeq);
    useEffect(() => {
        if (rollSeq === firstRoll.current || offeredTags.length < 2) return;
        setRollFrom(shownTag.current);
        const steps = [40, 45, 50, 60, 70, 85, 105, 130, 160];
        const timers: ReturnType<typeof setTimeout>[] = [];
        let at = 0;
        steps.forEach((delay) => {
            at += delay;
            timers.push(
                setTimeout(
                    () => setRolling(offeredTags[Math.floor(Math.random() * offeredTags.length)]),
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
    const applyTag = rollFrom ?? tag;
    const applyTagRef = useRef(applyTag);
    applyTagRef.current = applyTag;

    // ── Toggle ───────────────────────────────────────────────────────────
    // Failsafe: a file that already had the tag before the pointer touched
    // it (added some other way) isn't untagged by the first press: that
    // just flashes as if adding it. The second one removes it. Tags added
    // with the pointer come off in one, as usual. A new tag starts over.
    const addedHere = useRef(new Set<number>());
    const confirmed = useRef(new Set<number>());
    useEffect(() => {
        addedHere.current = new Set();
        confirmed.current = new Set();
    }, [tag?.id]);
    const toggleTagOn = useCallback(async (file: DbFile): Promise<FlashKind | null> => {
        // Put away (H): no tagging by any route (Space, a click on a tile),
        // since the tag can't be seen.
        if (hiddenRef.current) return null;
        const t = applyTagRef.current;
        if (!t) return null;
        const current = await window.api.getTags(file.id);
        const has = current.find((x) => x.id === t.id);
        const state = has ? (has.inherited ? "inherited" : "own") : null;
        const id = file.id;
        if (state === "inherited") return "denied";
        if (state === "own" && !addedHere.current.has(id) && !confirmed.current.has(id)) {
            confirmed.current.add(id);
            return "already";
        }
        const next =
            state === "own"
                ? await window.api.removeTag(file.id, t.name)
                : await window.api.addTag(file.id, t.name);
        publishFileTags(file.id, next);
        if (state === null) {
            // Refused: the file's folder rules the tag out.
            if (!next.some((x) => x.id === t.id)) return "denied";
            addedHere.current.add(id);
            return "on";
        }
        addedHere.current.delete(id);
        confirmed.current.delete(id);
        return null;
    }, []);
    const toggleTarget = useCallback(async () => {
        const t = targetRef.current;
        if (!t) return;
        const kind = await toggleTagOn(t.file);
        if (kind) t.onFlash?.(kind);
    }, [toggleTagOn]);

    // ── Picker ───────────────────────────────────────────────────────────
    // Typing replaces the pill's text, searching the offered tags
    // (forgiving small typos), with suggestions (8 at most): Shift+Tab or ↓
    // steps down, round to the top after the last, ↑ up; Tab, Space, Enter
    // or a click picks. Before typing, the history rolodex: Tab back,
    // Shift+Tab forward, Space picks. Esc lets go (the tag stays). While
    // it's open, letters and digits type, so every other key waits.
    const [query, setQuery] = useState("");
    const [searchMode, setSearchMode] = useState(false);
    const searchModeRef = useRef(false);
    searchModeRef.current = searchMode;
    const [highlight, setHighlight] = useState(0);
    // The history stack: 0 is the current tag, 1 the one before, and so on.
    const [cursor, setCursor] = useState(0);
    const stack = useMemo(() => (tag ? [tag, ...pastTags] : pastTags), [tag, pastTags]);
    // Holding Tab (or T), a digit opens a list, a rolodex of its own that
    // stays open: 1 the current tag's category, 2 tags often on the same
    // files, 3 the tags not offered (with a "search…" card). In it, Tab /
    // Shift+Tab move, resting on a tag or Space picks, Esc leaves as it was.
    const [listMode, setListMode] = useState<ListMode | null>(null);
    const listModeRef = useRef<ListMode | null>(null);
    listModeRef.current = listMode;
    const [listIndex, setListIndex] = useState(0);
    // Hold keys down right now (Tab, or the T that opened it): with one
    // held, 1 / 2 / 3 open the lists.
    const heldKeys = useRef(new Set<string>());
    // Resting on an earlier tag in the rolodex picks it when this fires.
    const doubleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Drawn as a fill across the front card while it runs (seq restarts it).
    const [pickFill, setPickFill] = useState<{ seq: number; ms: number } | null>(null);
    const startRest = (ms: number, pick: () => void) => {
        if (doubleTimer.current) clearTimeout(doubleTimer.current);
        setPickFill((f) => ({ seq: (f?.seq ?? 0) + 1, ms }));
        doubleTimer.current = setTimeout(() => {
            doubleTimer.current = null;
            pick();
        }, ms);
    };
    const cancelDouble = useCallback(() => {
        if (doubleTimer.current) clearTimeout(doubleTimer.current);
        doubleTimer.current = null;
        setPickFill(null);
    }, []);
    // 1: the current tag's category (no category: the other uncategorized
    // tags), in Tag Manager order, starting after the current tag. A tag
    // that isn't offered (picked through Tab+3) gets its whole category,
    // excluded ones too: often the category itself is excluded.
    const categoryList = useMemo(() => {
        if (!tag) return [];
        const offered = offeredTags.some((t) => t.id === tag.id);
        const pool = offered ? offeredTags : [...offeredTags, ...excludedTags];
        const same = pool
            .filter((t) => (t.category_id ?? null) === (tag.category_id ?? null))
            .sort(byTagOrder);
        const at = same.findIndex((t) => t.id === tag.id);
        const from = at >= 0 ? [...same.slice(at + 1), ...same.slice(0, at)] : same;
        return from.filter((t) => t.id !== tag.id);
    }, [tag, offeredTags, excludedTags]);
    // Fetched when the picker opens: tag ids most often on the same files as
    // the current tag (null while loading), and every tag by how many files
    // have it.
    const [relatedIds, setRelatedIds] = useState<number[] | null>(null);
    const [usageIds, setUsageIds] = useState<number[]>([]);
    useEffect(() => {
        if (!picking) return;
        let stale = false;
        setRelatedIds(tag ? null : []);
        if (tag) {
            window.api.getRelatedTags(tag.id).then((rows) => {
                if (!stale) setRelatedIds(rows.map((r) => r.id).filter((id) => id !== tag.id));
            });
        }
        window.api.getMostUsedTags().then((rows) => {
            if (!stale) setUsageIds(rows.map((r) => r.id));
        });
        return () => {
            stale = true;
        };
    }, [picking, tag]);
    // 2: the related ones that are offered.
    const related = useMemo(() => {
        if (relatedIds === null) return null;
        const offered = new Map(offeredTags.map((t) => [t.id, t]));
        return relatedIds
            .map((id) => offered.get(id))
            .filter((t): t is DbTagWithCategory => !!t)
            .slice(0, 30);
    }, [relatedIds, offeredTags]);
    // 3: the excluded ones, related to the current tag first, then the most
    // used, then the rest alphabetically.
    const excludedRanked = useMemo(() => {
        const rank = new Map<number, number>();
        (relatedIds ?? []).forEach((id, i) => rank.set(id, i));
        const used = new Map<number, number>();
        usageIds.forEach((id, i) => used.set(id, i));
        return [...excludedTags].sort((a, b) => {
            const ra = rank.get(a.id) ?? Infinity;
            const rb = rank.get(b.id) ?? Infinity;
            if (ra !== rb) return ra - rb;
            const ua = used.get(a.id) ?? Infinity;
            const ub = used.get(b.id) ?? Infinity;
            if (ua !== ub) return ua - ub;
            return a.name.localeCompare(b.name);
        });
    }, [excludedTags, relatedIds, usageIds]);
    // Like the history rolodex, the current tag stays in front (0) and the
    // list rises behind it. Tab+3 the same way, with a "search…" card in
    // front of the excluded tags; typing there searches them.
    const listItems = useMemo(() => {
        if (listMode === "excluded") return [SEARCH_CARD, ...excludedRanked];
        const list =
            listMode === "category" ? categoryList : listMode === "related" ? (related ?? []) : [];
        return tag && listMode ? [tag, ...list] : list;
    }, [listMode, categoryList, related, tag, excludedRanked]);
    // Results open above the pointer when it's in the lower half.
    const [resultsAbove, setResultsAbove] = useState(false);
    const passTags = useMemo(
        () =>
            passMode
                ? passMode.upcoming
                      .map((id) => tagMap.get(id))
                      .filter((t): t is DbTagWithCategory => !!t)
                : [],
        [passMode, tagMap],
    );
    const matches = useMemo(() => {
        // In a pass, search finds only the job's tags still to come (a pair
        // by either of its tags).
        if (passMode) {
            const uppers = passTags
                .map((t) => {
                    const up = passMode.partners[t.id];
                    const ut = up != null ? tagMap.get(up) : undefined;
                    return ut ? { ...ut, lower: t } : null;
                })
                .filter((x): x is DbTagWithCategory & { lower: DbTagWithCategory } => !!x);
            const hits = searchTags(query.trim(), [...passTags, ...uppers]);
            const out: DbTagWithCategory[] = [];
            for (const h of hits) {
                const lower = (h as { lower?: DbTagWithCategory }).lower ?? h;
                if (!out.some((x) => x.id === lower.id)) out.push(lower);
            }
            return out;
        }
        if (listMode !== "excluded") return searchTags(query.trim(), offeredTags);
        // Tab+3: the excluded tags, best suggestions first, until typing.
        if (!query.trim()) return excludedRanked.slice(0, 8);
        return searchTags(query.trim(), excludedTags);
    }, [query, offeredTags, excludedTags, excludedRanked, listMode, passMode, passTags, tagMap]);
    useEffect(() => setHighlight(0), [query]);

    const openPicker = useCallback(() => {
        if (pickingRef.current) return;
        // Opening it (Tab / T, right click) brings a put-away pointer back.
        if (hiddenRef.current) setHidden(false);
        setQuery("");
        setSearchMode(false);
        setCursor(0);
        setListMode(null);
        setListIndex(0);
        cancelDouble();
        const y = targetRef.current?.anchorY?.() ?? mouseY.current;
        setResultsAbove(y > window.innerHeight / 2);
        pickingRef.current = true;
        setPicking(true);
    }, [cancelDouble]);

    const closePicker = useCallback(
        (picked?: DbTagWithCategory) => {
            if (!pickingRef.current) return;
            cancelDouble();
            pickingRef.current = false;
            setPicking(false);
            setSearchMode(false);
            setListMode(null);
            if (leftWhilePicking.current) {
                leftWhilePicking.current = false;
                targetRef.current = null;
                setTargetState(null);
            }
            if (picked) pickTag(picked);
        },
        [pickTag, cancelDouble],
    );
    const togglePicker = useCallback(() => {
        if (pickingRef.current) closePicker();
        else openPicker();
    }, [openPicker, closePicker]);

    // Typing a letter or digit turns the front pill into the search, right
    // there (the rest of the rolodex goes).
    const startSearch = useCallback(
        (first: string) => {
            cancelDouble();
            setQuery((q) => q + first);
            setSearchMode(true);
            setListMode(null);
        },
        [cancelDouble],
    );

    // No surface up (another view): it closes.
    useEffect(() => {
        if (!enabled) closePicker();
    }, [enabled, closePicker]);

    // ── Coverage: time seen ──────────────────────────────────────────────
    // Saved as raw seconds; what counts as a "no" is decided when reading.
    // Nothing counts with no tag, the picker open, the pointer put away or
    // mid-reroll. Lean-back guard: time since the last input (a key, click,
    // scroll or mouse movement) is only provisional. The next input
    // confirms it; if IDLE_FILES files go by first (and IDLE_MIN_MS
    // passes), it's dropped and nothing counts until the next input.
    const checkTagId = useRef<number | null>(null);
    checkTagId.current = tag && !picking && !hidden && !rollFrom ? tag.id : null;
    type SeenByTag = Map<number, Map<number, number>>; // tag → file → seconds
    const pending = useRef<SeenByTag>(new Map());
    const pendingFiles = useRef(new Set<number>());
    const queued = useRef<SeenByTag>(new Map());
    const lastInput = useRef(Date.now());
    const idle = useRef(false);
    const flushSeen = useCallback(() => {
        const byTag = queued.current;
        if (byTag.size === 0) return;
        queued.current = new Map();
        for (const [tagId, seen] of byTag) {
            const entries = [...seen].map(([fileId, seconds]) => ({ fileId, seconds }));
            window.api.addTagCheckSeconds(tagId, entries).catch(() => {});
        }
    }, []);
    const dropPending = useCallback(() => {
        pending.current = new Map();
        pendingFiles.current = new Set();
    }, []);
    const confirmInput = useCallback(() => {
        for (const [tagId, seen] of pending.current) {
            const into = queued.current.get(tagId) ?? new Map<number, number>();
            for (const [fileId, seconds] of seen) {
                into.set(fileId, (into.get(fileId) ?? 0) + seconds);
            }
            queued.current.set(tagId, into);
        }
        dropPending();
        idle.current = false;
        lastInput.current = Date.now();
    }, [dropPending]);
    const addSeen = useCallback(
        (fileId: number, dt: number) => {
            const tagId = checkTagId.current;
            if (tagId == null || idle.current) return;
            const seen = pending.current.get(tagId) ?? new Map<number, number>();
            seen.set(fileId, (seen.get(fileId) ?? 0) + dt);
            pending.current.set(tagId, seen);
            pendingFiles.current.add(fileId);
            if (
                pendingFiles.current.size >= IDLE_FILES &&
                Date.now() - lastInput.current >= IDLE_MIN_MS
            ) {
                dropPending();
                idle.current = true;
            }
        },
        [dropPending],
    );
    useEffect(() => {
        flushSeen();
    }, [tag?.id, flushSeen]);
    // Declared before the keys below, and registered first with stable
    // dependencies, so it sees every key even when the picker stops one.
    useEffect(() => {
        if (!enabled) return;
        // Coming to a surface counts as input.
        idle.current = false;
        lastInput.current = Date.now();
        const flushTimer = setInterval(flushSeen, CHECK_FLUSH_MS);
        window.addEventListener("blur", flushSeen);
        let mx: number | null = null;
        let my: number | null = null;
        const onMove = (e: MouseEvent) => {
            if (e.screenX === mx && e.screenY === my) return;
            mx = e.screenX;
            my = e.screenY;
            confirmInput();
        };
        const onKey = () => confirmInput();
        const opts = { capture: true } as const;
        window.addEventListener("keydown", onKey, opts);
        window.addEventListener("mousedown", confirmInput, opts);
        window.addEventListener("wheel", confirmInput, opts);
        window.addEventListener("mousemove", onMove, opts);
        return () => {
            clearInterval(flushTimer);
            window.removeEventListener("blur", flushSeen);
            window.removeEventListener("keydown", onKey, opts);
            window.removeEventListener("mousedown", confirmInput, opts);
            window.removeEventListener("wheel", confirmInput, opts);
            window.removeEventListener("mousemove", onMove, opts);
            // Leaving: whatever was real got confirmed by the input that left.
            dropPending();
            flushSeen();
        };
    }, [enabled, flushSeen, confirmInput, dropPending]);

    // ── Keys ─────────────────────────────────────────────────────────────
    // Caught first (capture) and kept from everything else: the views' own
    // keys, the app-wide Z.
    const pickState = useRef({ matches, highlight, query });
    pickState.current = { matches, highlight, query };
    const stackState = useRef({ stack, cursor, listItems, listIndex });
    stackState.current = { stack, cursor, listItems, listIndex };
    const actions = useRef({ reroll, toggleTarget });
    actions.current = { reroll, toggleTarget };
    useEffect(() => {
        if (!enabled) return;
        const isHoldKey = (code: string) => code === "Tab" || code === "KeyT";
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (!pickingRef.current) {
                // A dialog over the view (Settings, a confirm) keeps its keys.
                if (isTyping() || document.querySelector("[data-modal]")) return;
                // Only over media (a target): elsewhere the keys are the
                // page's (T types, Tab moves focus). In a pass, Tab works on
                // a tag card too (to pick the next tag).
                const pass = passRef.current;
                if (!targetRef.current && !(pass && isHoldKey(e.code))) return;
                const claim = () => {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                };
                // Put away (H), the pointer does nothing: Space and ` are
                // still caught (so they don't fall through to the view)
                // but tag nothing and roll nothing. Tab / T bring it back
                // and open the picker; H brings it back as it was.
                if (isHoldKey(e.code)) {
                    claim();
                    if (e.repeat) return;
                    // A one-tag job (or its last tag): nothing to pick.
                    if (pass && pass.upcoming.length === 0) return;
                    heldKeys.current.add(e.code);
                    openPicker();
                } else if (e.code === "Space") {
                    claim();
                    if (!e.repeat && !hiddenRef.current) actions.current.toggleTarget();
                } else if (e.code === "Backquote") {
                    claim();
                    if (!e.repeat && !hiddenRef.current && !pass) actions.current.reroll();
                } else if (e.code === "KeyH") {
                    claim();
                    // The pointer is always on in a pass.
                    if (!e.repeat && !pass) setHidden((h) => !h);
                }
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            const { matches, highlight, query } = pickState.current;
            const searching = searchModeRef.current;
            const step = (by: 1 | -1) =>
                setHighlight((i) => (matches.length ? (i + by + matches.length) % matches.length : 0));
            const { stack, cursor, listItems, listIndex } = stackState.current;
            const mode = listModeRef.current;
            // Holding Tab never steps on its own (no key repeat), and the T
            // that opened the picker doesn't type while it's held.
            if (e.code === "Tab" && e.repeat) return;
            if (e.code === "KeyT" && heldKeys.current.has("KeyT")) return;
            if (e.code === "Tab") heldKeys.current.add("Tab");
            const listKey =
                e.code === "Digit1" ? "category" : e.code === "Digit2" ? "related" : e.code === "Digit3" ? "excluded" : null;
            if (listKey && heldKeys.current.size > 0) {
                // Tab (or T) held + 1 / 2 / 3: open that list, or step down it.
                // Not in a pass: its picker only holds the job's tags.
                if (e.repeat || passRef.current) return;
                cancelDouble();
                if (listKey === "excluded" && mode === "excluded" && searching) {
                    step(1);
                } else if (mode === listKey) {
                    setListIndex((i) => (listItems.length ? (i + 1) % listItems.length : 0));
                } else {
                    setListMode(listKey);
                    setListIndex(0);
                    setSearchMode(false);
                    setQuery("");
                }
                return;
            }
            if (e.key === "Shift") {
                // About to Shift+Tab back: this card won't be picked by
                // resting on it (moving on starts the timer again).
                if (!e.repeat) cancelDouble();
            } else if (e.key === "Escape") {
                closePicker();
            } else if (mode && !searching && (e.code === "Space" || e.key === "Enter")) {
                // On the front card: 1 / 2 keep the current tag; 3 waits for typing.
                if (e.repeat) return;
                if (listIndex > 0) closePicker(listItems[listIndex]);
                else if (mode !== "excluded") closePicker();
            } else if (e.code === "Tab" && !searching && !mode) {
                // The history stack: Tab further back, Shift+Tab toward now.
                const next = e.shiftKey
                    ? Math.max(cursor - 1, 0)
                    : Math.min(cursor + 1, Math.max(0, stack.length - 1));
                setCursor(next);
                // Resting on an earlier tag picks it. Stepping back onto the
                // current one lets go after the same rest (just opening the
                // picker doesn't, so there's time to type a search).
                cancelDouble();
                if (next > 0 || cursor > 0) {
                    startRest(HISTORY_PICK_MS, () => {
                        const { stack, cursor } = stackState.current;
                        closePicker(cursor > 0 ? stack[cursor] : undefined);
                    });
                }
            } else if (e.code === "Tab" && mode && !searching) {
                // A list works like the history: Tab further in, Shift+Tab
                // back toward the front card; resting on a tag picks it.
                const next = e.shiftKey
                    ? Math.max(listIndex - 1, 0)
                    : Math.min(listIndex + 1, Math.max(0, listItems.length - 1));
                setListIndex(next);
                cancelDouble();
                // Stepping back onto the current tag (1 / 2) lets go after the
                // rest too; 3's "search…" card waits for typing.
                if (next > 0 || (listIndex > 0 && mode !== "excluded")) {
                    startRest(LIST_PICK_MS, () => {
                        const { listItems, listIndex } = stackState.current;
                        if (!listModeRef.current || searchModeRef.current) return;
                        if (listIndex > 0) closePicker(listItems[listIndex]);
                        else if (listModeRef.current !== "excluded") closePicker();
                    });
                }
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
                else if (searching) {
                    // Back to the excluded cards (from 3), else the history.
                    setSearchMode(false);
                    if (mode !== "excluded") setListMode(null);
                }
            } else if (e.key.length === 1) {
                if (searching) setQuery((q) => q + e.key.toLowerCase());
                else if (mode === "excluded") {
                    // Typing on Tab+3's cards searches the excluded tags.
                    cancelDouble();
                    setQuery(e.key.toLowerCase());
                    setSearchMode(true);
                } else startSearch(e.key.toLowerCase());
            }
        };
        // The hold key is only tracked as held (held + 1 / 2 / 3 opens a
        // list, which then stays open until a pick or Esc).
        const onKeyUp = (e: KeyboardEvent) => {
            heldKeys.current.delete(e.code);
        };
        const onBlur = () => {
            heldKeys.current.clear();
        };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("keyup", onKeyUp, true);
            window.removeEventListener("blur", onBlur);
            cancelDouble();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, openPicker, closePicker, startSearch, cancelDouble]);

    const value: TagPointerValue = {
        enabled,
        tag,
        offeredTags,
        excludedTags,
        hidden,
        applyTag,
        rolling,
        countdown: deadline ? { deadline, interval: sweepInterval } : null,
        reroll,
        picking,
        pickingRef,
        openPicker,
        closePicker,
        togglePicker,
        query,
        searchMode,
        setSearchMode,
        highlight,
        setHighlight,
        matches,
        stack,
        cursor,
        listMode,
        listItems,
        listIndex,
        related,
        pickFill,
        resultsAbove,
        target,
        setTarget,
        clearTarget,
        toggleTagOn,
        checkTagId,
        addSeen,
        registerSurface,
        passMode,
        setPassMode,
    };

    return <TagPointerContext.Provider value={value}>{children}</TagPointerContext.Provider>;
}
