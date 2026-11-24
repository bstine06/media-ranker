import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { DbFile, FilterNode, TagCoverageRaw } from "@renderer/shared/types/types";
import { useTags } from "./TagsContext";
import { useFolders } from "./FolderContext";
import { useSettings, type SortDirection } from "./SettingsContext";
import { filterKey } from "@renderer/lib/tagFilters";
import { orderFiles, type PassOrder } from "@renderer/lib/sorts";
import ConfirmDialog from "@renderer/components/ConfirmDialog";

// Pass mode: going through a fixed list of files, one tag at a time,
// stepping by hand. Here: the lobby (where a run is set up) and the run.
//
// A run is: tag card → that tag's files → next tag card → … → end card.
// Each tag's list is built when its card is reached (so earlier tags'
// work, e.g. implied tags, is reflected), then stays fixed while you work
// in it. Picking another tag in the picker splits the current tag at your
// place: what you've been through stays behind you (1 still goes back
// through it), the rest goes to the end of the queue. Reaching that rest
// later drops files that got a firm answer meanwhile (e.g. implied).

/** Which files a pass goes through: those without a firm answer for the
 *  tag (yes, hard no, pass no), or every file (an audit). */
export type PassWhich = "needs-firm" | "all";

/** A stretch of the run: its tag (the lower one, Space) and optionally a
 *  second (the upper one, V), answered together. */
export interface PassSlot {
    tagId: number;
    upperId: number | null;
}

export interface LobbyDraft {
    /** Slots in the order the run will go through them. */
    slots: PassSlot[];
    which: PassWhich;
}

export interface PassScope {
    folderPrefixes: string[] | null;
    filter: FilterNode | null;
    /** The saved feed the filter came from, if unedited. */
    feedName: string | null;
}

/** One stretch of the queue: a tag's card and its files. A tag set aside
 *  with the picker has two: the part done (where it was) and the rest. */
export interface TagRun {
    /** Unique in the run (a tag can have two parts). */
    id: number;
    /** The lower tag (Space). */
    tagId: number;
    /** The upper tag (V), if this stretch is a pair. Its files are those
     *  needing a firm answer for either; 3 is a no for each one missing. */
    upperId: number | null;
    /** Its fixed list, once its card has been reached. */
    files: DbFile[] | null;
    /** The rest of a tag set aside with the picker. */
    rest: boolean;
    /** Its card has been reached since it was made or set aside (an
     *  arrival builds the list, or re-checks a set-aside one). */
    arrived: boolean;
}

export interface PassRun {
    scope: PassScope;
    which: PassWhich;
    order: PassOrder;
    direction: SortDirection;
    tags: TagRun[];
    /** Index in `tags`; tags.length = the end card. */
    t: number;
    /** -1 = on the tag's card; otherwise the file's index in its list. */
    pos: number;
    /** Estimated list sizes (by part id) for parts not built yet. */
    estimates: Record<number, number>;
    /** Coverage when the run started, per tag, for the end card. */
    before: Record<number, CoverageSnap>;
}

/** Files checked for a tag in the run's scope and in the library. */
export interface CoverageSnap {
    scope: { checked: number; files: number };
    library: { checked: number; files: number };
}

/** Files checked for a tag: a yes or a firm no. (Sweep time on screen is
 *  kept but doesn't count: it's a guess, not an answer.) */
export function checkedOf(raw: TagCoverageRaw, tagId: number): number {
    const t = raw.tags.find((x) => x.tagId === tagId);
    if (!t) return 0;
    return t.yes + t.firmNo;
}

/** Coverage right now for these tags, over the run's scope and the library. */
export async function snapCoverage(
    scope: PassScope,
    tagIds: number[],
): Promise<Record<number, CoverageSnap>> {
    const [inScope, lib] = await Promise.all([
        window.api.getTagCoverage(scope.folderPrefixes, scope.filter),
        window.api.getTagCoverage(),
    ]);
    const out: Record<number, CoverageSnap> = {};
    for (const id of tagIds) {
        out[id] = {
            scope: { checked: checkedOf(inScope, id), files: inScope.files },
            library: { checked: checkedOf(lib, id), files: lib.files },
        };
    }
    return out;
}

// Saved form (file ids instead of file records).
interface SavedRun {
    v: 1;
    scope: PassScope;
    which: PassWhich;
    order: PassOrder;
    direction: SortDirection;
    tags: {
        id: number;
        tagId: number;
        upperId?: number | null;
        fileIds: number[] | null;
        rest: boolean;
        arrived: boolean;
    }[];
    t: number;
    pos: number;
    estimates: Record<number, number>;
    before: Record<number, CoverageSnap>;
}

const toSaved = (r: PassRun): SavedRun => ({
    v: 1,
    scope: r.scope,
    which: r.which,
    order: r.order,
    direction: r.direction,
    tags: r.tags.map((x) => ({
        id: x.id,
        tagId: x.tagId,
        upperId: x.upperId,
        fileIds: x.files ? x.files.map((f) => f.id) : null,
        rest: x.rest,
        arrived: x.arrived,
    })),
    t: r.t,
    pos: r.pos,
    estimates: r.estimates,
    before: r.before,
});

/** A saved run back as a run: files that are gone (deleted, missing) drop
 *  out of the lists, and the place moves to match. Null if unreadable. */
async function fromSaved(json: string): Promise<PassRun | null> {
    let saved: SavedRun;
    try {
        saved = JSON.parse(json);
    } catch {
        return null;
    }
    if (saved?.v !== 1 || !Array.isArray(saved.tags)) return null;
    const ids = saved.tags.flatMap((x) => x.fileIds ?? []);
    const byId = new Map((await window.api.getFilesByIds([...new Set(ids)])).map((f) => [f.id, f]));
    let pos = saved.pos;
    const tags: TagRun[] = saved.tags.map((x, i) => {
        const upperId = x.upperId ?? null;
        if (!x.fileIds) return { id: x.id, tagId: x.tagId, upperId, files: null, rest: x.rest, arrived: x.arrived };
        const files = x.fileIds.map((id) => byId.get(id)).filter((f): f is DbFile => !!f);
        if (i === saved.t && pos >= 0) {
            // The place: as many files in as were kept before it.
            pos = x.fileIds.slice(0, pos).filter((id) => byId.has(id)).length;
            if (pos >= files.length) pos = -1;
        }
        return { id: x.id, tagId: x.tagId, upperId, files, rest: x.rest, arrived: x.arrived };
    });
    return {
        scope: saved.scope,
        which: saved.which,
        order: saved.order,
        direction: saved.direction,
        tags,
        t: Math.min(saved.t, tags.length),
        pos,
        estimates: saved.estimates ?? {},
        before: saved.before ?? {},
    };
}

/** What's in the lane at a spot. */
export type PassItem =
    | { kind: "card"; t: number }
    | { kind: "file"; t: number; pos: number; file: DbFile }
    | { kind: "end" };

interface PassContextValue {
    /** The lobby (the Pass view's home), or null while the run shows. */
    lobby: LobbyDraft | null;
    /** Opens the lobby with these tags (e.g. Coverage's "Pass with this
     *  tag"). With an unfinished run, asks first: a new one replaces it. */
    openLobby: (tagIds?: number[]) => void;
    updateLobby: (patch: Partial<LobbyDraft>) => void;
    closeLobby: () => void;

    /** The run (kept while away from it, so it can be resumed). */
    run: PassRun | null;
    /** Showing the run (false: in the lobby, or away from the Pass view). */
    runActive: boolean;
    startRun: () => Promise<void>;
    resumeRun: () => void;
    /** Back to free sweep; the run is kept for resuming. */
    leaveRun: () => void;
    /** 3 / 2: the next spot (building the next tag's list on its card). */
    forward: () => Promise<void>;
    /** 1: the spot before. */
    back: () => void;
    /** The picker: this tag comes up now; the current one goes to the end. */
    pickTag: (tagId: number) => Promise<void>;
    /** Replaces a file's record in the run's lists (e.g. after a rotate). */
    replaceFile: (file: DbFile) => void;
}

const noop = () => {};
const PassContext = createContext<PassContextValue>({
    lobby: null,
    openLobby: noop,
    updateLobby: noop,
    closeLobby: noop,
    run: null,
    runActive: false,
    startRun: async () => {},
    resumeRun: noop,
    leaveRun: noop,
    forward: async () => {},
    back: noop,
    pickTag: async () => {},
    replaceFile: noop,
});

/** The item at (t, pos), if there is one there. */
export function itemAt(run: PassRun, t: number, pos: number): PassItem | null {
    if (t === run.tags.length) return pos === -1 ? { kind: "end" } : null;
    const tr = run.tags[t];
    if (!tr) return null;
    if (pos === -1) return { kind: "card", t };
    const file = tr.files?.[pos];
    return file ? { kind: "file", t, pos, file } : null;
}

/** The spot after (t, pos), or null at the end or where the next list
 *  isn't built yet (only its card can be shown). */
export function nextSpot(run: PassRun, t: number, pos: number): [number, number] | null {
    if (t >= run.tags.length) return null;
    const tr = run.tags[t];
    if (pos === -1) {
        if (!tr.files) return null;
        return tr.files.length > 0 ? [t, 0] : [t + 1, -1];
    }
    if (tr.files && pos < tr.files.length - 1) return [t, pos + 1];
    return [t + 1, -1];
}

/** The spot before (t, pos), or null at the very start. */
export function prevSpot(run: PassRun, t: number, pos: number): [number, number] | null {
    if (pos > 0) return [t, pos - 1];
    if (pos === 0) return [t, -1];
    // On a card (or the end card): the previous tag's last file, or its card.
    if (t === 0) return null;
    const prev = run.tags[t - 1];
    const n = prev.files?.length ?? 0;
    return n > 0 ? [t - 1, n - 1] : [t - 1, -1];
}

export function PassProvider({ children }: { children: React.ReactNode }): JSX.Element {
    const { activeFilter, loadedFeed, filter } = useTags();
    const { folderPrefixes, rootPath } = useFolders();
    const { passOrder, passDirection } = useSettings();

    const [lobby, setLobby] = useState<LobbyDraft | null>(null);
    const [run, setRunState] = useState<PassRun | null>(null);
    const runRef = useRef<PassRun | null>(null);
    const setRun = useCallback((r: PassRun | null) => {
        runRef.current = r;
        setRunState(r);
    }, []);
    const [runActive, setRunActive] = useState(false);
    const runActiveRef = useRef(runActive);
    runActiveRef.current = runActive;
    // Start pressed with an unfinished run: waiting on the confirm.
    const [confirmReplace, setConfirmReplace] = useState(false);
    // Ids for the queue's parts.
    const nextId = useRef(1);

    // The unfinished run belongs to the library: a library opening loads
    // its saved one (not shown until resumed).
    useEffect(() => {
        setRun(null);
        setRunActive(false);
        setLobby(null);
        if (!rootPath) return;
        let gone = false;
        window.api
            .loadPassRun()
            .then(async (json) => {
                if (!json || gone) return;
                const r = await fromSaved(json);
                if (!r || gone) return;
                nextId.current = Math.max(0, ...r.tags.map((x) => x.id)) + 1;
                if (r.t < r.tags.length) setRun(r);
                else window.api.clearPassRun().catch(() => {});
            })
            .catch(() => {});
        return () => {
            gone = true;
        };
    }, [rootPath, setRun]);

    // Saved after every change (one row); cleared once it's finished. (A
    // null run saves nothing: replacing clears it explicitly.)
    useEffect(() => {
        if (!run) return;
        const t = setTimeout(() => {
            if (run.t >= run.tags.length) window.api.clearPassRun().catch(() => {});
            else window.api.savePassRun(JSON.stringify(toSaved(run))).catch(() => {});
        }, 250);
        return () => clearTimeout(t);
    }, [run]);

    const openLobbyNow = useCallback((tagIds: number[]) => {
        setRunActive(false);
        setLobby({ slots: tagIds.map((tagId) => ({ tagId, upperId: null })), which: "needs-firm" });
    }, []);
    // The lobby opens straight away; with an unfinished run it offers to
    // resume it, and Start asks before replacing it.
    const openLobby = useCallback((tagIds: number[] = []) => openLobbyNow(tagIds), [openLobbyNow]);
    const updateLobby = useCallback((patch: Partial<LobbyDraft>) => {
        setLobby((l) => (l ? { ...l, ...patch } : l));
    }, []);
    const closeLobby = useCallback(() => setLobby(null), []);

    // Moving is one step at a time (a list may be loading).
    const busy = useRef(false);

    /** A card reached for the first time since its part was made: build
     *  the list, or (the rest of a set-aside tag) drop files that got a
     *  firm answer meanwhile. Later visits (going back) change nothing. */
    const arrive = useCallback(async (r: PassRun, t: number): Promise<PassRun> => {
        if (t >= r.tags.length) return r;
        const tr = r.tags[t];
        if (tr.arrived && tr.files) return r;
        let files: DbFile[];
        if (!tr.files) {
            const found = await window.api.getPassFiles(
                r.scope.folderPrefixes,
                r.scope.filter,
                { tagId: tr.tagId, upperId: tr.upperId },
                r.which,
            );
            files = orderFiles(found, r.order, r.direction);
        } else if (r.which === "needs-firm" && tr.files.length > 0) {
            const keep = new Set(
                await window.api.prunePassList({ tagId: tr.tagId, upperId: tr.upperId }, tr.files.map((f) => f.id)),
            );
            files = tr.files.filter((f) => keep.has(f.id));
        } else {
            files = tr.files;
        }
        const tags = r.tags.map((x, i) => (i === t ? { ...x, files, arrived: true } : x));
        // Later tags' estimates, now that this tag's work may have changed them.
        const later = tags.slice(t + 1).filter((x) => !x.files);
        let estimates = r.estimates;
        if (later.length > 0) {
            try {
                const counts = await window.api.getPassCounts(
                    r.scope.folderPrefixes,
                    r.scope.filter,
                    later.map((x) => ({ tagId: x.tagId, upperId: x.upperId })),
                    r.which,
                );
                estimates = { ...estimates };
                later.forEach((x, i) => (estimates[x.id] = counts[i] ?? 0));
            } catch {
                // keep the old ones
            }
        }
        return { ...r, tags, estimates };
    }, []);

    const startNow = useCallback(async () => {
        if (!lobby || lobby.slots.length === 0 || busy.current) return;
        busy.current = true;
        try {
            const scope: PassScope = {
                folderPrefixes,
                filter: activeFilter,
                feedName:
                    loadedFeed && filterKey(loadedFeed.tree) === filterKey(filter)
                        ? loadedFeed.name
                        : null,
            };
            const fresh: PassRun = {
                scope,
                which: lobby.which,
                order: passOrder,
                direction: passDirection,
                tags: lobby.slots.map((slot) => ({
                    id: nextId.current++,
                    tagId: slot.tagId,
                    upperId: slot.upperId,
                    files: null,
                    rest: false,
                    arrived: false,
                })),
                t: 0,
                pos: -1,
                estimates: {},
                before: {},
            };
            try {
                fresh.before = await snapCoverage(scope, slotTagIds(lobby.slots));
            } catch {
                // the end card just won't show before → after
            }
            const r = await arrive(fresh, 0);
            setRun(r);
            setLobby(null);
            setRunActive(true);
        } finally {
            busy.current = false;
        }
    }, [lobby, folderPrefixes, activeFilter, loadedFeed, filter, passOrder, passDirection, arrive, setRun]);

    const startRun = useCallback(async () => {
        const r = runRef.current;
        if (r && r.t < r.tags.length) setConfirmReplace(true);
        else await startNow();
    }, [startNow]);

    const resumeRun = useCallback(() => {
        if (!runRef.current) return;
        setLobby(null);
        setRunActive(true);
    }, []);
    const leaveRun = useCallback(() => setRunActive(false), []);

    const forward = useCallback(async () => {
        const r = runRef.current;
        if (!r || busy.current) return;
        const next = nextSpot(r, r.t, r.pos);
        if (!next) return;
        const [t, pos] = next;
        if (t !== r.t && t < r.tags.length) {
            busy.current = true;
            try {
                const built = await arrive(r, t);
                setRun({ ...built, t, pos });
            } finally {
                busy.current = false;
            }
        } else {
            setRun({ ...r, t, pos });
        }
    }, [arrive, setRun]);

    // Undoing a pass no, or a tag put on / taken off (Space, V) before
    // moving on: back to that file, but only from the very next spot (2
    // and 3 move on by one); from further on, the run stays put. Only while
    // the run is on screen: an undo in another view never moves it.
    useEffect(
        () =>
            window.api.onHistoryApplied((a) => {
                if (a.direction !== "undo" || a.error || (a.meta?.kind !== "pass-no" && a.meta?.kind !== "file-tag")) return;
                const r = runRef.current;
                if (!r || !runActiveRef.current) return;
                const { fileId, tagId } = a.meta;
                const prev = prevSpot(r, r.t, r.pos);
                if (!prev) return;
                const [t, pos] = prev;
                const tr = r.tags[t];
                if (pos < 0 || !tr || (tr.tagId !== tagId && tr.upperId !== tagId)) return;
                if (tr.files?.[pos]?.id !== fileId) return;
                setRun({ ...r, t, pos });
            }),
        [setRun],
    );

    // A file deleted (here, by a redo, in Finder) leaves the run's lists.
    // The place stays on the same file; if it was the file on screen, the
    // next one takes its place (the one before, if it was the last; its
    // card, if none are left). Undone deletes don't come back into the run.
    useEffect(
        () =>
            window.api.onMediaRemoved(({ relativePath }) => {
                const r = runRef.current;
                if (!r) return;
                if (!r.tags.some((x) => x.files?.some((f) => f.path === relativePath))) return;
                let pos = r.pos;
                const tags = r.tags.map((x, i) => {
                    if (!x.files) return x;
                    const at = x.files.findIndex((f) => f.path === relativePath);
                    if (at < 0) return x;
                    const files = x.files.filter((_, j) => j !== at);
                    if (i === r.t && pos >= 0) {
                        if (at < pos) pos -= 1;
                        if (pos >= files.length) pos = files.length - 1;
                    }
                    return { ...x, files };
                });
                setRun({ ...r, tags, pos });
            }),
        [setRun],
    );

    // Renamed or moved (Finder, the app, an undo): the run follows the new
    // path, so a later delete still finds it.
    useEffect(
        () =>
            window.api.onMediaRenamed(({ oldRelativePath, relativePath }) => {
                const r = runRef.current;
                if (!r || !r.tags.some((x) => x.files?.some((f) => f.path === oldRelativePath))) return;
                const filename = relativePath.split("/").pop() ?? relativePath;
                const tags = r.tags.map((x) =>
                    x.files?.some((f) => f.path === oldRelativePath)
                        ? { ...x, files: x.files.map((f) => (f.path === oldRelativePath ? { ...f, path: relativePath, filename } : f)) }
                        : x,
                );
                setRun({ ...r, tags });
            }),
        [setRun],
    );

    const back = useCallback(() => {
        const r = runRef.current;
        if (!r || busy.current) return;
        const prev = prevSpot(r, r.t, r.pos);
        if (prev) setRun({ ...r, t: prev[0], pos: prev[1] });
    }, [setRun]);

    const pickTag = useCallback(
        async (tagId: number) => {
            const r = runRef.current;
            if (!r || busy.current || r.t >= r.tags.length) return;
            const c = r.tags.findIndex((x, i) => i > r.t && x.tagId === tagId);
            if (c < 0) return;
            const cur = r.tags[r.t];
            const files = cur.files ?? [];
            // Split at your place: files before it stay here, done (1 goes
            // back through them); the current file and the rest go last.
            const doneCount = r.pos > 0 ? r.pos : 0;
            const done: TagRun[] =
                doneCount > 0 ? [{ ...cur, files: files.slice(0, doneCount), arrived: true }] : [];
            const restPart: TagRun = {
                id: nextId.current++,
                tagId: cur.tagId,
                upperId: cur.upperId,
                files: cur.files ? files.slice(doneCount) : null,
                rest: true,
                arrived: false,
            };
            const others = r.tags.filter((_, i) => i > r.t && i !== c);
            const before = [...r.tags.slice(0, r.t), ...done];
            const tags = [...before, r.tags[c], ...others, restPart];
            const t = before.length;
            busy.current = true;
            try {
                const built = await arrive({ ...r, tags, t, pos: -1 }, t);
                setRun({ ...built, t, pos: -1 });
            } finally {
                busy.current = false;
            }
        },
        [arrive, setRun],
    );

    const replaceFile = useCallback(
        (file: DbFile) => {
            const r = runRef.current;
            if (!r) return;
            setRun({
                ...r,
                tags: r.tags.map((x) =>
                    x.files ? { ...x, files: x.files.map((f) => (f.id === file.id ? file : f)) } : x,
                ),
            });
        },
        [setRun],
    );

    const value = useMemo(
        () => ({
            lobby,
            openLobby,
            updateLobby,
            closeLobby,
            run,
            runActive,
            startRun,
            resumeRun,
            leaveRun,
            forward,
            back,
            pickTag,
            replaceFile,
        }),
        [lobby, openLobby, updateLobby, closeLobby, run, runActive, startRun, resumeRun, leaveRun, forward, back, pickTag, replaceFile],
    );
    return (
        <PassContext.Provider value={value}>
            {children}
            {confirmReplace && (
                <ConfirmDialog
                    title="Start a new pass?"
                    message="You have an unfinished pass. Starting this one replaces it (everything you answered in it is already saved)."
                    confirmText="Start new pass"
                    danger={false}
                    onConfirm={() => {
                        setConfirmReplace(false);
                        void startNow();
                    }}
                    onCancel={() => setConfirmReplace(false)}
                />
            )}
        </PassContext.Provider>
    );
}

export const usePass = () => useContext(PassContext);

/** Files done and total (later tags estimated), for the progress bar. */
export function runProgress(run: PassRun): { done: number; total: number } {
    let done = 0;
    let total = 0;
    run.tags.forEach((tr, i) => {
        const n = tr.files ? tr.files.length : (run.estimates[tr.id] ?? 0);
        total += n;
        if (i < run.t) done += n;
        else if (i === run.t) done += Math.max(0, run.pos);
    });
    return { done, total };
}

/** Where the run is by tag, counting each tag once: "tag 2 of 3", and
 *  whether this is the rest of a tag set aside. Null on the end card. */
export function tagPosition(run: PassRun): { n: number; of: number; rest: boolean } | null {
    if (run.t >= run.tags.length) return null;
    const order: number[] = [];
    for (const tr of run.tags) if (!order.includes(tr.tagId)) order.push(tr.tagId);
    const cur = run.tags[run.t];
    return { n: order.indexOf(cur.tagId) + 1, of: order.length, rest: cur.rest };
}

/** Every tag in these slots, lower and upper, each once. */
export function slotTagIds(slots: { tagId: number; upperId: number | null }[]): number[] {
    return [...new Set(slots.flatMap((x) => (x.upperId != null ? [x.tagId, x.upperId] : [x.tagId])))];
}
