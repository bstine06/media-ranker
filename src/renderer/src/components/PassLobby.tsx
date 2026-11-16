import { useEffect, useMemo, useState } from "react";
import { usePass, tagPosition, type PassWhich } from "@renderer/contexts/PassContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { filterKey } from "@renderer/lib/tagFilters";
import { SORTS, type PassOrder } from "@renderer/lib/sorts";
import type { SortMode } from "@renderer/browse/types/browserTypes";
import { ScopeSummary } from "./ScopeSummary";
import { TagPill } from "./TagPill";
import { TagInput } from "./TagInput";

// The pass lobby: set up a run before it starts, like a game lobby. It
// takes Sweep's place in the main area (not a dialog), so the sidebar's
// collections and tag filter stay usable while it's open: the files come
// from that selection, shown here live. The rest is chosen here: tags in
// order, which files, and their order.

const ORDERS: PassOrder[] = ["alphabetical", "rank", "fileSize", "added", "compared", "shuffled"];
const orderLabel = (o: PassOrder) => (o === "shuffled" ? "Shuffled" : SORTS[o].title.replace(/^Sort by /, ""));

const num = (n: number) => n.toLocaleString();

export default function PassLobby(): JSX.Element | null {
    const { lobby, updateLobby, closeLobby, startRun, run, resumeRun } = usePass();
    const unfinished = run && run.t < run.tags.length ? run : null;
    const tp = unfinished ? tagPosition(unfinished) : null;
    const { tagMap, activeFilter, loadedFeed, filter } = useTags();
    const { folderPrefixes } = useFolders();
    const { passOrder, setPassOrder, passDirection, setPassDirection } = useSettings();

    const scopeKey = JSON.stringify([folderPrefixes, filterKey(activeFilter)]);
    const feedName =
        loadedFeed && filterKey(loadedFeed.tree) === filterKey(filter) ? loadedFeed.name : null;

    // Files in the selection.
    const [scopeFiles, setScopeFiles] = useState<number | null>(null);
    useEffect(() => {
        if (!lobby) return;
        let gone = false;
        setScopeFiles(null);
        window.api
            .countScope(folderPrefixes, activeFilter)
            .then((n) => !gone && setScopeFiles(n))
            .catch(() => {});
        return () => {
            gone = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [!!lobby, scopeKey]);

    // Each tag's estimated list size (later tags may shrink as earlier
    // ones imply them).
    const tagIds = lobby?.tagIds ?? [];
    const which = lobby?.which ?? "needs-firm";
    const [counts, setCounts] = useState<Record<number, number>>({});
    useEffect(() => {
        if (!lobby || tagIds.length === 0) return;
        let gone = false;
        window.api
            .getPassCounts(folderPrefixes, activeFilter, tagIds, which)
            .then((c) => !gone && setCounts(c))
            .catch(() => {});
        return () => {
            gone = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [!!lobby, scopeKey, tagIds.join(","), which]);

    const tags = useMemo(
        () => tagIds.map((id) => tagMap.get(id)).filter((t): t is NonNullable<typeof t> => !!t),
        [tagIds, tagMap],
    );
    const total = tags.reduce((s, t) => s + (counts[t.id] ?? 0), 0);

    if (!lobby) return null;

    const move = (i: number, by: -1 | 1) => {
        const next = [...tagIds];
        const j = i + by;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        updateLobby({ tagIds: next });
    };
    const remove = (id: number) => updateLobby({ tagIds: tagIds.filter((t) => t !== id) });
    const add = (name: string) => {
        const tag = [...tagMap.values()].find((t) => t.name === name);
        if (tag && !tagIds.includes(tag.id)) updateLobby({ tagIds: [...tagIds, tag.id] });
    };

    const section = "text-[11px] font-medium uppercase tracking-wider text-neutral-500";

    return (
        <div className="flex flex-1 justify-center overflow-y-auto bg-neutral-950 px-4 py-8">
            <div className="flex h-fit w-[36rem] max-w-full flex-col rounded-lg border border-neutral-800 bg-neutral-900">
                <div className="border-b border-neutral-800 px-5 py-3">
                    <h2 className="text-sm font-semibold text-neutral-100">New pass</h2>
                    <p className="text-[11px] text-neutral-500">
                        Go through a fixed list of files, one tag at a time.
                    </p>
                </div>

                {/* The unfinished pass, to pick up instead (its own files). */}
                {unfinished && tp && (
                    <div className="flex flex-col gap-2 border-b border-neutral-800 bg-neutral-950/40 px-5 py-3">
                        <div className="flex items-center gap-3">
                            <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                                Unfinished pass
                            </span>
                            <span className="text-xs text-neutral-300 tabular-nums">
                                tag {tp.n} of {tp.of}
                                {tp.rest && " (rest)"} · {Math.max(0, unfinished.pos + 1)} /{" "}
                                {unfinished.tags[unfinished.t].files?.length ?? 0}
                            </span>
                            <button
                                onClick={resumeRun}
                                className="ml-auto rounded bg-neutral-200 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
                            >
                                Resume
                            </button>
                        </div>
                        {(() => {
                            const t = tagMap.get(unfinished.tags[unfinished.t].tagId);
                            return t ? (
                                <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                                    On <TagPill tag={t} applied />
                                </div>
                            ) : null;
                        })()}
                        <ScopeSummary
                            folderPrefixes={unfinished.scope.folderPrefixes}
                            filter={unfinished.scope.filter}
                            feedName={unfinished.scope.feedName}
                        />
                        <p className="text-[11px] text-neutral-600">
                            Starting a new pass below replaces it.
                        </p>
                    </div>
                )}

                <div className="flex flex-col gap-5 px-5 py-4">
                    {/* Files: the current selection, shown as it was set. */}
                    <div className="flex flex-col gap-2">
                        <span className={section}>Files</span>
                        <ScopeSummary
                            folderPrefixes={folderPrefixes}
                            filter={activeFilter}
                            feedName={feedName}
                            files={scopeFiles}
                        />
                        <p className="text-[11px] text-neutral-600">
                            The collections ticked in the sidebar and the tag filter. Change them
                            there and this updates.
                        </p>
                    </div>

                    {/* Tags, in order. */}
                    <div className="flex flex-col gap-2">
                        <span className={section}>Tags, in order</span>
                        {tags.length === 0 && (
                            <p className="text-xs text-neutral-600">Add the tags to pass on.</p>
                        )}
                        {tags.map((t, i) => (
                            <div key={t.id} className="flex items-center gap-2">
                                <span className="w-4 text-right text-xs text-neutral-600 tabular-nums">
                                    {i + 1}
                                </span>
                                <TagPill tag={t} applied />
                                <span className="flex-1 text-xs text-neutral-500 tabular-nums">
                                    {counts[t.id] == null ? "…" : `${num(counts[t.id])} files`}
                                </span>
                                <button
                                    onClick={() => move(i, -1)}
                                    disabled={i === 0}
                                    title="Earlier"
                                    className="px-1 text-xs text-neutral-500 hover:text-neutral-200 disabled:text-neutral-800"
                                >
                                    ↑
                                </button>
                                <button
                                    onClick={() => move(i, 1)}
                                    disabled={i === tags.length - 1}
                                    title="Later"
                                    className="px-1 text-xs text-neutral-500 hover:text-neutral-200 disabled:text-neutral-800"
                                >
                                    ↓
                                </button>
                                <button
                                    onClick={() => remove(t.id)}
                                    title="Remove"
                                    className="px-1 text-xs text-neutral-600 hover:text-neutral-200"
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                        <TagInput
                            exclude={tags}
                            onPick={add}
                            onCreate={() => {}}
                            className="pl-6"
                        />
                        {tags.length > 1 && (
                            <p className="pl-6 text-[11px] text-neutral-500 tabular-nums">
                                About {num(total)} files in all. Later tags can shrink as earlier
                                ones imply them.
                            </p>
                        )}
                    </div>

                    {/* Which files. */}
                    <div className="flex flex-col gap-2">
                        <span className={section}>Which files</span>
                        {(
                            [
                                [
                                    "needs-firm",
                                    "Needs a firm answer",
                                    "Skips files already tagged, or with a firm no. Files only seen in Sweep are included, so they get a firm answer.",
                                ],
                                [
                                    "all",
                                    "Every file (audit)",
                                    "Every file in the selection, tagged or not: for checking tags you think need it.",
                                ],
                            ] as [PassWhich, string, string][]
                        ).map(([w, label, hint]) => (
                            <label key={w} className="flex cursor-pointer items-start gap-2">
                                <input
                                    type="radio"
                                    checked={which === w}
                                    onChange={() => updateLobby({ which: w })}
                                    className="mt-0.5 accent-white"
                                />
                                <span className="flex flex-col">
                                    <span className="text-xs text-neutral-200">{label}</span>
                                    <span className="text-[11px] text-neutral-500">{hint}</span>
                                </span>
                            </label>
                        ))}
                    </div>

                    {/* Order. */}
                    <div className="flex flex-col gap-2">
                        <span className={section}>Order</span>
                        <div className="flex items-center gap-2">
                            <select
                                value={passOrder}
                                onChange={(e) => setPassOrder(e.target.value as PassOrder)}
                                className="w-48 min-w-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-600"
                            >
                                {ORDERS.map((o) => (
                                    <option key={o} value={o}>
                                        {orderLabel(o)}
                                    </option>
                                ))}
                            </select>
                            {passOrder !== "shuffled" && (
                                <button
                                    onClick={() => setPassDirection(passDirection === "down" ? "up" : "down")}
                                    title="Reverse the order"
                                    className="shrink-0 whitespace-nowrap rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:text-neutral-100"
                                >
                                    {SORTS[passOrder as SortMode].order[passDirection]}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-3">
                    <button
                        onClick={closeLobby}
                        className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void startRun()}
                        disabled={tags.length === 0}
                        title={tags.length === 0 ? "Add a tag first" : undefined}
                        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                            tags.length === 0
                                ? "cursor-default bg-neutral-800 text-neutral-600"
                                : "bg-neutral-200 text-neutral-900 hover:bg-white"
                        }`}
                    >
                        Start
                    </button>
                </div>
            </div>
        </div>
    );
}
