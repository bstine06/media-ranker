import { useTags } from "@renderer/contexts/TagsContext";
import { useHistoryVersion } from "@renderer/hooks/useHistoryVersion";
import {
    BatchNoPreview,
    DbFile,
    DbTag,
    DbTagWithCategory,
    FolderNoPreview,
    FolderRuleResult,
} from "@renderer/shared/types/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import CategoryGroup from "@renderer/components/CategoryGroup";
import { TagInput } from "@renderer/components/TagInput";
import { TagPill } from "@renderer/components/TagPill";
import ConfirmDialog from "@renderer/components/ConfirmDialog";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useStatus } from "@renderer/contexts/StatusContext";
import { groupTagsByCategory } from "@renderer/lib/tagGroups";

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** "cat from 12 files, kitten from 3 files" */
function removedText(removed: { name: string; files: number }[]): string {
    return removed.map((r) => `"${r.name}" from ${plural(r.files, "file")}`).join(", ");
}

// A pending confirm: adding a folder no that takes tags off files, or a
// batch no that removes tags or meets conflicts.
type Pending =
    | { kind: "folderNo"; name: string; preview: FolderNoPreview }
    | { kind: "batchNo"; names: string[]; files: DbFile[]; preview: BatchNoPreview };

export default function FolderTagPanel({
    folderTags,
    onAddFolderTag,
    onRemoveFolderTag,
    onFolderTagsChanged,
    selectedFiles = [],
    onExecuteBatchTag,
    onAfterBatchNo,
}: {
    folderTags: DbTag[];
    onAddFolderTag: (tag: string) => Promise<FolderRuleResult>;
    onRemoveFolderTag: (tag: string) => Promise<void>;
    /** A folder no swapped out one of the folder's tags: reread them. */
    onFolderTagsChanged: () => Promise<void>;
    selectedFiles?: DbFile[]; // Current Browse selection
    onExecuteBatchTag?: (tagNames: string[], files: DbFile[]) => Promise<void>;
    onAfterBatchNo?: () => void;
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
    const [pending, setPending] = useState<Pending | null>(null);
    // A tag that just moved between the folder's tags and noes (a swap).
    const [glow, setGlow] = useState<number | null>(null);

    const historyVersion = useHistoryVersion();
    const loadNoes = useCallback(async () => {
        if (!activeFolder) {
            setFolderNoes([]);
            return;
        }
        setFolderNoes(await window.api.getFolderNoes(activeFolder));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFolder, historyVersion]);
    useEffect(() => {
        setError(null);
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
    const addFolderTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) return;
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
        [folderTags, folderNoes, onAddFolderTag, refreshTags, loadNoes, findTagId],
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
                setPending({ kind: "folderNo", name: trimmed, preview });
                return;
            }
            await commitFolderNo(trimmed);
        },
        [activeFolder, folderNoes, commitFolderNo],
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

    const commitBatchNo = useCallback(
        async (names: string[], files: DbFile[]) => {
            const ids = files.map((f) => f.id);
            // All the tags in one call: one undo entry.
            const res = await window.api.batchNo(ids, names);
            const conflicts = res.conflicts;
            await refreshTags();
            onAfterBatchNo?.();
            setStagedTags([]);
            const what = names.map((n) => `"${n}"`).join(", ");
            setStatus(
                `Not ${what} on ${plural(files.length, "file")}` +
                    (conflicts > 0
                        ? ` · ${plural(conflicts, "conflict")} with a folder (see Coverage)`
                        : ""),
            );
            setTimeout(resetStatus, 4000);
        },
        [refreshTags, onAfterBatchNo, setStatus, resetStatus],
    );

    const executeBatch = useCallback(async () => {
        if (stagedTags.length === 0 || selectedFiles.length === 0) return;
        const tagNames = stagedTags.map((t) => t.name);
        if (!batchNoMode) {
            await onExecuteBatchTag?.(tagNames, selectedFiles);
            setStagedTags([]);
            return;
        }
        // Noes: confirm when tags would come off or a folder disagrees.
        const ids = selectedFiles.map((f) => f.id);
        const total: BatchNoPreview = { removed: [], files: 0, conflicts: 0 };
        for (const name of tagNames) {
            const p = await window.api.previewBatchNo(ids, name);
            total.removed.push(...p.removed);
            total.conflicts += p.conflicts;
            total.files = Math.max(total.files, p.files);
        }
        if (total.removed.length > 0 || total.conflicts > 0) {
            setPending({ kind: "batchNo", names: tagNames, files: selectedFiles, preview: total });
            return;
        }
        await commitBatchNo(tagNames, selectedFiles);
    }, [stagedTags, selectedFiles, batchNoMode, onExecuteBatchTag, commitBatchNo]);

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
                    {error && <p className="px-4 pb-3 text-[11px] text-red-300/90">{error}</p>}
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
                            ? "Mark the files selected in Browse as not having these tags."
                            : "Add tags to the files selected in Browse."}
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

            {pending?.kind === "folderNo" && (
                <ConfirmDialog
                    title={`Not "${pending.name}" in ${activeFolder}?`}
                    message={
                        <>
                            {pending.preview.swap && (
                                <p className="mb-2">It replaces the folder's tag "{pending.name}".</p>
                            )}
                            <p>
                                Removes {removedText(pending.preview.removed)} (
                                {plural(pending.preview.files, "file")} in all).
                            </p>
                        </>
                    }
                    confirmText="Remove and add the no"
                    onCancel={() => setPending(null)}
                    onConfirm={() => {
                        const name = pending.name;
                        setPending(null);
                        void commitFolderNo(name);
                    }}
                />
            )}
            {pending?.kind === "batchNo" && (
                <ConfirmDialog
                    title={`Not ${pending.names.map((n) => `"${n}"`).join(", ")} on ${plural(pending.files.length, "file")}?`}
                    message={
                        <>
                            {pending.preview.removed.length > 0 && (
                                <p className="mb-2">Removes {removedText(pending.preview.removed)}.</p>
                            )}
                            {pending.preview.conflicts > 0 && (
                                <p>
                                    {plural(pending.preview.conflicts, "file")} get the tag from
                                    their folder, which wins. The no is kept for them and shows as a
                                    conflict in Coverage until the file or folder changes.
                                </p>
                            )}
                        </>
                    }
                    confirmText="Mark as no"
                    onCancel={() => setPending(null)}
                    onConfirm={() => {
                        const { names, files } = pending;
                        setPending(null);
                        void commitBatchNo(names, files);
                    }}
                />
            )}
        </div>
    );
}
