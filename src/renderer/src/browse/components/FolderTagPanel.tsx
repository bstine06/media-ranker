import { useTags } from "@renderer/contexts/TagsContext";
import { DbFile, DbTag } from "@renderer/shared/types/types";
import { useCallback, useMemo, useState } from "react";
import CategoryGroup from "@renderer/components/CategoryGroup";
import { TagInput } from "@renderer/components/TagInput";
import { useFolders } from "@renderer/contexts/FolderContext";
import { groupTagsByCategory } from "@renderer/lib/tagGroups";

export default function FolderTagPanel({
    folderTags,
    onAddFolderTag,
    onRemoveFolderTag,
    selectedFiles = [],
    onExecuteBatchTag,
}: {
    folderTags: DbTag[];
    onAddFolderTag: (tag: string) => Promise<void>;
    onRemoveFolderTag: (tag: string) => Promise<void>;
    selectedFiles?: DbFile[]; // Current Browse selection
    onExecuteBatchTag?: (tagNames: string[], files: DbFile[]) => Promise<void>;
}): JSX.Element {
    // Staged tags for batch operation
    const [stagedTags, setStagedTags] = useState<DbTag[]>([]);

    const { allTags, refreshTags, getTagsWithCategory } = useTags();
    const { activeFolder } = useFolders();

    const folderTagsWithCategory = useMemo(
        () => getTagsWithCategory(folderTags),
        [folderTags, getTagsWithCategory],
    );

    const stagedTagsWithCategory = useMemo(
        () => getTagsWithCategory(stagedTags),
        [stagedTags, getTagsWithCategory],
    );

    const addFolderTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) return;

            await onAddFolderTag(trimmed);
        },
        [folderTags, onAddFolderTag],
    );

    // Enter on a name with no suggestion: the tag may be brand new, so
    // refresh the tag list after applying it.
    const createFolderTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) return;

            // add-tag-to-folder upserts the tag without touching its category.
            await onAddFolderTag(trimmed);
            await refreshTags();
        },
        [folderTags, onAddFolderTag, refreshTags],
    );

    const removeFolderTag = useCallback(
        async (tag: DbTag) => {
            await onRemoveFolderTag(tag.name);
        },
        [onRemoveFolderTag],
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

    const executeBatchTag = useCallback(async () => {
        if (stagedTags.length === 0 || selectedFiles.length === 0) return;

        const tagNames = stagedTags.map((t) => t.name);
        await onExecuteBatchTag?.(tagNames, selectedFiles);

        setStagedTags([]);
    }, [stagedTags, selectedFiles, onExecuteBatchTag]);

    return (
        <div className="flex flex-col w-full h-full bg-neutral-900 border-neutral-800">
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
                            />
                        ))}
                    </div>

                    <TagInput
                        exclude={folderTags}
                        onPick={addFolderTag}
                        onCreate={createFolderTag}
                        className="px-3 pb-3"
                    />
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
                        Add tags to the files selected in Browse.
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

                {/* Action */}
                <div className="px-3 pb-3">
                    <button
                        onClick={executeBatchTag}
                        disabled={stagedTags.length === 0 || selectedFiles.length === 0}
                        className="w-full px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-md transition-colors"
                    >
                        Apply to {selectedFiles.length} selected file
                        {selectedFiles.length !== 1 ? "s" : ""}
                    </button>
                    {selectedFiles.length === 0 && (
                        <p className="mt-2 text-xs text-neutral-500 italic">
                            Select files with ⌘-click, the Select button, or ⌘A.
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}