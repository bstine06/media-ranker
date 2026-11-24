import { useTags } from "@renderer/contexts/TagsContext";
import { useDataVersion } from "@renderer/hooks/useHistoryVersion";
import {
    BatchTagResult,
    DbFile,
    DbTag,
    DbTagWithCategory,
    FolderRuleResult,
    FolderTagPreview,
    FolderNoPreview,
} from "@renderer/shared/types/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import CategoryGroup from "@renderer/components/CategoryGroup";
import { TagInput } from "@renderer/components/TagInput";
import { TagPill } from "@renderer/components/TagPill";
import ConfirmDialog from "@renderer/components/ConfirmDialog";
import { Effect, FolderRef, RichText, TagRef } from "@renderer/components/InlineRefs";
import { PendingState, usePendingChange } from "@renderer/contexts/PendingChangeContext";
import { affectedItems, plural, removesCount } from "@renderer/lib/pending";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useStatus } from "@renderer/contexts/StatusContext";
import { groupTagsByCategory } from "@renderer/lib/tagGroups";

/** "cat from 12 files, kitten from 3 files" */
function removedText(removed: { name: string; files: number }[]): string {
    return removed.map((r) => `"${r.name}" from ${plural(r.files, "file")}`).join(", ");
}

const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");

/** A batch about to run: the selection, the other files shown, and what
 *  it would do per tag. */
type BatchConfirm = {
    names: string[];
    selected: number[];
    rest: number[];
    mode: "yes" | "no";
    preview: BatchTagResult[];
};

/** A folder rule about to be turned into one on each file. */
type ConvertConfirm = { tag: string; kind: "tag" | "no"; files: number };

/** What the confirm says for one tag of a batch. */
function BatchTagLines({ r, selected, mode }: { r: BatchTagResult; selected: number; mode: "yes" | "no" }) {
    const blocked = r.blocked.reduce((n, b) => n + b.files, 0);
    const going = selected - blocked;
    const yes = mode === "yes";
    return (
        <div className="flex flex-col gap-1.5">
            {r.restChanged > 0 && (
                <Effect mark={yes ? "⊘" : "✓"} tone="strong">
                    {plural(r.restChanged, "other file")} shown get
                    {yes ? <>a pass no for <TagRef name={r.tag} no /></> : <TagRef name={r.tag} />}
                </Effect>
            )}
            {going > 0 && (
                <Effect mark={yes ? "✓" : "⊘"}>
                    {plural(going, "selected file")} get
                    {yes ? <TagRef name={r.tag} /> : <>a no for <TagRef name={r.tag} no /></>}
                </Effect>
            )}
            {r.removed.map((x) => (
                <Effect key={x.name} mark="−">
                    Takes <TagRef name={x.name} /> off {plural(x.files, "file")}
                </Effect>
            ))}
            {r.restUnchanged > 0 && (
                <Effect tone="muted">
                    {plural(r.restUnchanged, "other file")} shown already {r.restUnchanged === 1 ? "has" : "have"} an
                    answer: unchanged
                </Effect>
            )}
            {r.blocked.map((b) => (
                <div key={`${b.folder}:${b.tag}`} className="flex flex-col gap-1">
                    <Effect mark="!" tone="warn">
                        {plural(b.files, "selected file")} skipped:
                        <FolderRef path={b.path} />
                        {yes ? <>has a no for <TagRef name={b.tag} no /></> : <>gives <TagRef name={b.tag} /></>}
                    </Effect>
                    <Effect tone="muted">
                        <span className="w-3 shrink-0" />
                        To change that: right-click <TagRef name={b.tag} no={yes} /> in its folder panel →{" "}
                        {yes ? "Turn into a no on each file" : "Turn into a tag on each file"}
                    </Effect>
                </div>
            ))}
        </div>
    );
}

export default function FolderTagPanel({
    folderTags,
    onAddFolderTag,
    onRemoveFolderTag,
    onFolderTagsChanged,
    selectedFiles = [],
    shownFiles = [],
    onAfterBatch,
}: {
    folderTags: DbTag[];
    onAddFolderTag: (tag: string) => Promise<FolderRuleResult>;
    onRemoveFolderTag: (tag: string) => Promise<void>;
    /** A folder no swapped out one of the folder's tags: reread them. */
    onFolderTagsChanged: () => Promise<void>;
    selectedFiles?: DbFile[]; // Current Browse selection
    /** Every file Browse shows now (the batch's "other files shown"). */
    shownFiles?: DbFile[];
    /** After a batch ran (refresh what it changed). */
    onAfterBatch?: () => void;
}): JSX.Element {
    // Staged tags for batch operation
    const [stagedTags, setStagedTags] = useState<DbTag[]>([]);
    // The batch applies its tags as yeses or (red) as noes.
    const [batchNoMode, setBatchNoMode] = useState(false);

    const { allTags, refreshTags, getTagsWithCategory, tagMap } = useTags();
    const { activeFolder } = useFolders();
    const { setStatus, resetStatus } = useStatus();

    const [folderNoes, setFolderNoes] = useState<DbTag[]>([]);
    const [error, setError] = useState<string | null>(null);
    const { requestChange } = usePendingChange();
    const [batchConfirm, setBatchConfirm] = useState<BatchConfirm | null>(null);
    const [convert, setConvert] = useState<ConvertConfirm | null>(null);
    // A tag that just moved between the folder's tags and noes (a swap).
    const [glow, setGlow] = useState<number | null>(null);

    const dataVersion = useDataVersion();
    const loadNoes = useCallback(async () => {
        if (!activeFolder) {
            setFolderNoes([]);
            return;
        }
        setFolderNoes(await window.api.getFolderNoes(activeFolder));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFolder, dataVersion]);
    useEffect(() => setError(null), [activeFolder]);
    useEffect(() => {
        void loadNoes();
    }, [loadNoes]);
    useEffect(() => {
        if (glow == null) return;
        const t = setTimeout(() => setGlow(null), 1400);
        return () => clearTimeout(t);
    }, [glow]);
    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 6000);
        return () => clearTimeout(t);
    }, [error]);

    const folderTagsWithCategory = useMemo(
        () => getTagsWithCategory(folderTags),
        [folderTags, getTagsWithCategory],
    );

    const stagedTagsWithCategory = useMemo(
        () => getTagsWithCategory(stagedTags),
        [stagedTags, getTagsWithCategory],
    );

    const findTagId = useCallback(
        (name: string) => allTags.find((t) => t.name === name)?.id ?? null,
        [allTags],
    );

    // Picking an existing tag or creating one: add-tag-to-folder upserts the
    // tag without touching its category. A tag that's a folder no swaps.
    const commitFolderTag = useCallback(
        async (trimmed: string) => {
            const wasNo = folderNoes.some((t) => t.name === trimmed);
            const res = await onAddFolderTag(trimmed);
            await refreshTags();
            if (!res.ok) {
                setError(res.error);
                return;
            }
            setError(null);
            if (wasNo) {
                await loadNoes();
                setGlow(findTagId(trimmed));
            }
        },
        [folderNoes, onAddFolderTag, refreshTags, loadNoes, findTagId],
    );

    // Files in the folder marked no for the tag: confirm clearing those
    // noes first; refused outright when the folder would contradict itself.
    const addFolderTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) return;
            if (activeFolder) {
                const preview = await window.api.previewFolderTag(activeFolder, trimmed);
                if ("error" in preview) {
                    setError(preview.error);
                    return;
                }
                if (preview.files > 0) {
                    const folder = activeFolder;
                    const stateOf = (p: FolderTagPreview | { error: string }): PendingState =>
                        "error" in p ? { items: [], lines: [p.error] } : { items: affectedItems(p.affected) };
                    await requestChange({
                        title: (
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                                Add <TagRef name={trimmed} /> to <FolderRef path={folder} />?
                            </span>
                        ),
                        message: (
                            <div className="flex flex-col gap-1.5">
                                <Effect mark="✓">
                                    Every file in <FolderRef path={folder} /> gets <TagRef name={trimmed} />
                                </Effect>
                                {preview.cleared.map((c) => (
                                    <Effect key={c.name} mark="−">
                                        Will remove 'no' for <TagRef name={c.name} no /> from{" "}
                                        {plural(c.files, "file")}
                                    </Effect>
                                ))}
                            </div>
                        ),
                        dockTitle: `Folder tag pending: "${trimmed}" → ${folder}`,
                        initial: stateOf(preview),
                        load: async () => stateOf(await window.api.previewFolderTag(folder, trimmed)),
                        confirm: {
                            label: (live) =>
                                live.items.length > 0
                                    ? `Clear noes on ${plural(live.items.length, "file")} and add`
                                    : "Add to the folder",
                            run: () => commitFolderTag(trimmed),
                        },
                    });
                    return;
                }
            }
            await commitFolderTag(trimmed);
        },
        [activeFolder, folderTags, commitFolderTag, requestChange],
    );

    const removeFolderTag = useCallback(
        async (tag: DbTag) => {
            await onRemoveFolderTag(tag.name);
        },
        [onRemoveFolderTag],
    );

    const commitFolderNo = useCallback(
        async (name: string) => {
            if (!activeFolder) return;
            const res = await window.api.addFolderNo(activeFolder, name);
            await refreshTags();
            if (!res.ok) {
                setError(res.error);
                return;
            }
            setError(null);
            const swapped = folderTags.some((t) => t.name === name);
            await loadNoes();
            await onFolderTagsChanged();
            if (swapped) setGlow(findTagId(name));
        },
        [activeFolder, folderTags, refreshTags, loadNoes, onFolderTagsChanged, findTagId],
    );

    // A folder no: if it would take tags off the folder's files, confirm
    // first; refused outright when the folder would contradict itself.
    const addFolderNo = useCallback(
        async (name: string) => {
            if (!activeFolder) return;
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderNoes.some((t) => t.name === trimmed)) return;
            const preview = await window.api.previewFolderNo(activeFolder, trimmed);
            if ("error" in preview) {
                setError(preview.error);
                return;
            }
            if (preview.files > 0) {
                const folder = activeFolder;
                const stateOf = (p: FolderNoPreview | { error: string }): PendingState =>
                    "error" in p
                        ? { items: [], lines: [p.error] }
                        : {
                              items: affectedItems(p.affected),
                              lines: p.swap ? [`Replaces the folder's tag "${trimmed}".`] : [],
                              removes: removesCount(p.affected),
                          };
                await requestChange({
                    title: (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                            <TagRef name={trimmed} no /> in <FolderRef path={folder} />?
                        </span>
                    ),
                    message: (
                        <div className="flex flex-col gap-1.5">
                            <Effect mark="⊘">
                                No file in <FolderRef path={folder} /> can have <TagRef name={trimmed} />
                            </Effect>
                            {preview.swap && (
                                <Effect mark="−">
                                    Replaces the folder's tag <TagRef name={trimmed} />
                                </Effect>
                            )}
                            {preview.removed.map((r) => (
                                <Effect key={r.name} mark="−">
                                    Will remove <TagRef name={r.name} /> from {plural(r.files, "file")}
                                </Effect>
                            ))}
                        </div>
                    ),
                    dockTitle: `Folder no pending: not "${trimmed}" in ${folder}`,
                    initial: stateOf(preview),
                    load: async () => stateOf(await window.api.previewFolderNo(folder, trimmed)),
                    confirm: {
                        label: (live) =>
                            live.items.length > 0
                                ? `Add the no · removes ${plural(live.removes ?? 0, "tag")}`
                                : "Add the no",
                        run: () => commitFolderNo(trimmed),
                    },
                });
                return;
            }
            await commitFolderNo(trimmed);
        },
        [activeFolder, folderNoes, commitFolderNo, requestChange],
    );

    const removeFolderNo = useCallback(
        async (tag: DbTag) => {
            if (!activeFolder) return;
            await window.api.removeFolderNo(activeFolder, tag.name);
            await loadNoes();
            refreshTags();
        },
        [activeFolder, loadNoes, refreshTags],
    );

    const addStagedTag = useCallback(
        (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || stagedTags.some((t) => t.name === trimmed)) return;

            // Find the full tag object from allTags
            const newTag = allTags.find((t) => t.name === trimmed);

            if (newTag) setStagedTags((prev) => [...prev, newTag]);
        },
        [stagedTags, allTags],
    );

    // Creates a brand-new tag record, then stages it directly using the
    // object the API returns — doesn't rely on a (possibly stale) allTags
    // lookup, since refreshTags() hasn't necessarily resolved yet.
    const createStagedTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || stagedTags.some((t) => t.name === trimmed)) return;

            // Reuse an existing tag if there is one — createTag(name, null) would
            // wipe that tag's category.
            const existing = allTags.find((t) => t.name === trimmed);
            const newTag = existing ?? (await window.api.createTag(trimmed, null));
            if (!existing) await refreshTags();

            if (newTag) {
                setStagedTags((prev) => [...prev, newTag]);
            }
        },
        [stagedTags, allTags, refreshTags],
    );

    const removeStagedTag = useCallback((tag: DbTag) => {
        setStagedTags((prev) => prev.filter((t) => t.id !== tag.id));
    }, []);

    // Apply: always confirms, with what it does to the selection and to the
    // other files shown (frozen now).
    const executeBatch = useCallback(async () => {
        if (stagedTags.length === 0 || selectedFiles.length === 0) return;
        const names = stagedTags.map((t) => t.name);
        const selected = selectedFiles.map((f) => f.id);
        const chosen = new Set(selected);
        const rest = shownFiles.filter((f) => !chosen.has(f.id)).map((f) => f.id);
        const mode = batchNoMode ? "no" : "yes";
        const preview = await window.api.previewBatchApply(selected, rest, names, mode);
        setBatchConfirm({ names, selected, rest, mode, preview });
    }, [stagedTags, selectedFiles, shownFiles, batchNoMode]);

    const runBatch = useCallback(
        async (b: BatchConfirm, withRest: boolean) => {
            setBatchConfirm(null);
            const res = await window.api.batchApply(b.selected, withRest ? b.rest : [], b.names, b.mode);
            await refreshTags();
            onAfterBatch?.();
            onFolderTagsChanged?.();
            loadNoes();
            setStagedTags([]);
            const others = Math.max(0, ...res.map((r) => r.restChanged));
            const skipped = Math.max(0, ...res.map((r) => r.blocked.reduce((n, x) => n + x.files, 0)));
            setStatus(
                (b.mode === "yes"
                    ? `Tagged ${plural(b.selected.length - skipped, "file")} ${quoted(b.names)}`
                    : `Not ${quoted(b.names)} on ${plural(b.selected.length - skipped, "file")}`) +
                    (others > 0
                        ? b.mode === "yes"
                            ? ` · pass no on ${plural(others, "other file")}`
                            : ` · tagged ${plural(others, "other file")}`
                        : "") +
                    (skipped > 0 ? ` · ${plural(skipped, "file")} skipped (folder rule)` : ""),
            );
            setTimeout(resetStatus, 4000);
        },
        [refreshTags, onAfterBatch, onFolderTagsChanged, loadNoes, setStatus, resetStatus],
    );

    const runConvert = useCallback(
        async (c: ConvertConfirm) => {
            setConvert(null);
            if (!activeFolder) return;
            await window.api.convertFolderRule(activeFolder, c.tag, c.kind);
            await refreshTags();
            await onFolderTagsChanged();
            await loadNoes();
        },
        [activeFolder, refreshTags, onFolderTagsChanged, loadNoes],
    );

    const askConvert = useCallback(
        async (tag: string, kind: "tag" | "no") => {
            if (!activeFolder) return;
            setConvert({ tag, kind, files: await window.api.countFolderFiles(activeFolder) });
        },
        [activeFolder],
    );

    const noPills = folderNoes.map((t) => (tagMap.get(t.id) ?? t) as DbTagWithCategory);

    return (
        <div className="flex flex-col w-full h-full bg-neutral-900 border-neutral-800 overflow-y-auto">
            {activeFolder && (
                <>
                    {/* Header */}
                    <div className="px-4 py-3 border-b border-neutral-800">
                        <p className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">
                            Folder Tags
                        </p>
                        <p className="text-xs text-neutral-500 italic">
                            Applies to all current and future files.
                        </p>
                    </div>
                    {/* Applied tags */}
                    <div className="px-3 py-3 space-y-2">
                        {groupTagsByCategory(folderTagsWithCategory).map((g) => (
                            <CategoryGroup
                                key={g.label}
                                applied={true}
                                activeTags={folderTagsWithCategory}
                                group={g}
                                onRemoveTag={removeFolderTag}
                                onAddTag={addFolderTag}
                                glowTagId={glow}
                                pillMenu={(t) => [
                                    { label: "Turn into a tag on each file", onClick: () => void askConvert(t.name, "tag") },
                                ]}
                            />
                        ))}
                    </div>

                    <TagInput
                        exclude={folderTags}
                        onPick={addFolderTag}
                        onCreate={addFolderTag}
                        className="px-3 pb-3"
                    />

                    {/* The folder's noes, set apart from its tags. */}
                    <div className="px-4 pt-1 pb-2">
                        <p className="text-[11px] uppercase tracking-wider text-red-300/70 font-medium">
                            Not in this folder
                        </p>
                        <p className="text-xs text-neutral-500 italic">
                            None of its files have these, now or later.
                        </p>
                    </div>
                    {noPills.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                            {noPills.map((t) => (
                                <TagPill
                                    key={t.id}
                                    tag={t}
                                    applied
                                    no
                                    title={`Not allowed in ${activeFolder}`}
                                    onRemove={() => removeFolderNo(t)}
                                    menuItems={[
                                        { label: "Turn into a no on each file", onClick: () => void askConvert(t.name, "no") },
                                    ]}
                                    className={glow === t.id ? "ring-2 ring-amber-300/70 animate-pulse" : ""}
                                />
                            ))}
                        </div>
                    )}
                    <TagInput
                        exclude={folderNoes}
                        onPick={addFolderNo}
                        onCreate={addFolderNo}
                        placeholder="Add a no…"
                        danger
                        className="px-3 pb-3"
                    />
                    {error && <p className="px-4 pb-3 text-[11px] text-red-300/90"><RichText text={error} /></p>}
                </>
            )}

            {/* Batch Tag Section */}
            <div className="border-t border-neutral-800">
                {/* Header */}
                <div className="px-4 py-3 border-b border-neutral-800">
                    <p className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">
                        Batch Tag
                    </p>
                    <p className="text-xs text-neutral-500 italic">
                        {batchNoMode
                            ? "Mark the files selected in Browse as not having these tags. The other files shown can get them instead."
                            : "Add tags to the files selected in Browse. The other files shown can get a no for them."}
                    </p>
                </div>

                {/* Staged tags */}
                {stagedTags.length > 0 && (
                    <div className="px-3 py-3 space-y-2">
                        {groupTagsByCategory(stagedTagsWithCategory).map((g) => (
                            <CategoryGroup
                                key={g.label}
                                applied={true}
                                activeTags={stagedTagsWithCategory}
                                group={g}
                                onRemoveTag={removeStagedTag}
                                onAddTag={addStagedTag}
                            />
                        ))}
                    </div>
                )}

                <TagInput
                    exclude={stagedTags}
                    onPick={addStagedTag}
                    onCreate={createStagedTag}
                    className="px-3 py-3"
                />

                {/* Action: yes or no, then apply */}
                <div className="px-3 pb-3">
                    <div className="mb-2 flex items-center gap-1 rounded-md bg-neutral-950 p-0.5">
                        {([false, true] as const).map((no) => (
                            <button
                                key={String(no)}
                                onClick={() => setBatchNoMode(no)}
                                className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                                    batchNoMode === no
                                        ? no
                                            ? "bg-red-900/70 text-red-100"
                                            : "bg-neutral-700 text-neutral-100"
                                        : "text-neutral-500 hover:text-neutral-300"
                                }`}
                            >
                                {no ? "No" : "Yes"}
                            </button>
                        ))}
                    </div>
                    <button
                        onClick={executeBatch}
                        disabled={stagedTags.length === 0 || selectedFiles.length === 0}
                        className={`w-full px-3 py-1.5 text-xs font-medium disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-md transition-colors ${
                            batchNoMode ? "bg-red-700 hover:bg-red-800" : "bg-blue-600 hover:bg-blue-700"
                        }`}
                    >
                        {batchNoMode ? "Not on " : "Apply to "}
                        {selectedFiles.length} selected file
                        {selectedFiles.length !== 1 ? "s" : ""}
                    </button>
                    {selectedFiles.length === 0 && (
                        <p className="mt-2 text-xs text-neutral-500 italic">
                            Select files with ⌘-click, the Select button, or ⌘A.
                        </p>
                    )}
                </div>
            </div>

            {batchConfirm && (() => {
                const b = batchConfirm;
                const n = b.selected.length;
                const others = Math.max(0, ...b.preview.map((r) => r.restChanged));
                const what = b.mode === "yes" ? `Yes on ${n.toLocaleString()}` : `No on ${n.toLocaleString()}`;
                const opposite = b.mode === "yes" ? "no" : "yes";
                return (
                    <ConfirmDialog
                        title={
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                                {b.mode === "yes" ? "Tag" : "Mark"}
                                {b.names.map((nm) => (
                                    <TagRef key={nm} name={nm} no={b.mode === "no"} />
                                ))}
                                {b.mode === "yes" ? "on" : "as no on"} {plural(n, "file")}?
                            </span>
                        }
                        message={
                            <div className="flex flex-col gap-3">
                                {b.preview.map((r) => (
                                    <div key={r.tag}>
                                        {b.preview.length > 1 && (
                                            <div className="mb-1.5">
                                                <TagRef name={r.tag} no={b.mode === "no"} />
                                            </div>
                                        )}
                                        <BatchTagLines r={r} selected={n} mode={b.mode} />
                                    </div>
                                ))}
                            </div>
                        }
                        danger={b.mode === "no"}
                        confirmText={others > 0 ? `${what} · ${opposite} on ${others.toLocaleString()}` : what}
                        onConfirm={() => void runBatch(b, true)}
                        onCancel={() => setBatchConfirm(null)}
                        secondary={
                            others > 0
                                ? {
                                      text: `Only the ${n.toLocaleString()} selected`,
                                      onClick: () => void runBatch(b, false),
                                  }
                                : undefined
                        }
                    />
                );
            })()}

            {convert && (
                <ConfirmDialog
                    title={
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                            Turn <TagRef name={convert.tag} no={convert.kind === "no"} /> into{" "}
                            {convert.kind === "no" ? "a no" : "a tag"} on each file?
                        </span>
                    }
                    message={
                        <div className="flex flex-col gap-1.5">
                            <Effect mark="−">
                                Will remove <TagRef name={convert.tag} no={convert.kind === "no"} /> from{" "}
                                <FolderRef path={activeFolder ?? ""} />
                            </Effect>
                            <Effect mark={convert.kind === "no" ? "⊘" : "✓"}>
                                Its {plural(convert.files, "file")} each get{" "}
                                {convert.kind === "no" ? "their own" : "it as their own"}{" "}
                                <TagRef name={convert.tag} no={convert.kind === "no"} />
                            </Effect>
                            <Effect tone="muted">Files added to the folder later won't get it</Effect>
                        </div>
                    }
                    danger={false}
                    confirmText={convert.kind === "no" ? "Turn into a no on each file" : "Turn into a tag on each file"}
                    onConfirm={() => void runConvert(convert)}
                    onCancel={() => setConvert(null)}
                />
            )}
        </div>
    );
}
