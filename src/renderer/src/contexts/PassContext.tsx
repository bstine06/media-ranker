import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { DbFile, FilterNode } from "@renderer/shared/types/types";
import { useTags } from "./TagsContext";
import { useFolders } from "./FolderContext";
import { useSettings, type SortDirection } from "./SettingsContext";
import { filterKey } from "@renderer/lib/tagFilters";
import { orderFiles, type PassOrder } from "@renderer/lib/sorts";
import ConfirmDialog from "@renderer/components/ConfirmDialog";

// Sweep pass mode: going through a fixed list of files, one tag at a time,
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

export interface LobbyDraft {
    /** Tags in the order the run will go through them. */
    tagIds: number[];
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
    tagId: number;
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
    /** Estimated list sizes for tags whose list isn't built yet. */
    estimates: Record<number, number>;
}

/** What's in the lane at a spot. */
export type PassItem =
    | { kind: "card"; t: number }
    | { kind: "file"; t: number; pos: number; file: DbFile }
    | { kind: "end" };

interface PassContextValue {
    /** The lobby, in Sweep's place, or null. */
    lobby: LobbyDraft | null;
    /** Opens the lobby with these tags (e.g. Coverage's "Pass with this
     *  tag"). With an unfinished run, asks first: a new one replaces it. */
    openLobby: (tagIds?: number[]) => void;
    updateLobby: (patch: Partial<LobbyDraft>) => void;
    closeLobby: () => void;

    /** The run (kept while away from it, so it can be resumed). */
    run: PassRun | null;
    /** Showing the run in Sweep (false: away, e.g. in free sweep). */
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
    const { folderPrefixes } = useFolders();
    const { passOrder, passDirection } = useSettings();

    const [lobby, setLobby] = useState<LobbyDraft | null>(null);
    const [run, setRunState] = useState<PassRun | null>(null);
    const runRef = useRef<PassRun | null>(null);
    const setRun = useCallback((r: PassRun | null) => {
        runRef.current = r;
        setRunState(r);
    }, []);
    const [runActive, setRunActive] = useState(false);
    // A new pass asked for with an unfinished run: waiting on the confirm.
    const [pendingLobby, setPendingLobby] = useState<number[] | null>(null);

    const openLobbyNow = useCallback((tagIds: number[]) => {
        setRunActive(false);
        setLobby({ tagIds, which: "needs-firm" });
    }, []);
    const openLobby = useCallback(
        (tagIds: number[] = []) => {
            const r = runRef.current;
            if (r && r.t < r.tags.length) setPendingLobby(tagIds);
            else openLobbyNow(tagIds);
        },
        [openLobbyNow],
    );
    const updateLobby = useCallback((patch: Partial<LobbyDraft>) => {
        setLobby((l) => (l ? { ...l, ...patch } : l));
    }, []);
    const closeLobby = useCallback(() => setLobby(null), []);

    // Moving is one step at a time (a list may be loading).
    const busy = useRef(false);
    // Ids for the queue's parts.
    const nextId = useRef(1);

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
                tr.tagId,
                r.which,
            );
            files = orderFiles(found, r.order, r.direction);
        } else if (r.which === "needs-firm" && tr.files.length > 0) {
            const keep = new Set(await window.api.prunePassList(tr.tagId, tr.files.map((f) => f.id)));
            files = tr.files.filter((f) => keep.has(f.id));
        } else {
            files = tr.files;
        }
        const tags = r.tags.map((x, i) => (i === t ? { ...x, files, arrived: true } : x));
        // Later tags' estimates, now that this tag's work may have changed them.
        const later = tags.slice(t + 1).filter((x) => !x.files).map((x) => x.tagId);
        let estimates = r.estimates;
        if (later.length > 0) {
            try {
                estimates = {
                    ...estimates,
                    ...(await window.api.getPassCounts(
                        r.scope.folderPrefixes,
                        r.scope.filter,
                        later,
                        r.which,
                    )),
                };
            } catch {
                // keep the old ones
            }
        }
        return { ...r, tags, estimates };
    }, []);

    const startRun = useCallback(async () => {
        if (!lobby || lobby.tagIds.length === 0 || busy.current) return;
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
                tags: lobby.tagIds.map((tagId) => ({
                    id: nextId.current++,
                    tagId,
                    files: null,
                    rest: false,
                    arrived: false,
                })),
                t: 0,
                pos: -1,
                estimates: {},
            };
            const r = await arrive(fresh, 0);
            setRun(r);
            setLobby(null);
            setRunActive(true);
        } finally {
            busy.current = false;
        }
    }, [lobby, folderPrefixes, activeFilter, loadedFeed, filter, passOrder, passDirection, arrive, setRun]);

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
            {pendingLobby && (
                <ConfirmDialog
                    title="Start a new pass?"
                    message="You have an unfinished pass. Setting up a new one replaces it (everything you answered is already saved)."
                    confirmText="New pass"
                    danger={false}
                    onConfirm={() => {
                        const ids = pendingLobby;
                        setPendingLobby(null);
                        setRun(null);
                        openLobbyNow(ids);
                    }}
                    onCancel={() => setPendingLobby(null)}
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
        const n = tr.files ? tr.files.length : (run.estimates[tr.tagId] ?? 0);
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
