// The tag filter builder: a modal for the one tag filter Browse, Compare and
// Sweep use. The filter is a tree (lib/tagFilters.ts): groups in
// parentheses, their items joined by one word (AND or OR, click to flip),
// any item or group switchable to WITHOUT. Items are tags and tag counts.
//
// The modal edits a draft. Nothing changes in the views until it closes,
// and every close (Esc, clicking outside, Done) applies the draft. Applied
// filters go into the recent list, so a filter that was never saved isn't
// lost. A filter referring to a deleted tag or category won't apply until
// it's fixed; the broken items are marked.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import ConfirmDialog from "./ConfirmDialog";
import { setUndoOverride, type UndoResult } from "@renderer/lib/undoOverride";
import type {
    CountFrom,
    DbTagCategory,
    DbTagWithCategory,
    Feed,
    FeedHistoryEntry,
    FilterGroup,
    FilterNode,
} from "@renderer/shared/types/types";
import {
    emptyFilter,
    filterIsBroken,
    filterKey,
    nodeIsBroken,
    pruneFilter,
} from "@renderer/lib/tagFilters";

type Path = number[];

/** The root as a group (an applied filter's root always is one). */
const asGroup = (node: FilterNode | null): FilterGroup =>
    !node ? emptyFilter() : node.kind === "group" ? node : { kind: "group", op: "and", items: [node] };

/** The tree with the node at `path` replaced by fn(node), or removed if fn returns null. */
function updateAt(root: FilterGroup, path: Path, fn: (n: FilterNode) => FilterNode | null): FilterGroup {
    if (path.length === 0) return (fn(root) as FilterGroup | null) ?? emptyFilter();
    const [i, ...rest] = path;
    const items = [...root.items];
    const child = items[i];
    const next = rest.length === 0 ? fn(child) : updateAt(child as FilterGroup, rest, fn);
    if (next === null) items.splice(i, 1);
    else items[i] = next;
    return { ...root, items };
}

/** A filter written out on one line, for the recent list. */
function describe(
    node: FilterNode,
    tagMap: Map<number, DbTagWithCategory>,
    categories: DbTagCategory[],
    top = true,
): string {
    const w = node.without ? "WITHOUT " : "";
    if (node.kind === "tag") return w + (tagMap.get(node.id)?.name ?? "(deleted tag)");
    if (node.kind === "count") {
        const from =
            node.from === "all"
                ? "tags"
                : node.from === "uncategorized"
                  ? "uncategorized tags"
                  : `${categories.find((c) => c.id === node.from)?.name ?? "(deleted category)"} tags`;
        return `${w}${node.op} ${node.n} ${from}`;
    }
    const inner = node.items
        .map((i) => describe(i, tagMap, categories, false))
        .join(` ${node.op.toUpperCase()} `);
    return top && !node.without ? inner : `${w}(${inner})`;
}

export default function FilterBuilder({ onClose }: { onClose: () => void }): JSX.Element {
    const { filter, loadedFeed, applyFilter, setLoadedFeed, allTags, allCategories, tagMap } =
        useTags();
    const { folderPrefixes } = useFolders();

    const [draft, setDraft] = useState<FilterGroup>(() => asGroup(filter));
    const [draftFeed, setDraftFeed] = useState<Feed | null>(loadedFeed);
    const [feeds, setFeeds] = useState<Feed[]>([]);
    const [history, setHistory] = useState<FeedHistoryEntry[]>([]);
    const [count, setCount] = useState<{ matches: number; total: number; inFolders: number | null } | null>(null);
    const [naming, setNaming] = useState<{ mode: "new" } | { mode: "rename"; feed: Feed } | null>(null);
    const [nameInput, setNameInput] = useState("");
    const [nameError, setNameError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<Feed | null>(null);

    const pruned = useMemo(() => pruneFilter(draft), [draft]);
    const draftKey = filterKey(pruned);
    const broken = filterIsBroken(pruned, allTags, allCategories);
    const edited = draftFeed != null && filterKey(draftFeed.tree) !== draftKey;

    const refreshLists = useCallback(async () => {
        const [f, h] = await Promise.all([window.api.listFeeds(), window.api.getFeedHistory()]);
        setFeeds(f);
        setHistory(h);
    }, []);
    useEffect(() => {
        void refreshLists();
    }, [refreshLists]);

    // The live count, a moment after the last edit.
    useEffect(() => {
        let stale = false;
        const t = setTimeout(async () => {
            const c = await window.api.countFilter(pruned, folderPrefixes);
            if (!stale) setCount(c);
        }, 200);
        return () => {
            stale = true;
            clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draftKey, folderPrefixes]);

    // Every close applies the draft. Unchanged, it only keeps the loaded
    // feed current (it may have been saved or renamed meanwhile).
    const close = useCallback(() => {
        if (draftKey === filterKey(filter) && draftFeed?.id === loadedFeed?.id) {
            setLoadedFeed(draftFeed);
        } else {
            applyFilter(pruned, draftFeed);
        }
        onClose();
    }, [draftKey, filter, draftFeed, loadedFeed, pruned, applyFilter, setLoadedFeed, onClose]);

    // Escape closes, unless a confirm or the name box is handling it.
    const closeRef = useRef(close);
    closeRef.current = close;
    const blockEscape = confirmDelete != null || naming != null;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !blockEscape) {
                e.preventDefault();
                e.stopPropagation();
                closeRef.current();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [blockEscape]);

    // ── The draft's own undo ──
    // Every edit, and loading a feed or recent filter, is a step. It lasts
    // while the builder is open. Typing a count is one step (`mergeKey`).
    // Meanwhile ⌘Z / ⇧⌘Z step through it, never the app's history.
    type Snap = { draft: FilterGroup; feed: Feed | null };
    const now = useRef<Snap>({ draft, feed: draftFeed });
    now.current = { draft, feed: draftFeed };
    const steps = useRef<{ past: Snap[]; future: Snap[]; mergeKey: string | null }>({
        past: [],
        future: [],
        mergeKey: null,
    });
    const [, setStepsVersion] = useState(0);
    const show = (snap: Snap) => {
        now.current = snap;
        setDraft(snap.draft);
        setDraftFeed(snap.feed);
        setStepsVersion((v) => v + 1);
    };
    const commit = (next: Snap, mergeKey: string | null = null) => {
        const cur = now.current;
        if (JSON.stringify(next.draft) === JSON.stringify(cur.draft) && next.feed?.id === cur.feed?.id) return;
        const h = steps.current;
        if (!(mergeKey && mergeKey === h.mergeKey)) h.past.push(cur);
        h.future = [];
        h.mergeKey = mergeKey;
        show(next);
    };
    const stepDraft = (action: "undo" | "redo"): boolean => {
        const h = steps.current;
        const from = action === "undo" ? h.past : h.future;
        const to = action === "undo" ? h.future : h.past;
        const snap = from.pop();
        if (!snap) return false;
        to.push(now.current);
        h.mergeKey = null;
        show(snap);
        return true;
    };
    const stepRef = useRef(stepDraft);
    stepRef.current = stepDraft;
    useEffect(
        () =>
            setUndoOverride((action): UndoResult => {
                // A text box with something typed in it undoes its typing.
                const el = document.activeElement as HTMLInputElement | null;
                if (el?.tagName === "INPUT" && el.type !== "number" && el.value !== "") return "pass";
                return stepRef.current(action) ? "done" : "empty";
            }),
        [],
    );

    const edit = (path: Path, fn: (n: FilterNode) => FilterNode | null, mergeKey?: string) =>
        commit({ draft: updateAt(now.current.draft, path, fn), feed: now.current.feed }, mergeKey ?? null);
    const addTo = (path: Path, item: FilterNode) =>
        edit(path, (g) => (g.kind === "group" ? { ...g, items: [...g.items, item] } : g));

    const load = (tree: FilterNode, feed: Feed | null) => commit({ draft: asGroup(tree), feed });

    const save = async () => {
        if (!draftFeed || !pruned) return;
        await window.api.updateFeed(draftFeed.id, pruned);
        setDraftFeed({ ...draftFeed, tree: pruned });
        await refreshLists();
    };

    const submitName = async () => {
        if (!naming) return;
        if (naming.mode === "new") {
            if (!pruned) return;
            const result = await window.api.createFeed(nameInput, pruned);
            if ("error" in result) return setNameError(result.error);
            setDraftFeed(result.feed);
        } else {
            const result = await window.api.renameFeed(naming.feed.id, nameInput);
            if ("error" in result) return setNameError(result.error);
            if (draftFeed?.id === naming.feed.id) setDraftFeed({ ...draftFeed, name: nameInput.trim() });
        }
        setNaming(null);
        await refreshLists();
    };

    const startNaming = (n: { mode: "new" } | { mode: "rename"; feed: Feed }) => {
        setNaming(n);
        setNameInput(n.mode === "rename" ? n.feed.name : "");
        setNameError(null);
    };

    const deleteFeed = async (feed: Feed) => {
        await window.api.deleteFeed(feed.id);
        if (draftFeed?.id === feed.id) setDraftFeed(null);
        setConfirmDelete(null);
        await refreshLists();
    };

    const pct = count && count.total > 0 ? (count.matches / count.total) * 100 : 0;

    return createPortal(
        <div
            data-modal
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) close();
            }}
        >
            <div
                tabIndex={-1}
                // Keys typed here stay here: the views behind listen on window.
                onKeyDown={(e) => e.stopPropagation()}
                className="flex h-[min(40rem,calc(100vh-4rem))] w-[52rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl outline-none"
            >
                {/* Saved feeds and recent filters */}
                <div className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-800 p-3">
                    <ListSection title="Saved feeds">
                        {feeds.length === 0 && <Empty>None yet.</Empty>}
                        {feeds.map((f) => (
                            <div key={f.id} className="group flex items-center gap-1">
                                <button
                                    onClick={() => load(f.tree, f)}
                                    className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs transition-colors ${
                                        draftFeed?.id === f.id
                                            ? "bg-neutral-200 text-neutral-900"
                                            : "text-neutral-300 hover:bg-neutral-800"
                                    }`}
                                >
                                    {f.name}
                                    {filterIsBroken(f.tree, allTags, allCategories) && (
                                        <span className="ml-1 text-red-400">⚠</span>
                                    )}
                                </button>
                                <button
                                    title="Rename"
                                    onClick={() => startNaming({ mode: "rename", feed: f })}
                                    className="hidden px-1 text-[10px] text-neutral-500 hover:text-neutral-200 group-hover:block"
                                >
                                    ✎
                                </button>
                                <button
                                    title="Delete"
                                    onClick={() => setConfirmDelete(f)}
                                    className="hidden px-1 text-[10px] text-neutral-500 hover:text-red-400 group-hover:block"
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </ListSection>
                    <ListSection title="Recent">
                        {history.length === 0 && <Empty>Filters you apply show up here.</Empty>}
                        {history.map((h) => {
                            const label = h.name ?? describe(h.tree, tagMap, allCategories);
                            return (
                                <button
                                    key={h.id}
                                    title={describe(h.tree, tagMap, allCategories)}
                                    onClick={() => load(h.tree, feeds.find((f) => f.id === h.feedId) ?? null)}
                                    className={`truncate rounded px-2 py-1 text-left text-xs text-neutral-300 hover:bg-neutral-800 ${
                                        h.name ? "" : "font-mono text-[11px]"
                                    }`}
                                >
                                    {label}
                                    {filterIsBroken(h.tree, allTags, allCategories) && (
                                        <span className="ml-1 text-red-400">⚠</span>
                                    )}
                                </button>
                            );
                        })}
                    </ListSection>
                </div>

                {/* The draft */}
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
                        <div className="min-w-0">
                            <h2 className="truncate text-sm font-semibold text-neutral-200">
                                {draftFeed ? draftFeed.name : "Filter"}
                                {edited && (
                                    <span className="ml-2 text-xs font-normal text-amber-400">edited</span>
                                )}
                            </h2>
                            <p className="mt-0.5 text-xs text-neutral-400 tabular-nums">
                                {count == null
                                    ? "…"
                                    : `${count.matches.toLocaleString()} files · ${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}% of library`}
                                {count?.inFolders != null && (
                                    <span className="text-neutral-500">
                                        {" "}· {count.inFolders.toLocaleString()} in selected folders
                                    </span>
                                )}
                            </p>
                            {broken && (
                                <p className="mt-1 text-xs text-red-400">
                                    Uses a deleted tag or category, so it won't apply until you fix the marked items.
                                </p>
                            )}
                        </div>
                        <button
                            onClick={close}
                            title="Apply and close (Esc)"
                            className="shrink-0 rounded bg-neutral-200 px-3 py-1 text-xs text-neutral-900 hover:bg-white"
                        >
                            Done
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-4 py-3">
                        <GroupEditor
                            group={draft}
                            path={[]}
                            edit={edit}
                            addTo={addTo}
                            autoFocus
                        />
                    </div>

                    <div className="flex items-center gap-2 border-t border-neutral-800 px-4 py-2.5">
                        {naming ? (
                            <form
                                className="flex flex-1 items-center gap-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void submitName();
                                }}
                            >
                                <input
                                    autoFocus
                                    value={nameInput}
                                    onChange={(e) => {
                                        setNameInput(e.target.value);
                                        setNameError(null);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Escape") {
                                            e.preventDefault();
                                            setNaming(null);
                                        }
                                    }}
                                    placeholder={naming.mode === "new" ? "Feed name" : "New name"}
                                    className="w-56 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-600"
                                />
                                <FooterButton type="submit">{naming.mode === "new" ? "Save" : "Rename"}</FooterButton>
                                <FooterButton type="button" onClick={() => setNaming(null)}>
                                    Cancel
                                </FooterButton>
                                {nameError && <span className="text-xs text-red-400">{nameError}</span>}
                            </form>
                        ) : (
                            <>
                                {draftFeed && (
                                    <FooterButton onClick={save} disabled={!edited || !pruned}>
                                        Save
                                    </FooterButton>
                                )}
                                <FooterButton onClick={() => startNaming({ mode: "new" })} disabled={!pruned}>
                                    {draftFeed ? "Save as new" : "Save as feed"}
                                </FooterButton>
                                <FooterButton
                                    className="ml-auto"
                                    onClick={() => stepDraft("undo")}
                                    disabled={steps.current.past.length === 0}
                                    title="Undo a change to this filter (⌘Z)"
                                >
                                    ↶
                                </FooterButton>
                                <FooterButton
                                    onClick={() => stepDraft("redo")}
                                    disabled={steps.current.future.length === 0}
                                    title="Redo (⇧⌘Z)"
                                >
                                    ↷
                                </FooterButton>
                                <FooterButton
                                    onClick={() => load(emptyFilter(), null)}
                                    disabled={!pruned && !draftFeed}
                                >
                                    Clear
                                </FooterButton>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {confirmDelete && (
                <ConfirmDialog
                    title="Delete feed?"
                    message={`Delete the saved feed "${confirmDelete.name}"? The filter you're building isn't affected.`}
                    confirmText="Delete"
                    onConfirm={() => void deleteFeed(confirmDelete)}
                    onCancel={() => setConfirmDelete(null)}
                />
            )}
        </div>,
        document.body,
    );
}

function ListSection({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
    return (
        <div className="flex flex-col gap-0.5">
            <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
                {title}
            </p>
            {children}
        </div>
    );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
    <p className="px-2 text-[11px] text-neutral-600">{children}</p>
);

function FooterButton({
    className = "",
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
    return (
        <button
            {...props}
            className={`rounded px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
        />
    );
}

// ── The tree editor ─────────────────────────────────────────────────────────

type EditFns = {
    /** `mergeKey`: an edit with the same key as the last one joins its
     *  undo step (typing a count). */
    edit: (path: Path, fn: (n: FilterNode) => FilterNode | null, mergeKey?: string) => void;
    addTo: (path: Path, item: FilterNode) => void;
};

/** A group's items, joined by its word, with the controls to add more. */
function GroupEditor({
    group,
    path,
    edit,
    addTo,
    autoFocus = false,
}: { group: FilterGroup; path: Path; autoFocus?: boolean } & EditFns): JSX.Element {
    const flipOp = () =>
        edit(path, (g) => (g.kind === "group" ? { ...g, op: g.op === "and" ? "or" : "and" } : g));

    return (
        <div className="flex flex-col gap-1.5">
            {group.items.length === 0 && (
                <p className="text-xs text-neutral-600">
                    {path.length === 0 ? "No filter: everything shows. Add a tag to start." : "Empty group (ignored)."}
                </p>
            )}
            {group.items.map((item, i) => (
                <div key={i} className="flex items-start gap-2">
                    <div className="w-9 shrink-0 pt-1 text-right">
                        {i > 0 && (
                            <button
                                onClick={flipOp}
                                title="Switch every joining word in this group"
                                className="rounded px-1 text-[11px] font-semibold text-sky-400 hover:bg-neutral-800"
                            >
                                {group.op.toUpperCase()}
                            </button>
                        )}
                    </div>
                    <ItemEditor node={item} path={[...path, i]} edit={edit} addTo={addTo} />
                </div>
            ))}
            <div className="flex items-center gap-2 pl-11">
                <FilterTagSearch onPick={(id) => addTo(path, { kind: "tag", id })} autoFocus={autoFocus} />
                <AddButton onClick={() => addTo(path, { kind: "count", op: "=", n: 0, from: "all" })}>
                    + tag count
                </AddButton>
                <AddButton onClick={() => addTo(path, emptyFilter())}>+ group</AddButton>
            </div>
        </div>
    );
}

const AddButton = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button
        onClick={onClick}
        className="shrink-0 rounded px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
    >
        {children}
    </button>
);

/** One item: its WITHOUT switch, what it is, and remove. */
function ItemEditor({ node, path, edit, addTo }: { node: FilterNode; path: Path } & EditFns): JSX.Element {
    const { tagMap, allTags, allCategories } = useTags();
    const broken = nodeIsBroken(node, allTags, allCategories);
    const toggleWithout = () => edit(path, (n) => ({ ...n, without: !n.without }));
    const remove = () => edit(path, () => null);

    const without = (
        <button
            onClick={toggleWithout}
            title={node.without ? "Turn off WITHOUT" : "WITHOUT: match files that don't fit this"}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                node.without
                    ? "bg-red-500/20 text-red-300"
                    : "text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
            }`}
        >
            WITHOUT
        </button>
    );
    const removeButton = (
        <button
            onClick={remove}
            title="Remove"
            className="shrink-0 px-1 text-xs text-neutral-600 hover:text-neutral-200"
        >
            ✕
        </button>
    );

    if (node.kind === "group") {
        return (
            <div className="flex min-w-0 flex-1 items-start gap-1.5">
                <div className="pt-0.5">{without}</div>
                <div className="min-w-0 flex-1 rounded-md border-x-2 border-neutral-600 px-2 py-1.5">
                    <GroupEditor group={node} path={path} edit={edit} addTo={addTo} />
                </div>
                <div className="pt-0.5">{removeButton}</div>
            </div>
        );
    }

    if (node.kind === "tag") {
        const tag = tagMap.get(node.id);
        return (
            <div className="flex items-center gap-1.5">
                {without}
                <span
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                        broken ? "bg-red-950 text-red-300 ring-1 ring-red-500" : "bg-neutral-200 text-neutral-900"
                    }`}
                >
                    {tag?.category && (
                        <span
                            className="rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none"
                            style={{ color: tag.category.color }}
                        >
                            {tag.category.icon}
                        </span>
                    )}
                    {tag?.name ?? "deleted tag"}
                </span>
                {removeButton}
            </div>
        );
    }

    const setCount = (patch: Partial<Extract<FilterNode, { kind: "count" }>>, mergeKey?: string) =>
        edit(path, (n) => (n.kind === "count" ? { ...n, ...patch } : n), mergeKey);
    const fromValue = typeof node.from === "number" ? String(node.from) : node.from;
    const select =
        "rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-600";
    return (
        <div className="flex items-center gap-1.5">
            {without}
            <select
                value={node.op}
                onChange={(e) => setCount({ op: e.target.value as "<" | "=" | ">" })}
                className={select}
            >
                <option value="<">&lt;</option>
                <option value="=">=</option>
                <option value=">">&gt;</option>
            </select>
            <input
                type="number"
                min={0}
                step={1}
                value={node.n}
                onChange={(e) => {
                    const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    setCount({ n }, `count-n:${path.join(".")}`);
                }}
                className={`${select} w-14 tabular-nums`}
            />
            <span className="text-xs text-neutral-400">tags from</span>
            <select
                value={fromValue}
                onChange={(e) => {
                    const v = e.target.value;
                    const from: CountFrom = v === "all" || v === "uncategorized" ? v : Number(v);
                    setCount({ from });
                }}
                className={`${select} ${broken ? "ring-1 ring-red-500 text-red-300" : ""}`}
            >
                <option value="all">all categories</option>
                {allCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                        {c.icon} {c.name}
                    </option>
                ))}
                <option value="uncategorized">uncategorized</option>
                {broken && <option value={fromValue}>deleted category</option>}
            </select>
            {removeButton}
        </div>
    );
}

/** Search box adding a tag to a group: type, then Enter or click a match. */
function FilterTagSearch({
    onPick,
    autoFocus,
}: {
    onPick: (tagId: number) => void;
    autoFocus: boolean;
}): JSX.Element {
    const { allTags } = useTags();
    const [input, setInput] = useState("");
    const [focused, setFocused] = useState(false);
    const [highlighted, setHighlighted] = useState(0);

    const matches = useMemo(() => {
        const q = input.trim().toLowerCase();
        if (!q) return [];
        return allTags
            .filter((t) => t.name.toLowerCase().includes(q))
            .sort((a, b) => {
                const aStart = a.name.toLowerCase().startsWith(q);
                const bStart = b.name.toLowerCase().startsWith(q);
                if (aStart !== bStart) return aStart ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 8);
    }, [input, allTags]);
    useEffect(() => setHighlighted(0), [input]);

    const pick = (id: number) => {
        onPick(id);
        setInput("");
    };

    return (
        <div className="relative w-48">
            <input
                autoFocus={autoFocus}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setTimeout(() => setFocused(false), 120)}
                onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setHighlighted((i) => Math.min(i + 1, matches.length - 1));
                    } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setHighlighted((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter" && matches[highlighted]) {
                        e.preventDefault();
                        pick(matches[highlighted].id);
                    }
                }}
                placeholder="+ tag…"
                className="w-full rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-500 outline-none focus:ring-1 focus:ring-neutral-600"
            />
            {focused && matches.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-neutral-700 bg-neutral-950 shadow-xl">
                    {matches.map((t, i) => (
                        <button
                            key={t.id}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                pick(t.id);
                            }}
                            onMouseEnter={() => setHighlighted(i)}
                            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-neutral-200 ${
                                i === highlighted ? "bg-neutral-800" : ""
                            }`}
                        >
                            {t.category?.icon && (
                                <span style={{ color: t.category.color }}>{t.category.icon}</span>
                            )}
                            {t.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
