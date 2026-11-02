import { TagPill } from "@renderer/components/TagPill";
import { useTags } from "@renderer/contexts/TagsContext";
import {
    DbFile,
    DbFolder,
    DbTag,
    DbTagWithCategory,
    TagGroup,
} from "@renderer/shared/types/types";
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import CategoryGroup from "@renderer/components/CategoryGroup";
import { useFolders } from "@renderer/contexts/FolderContext";

export default function FolderTagPanel({
    folderTags,
    onAddFolderTag,
    onRemoveFolderTag,
    selectedFiles = [],
    onBatchTagModeChange,
    onExecuteBatchTag,
}: {
    folderTags: DbTag[];
    onAddFolderTag: (tag: string) => Promise<void>;
    onRemoveFolderTag: (tag: string) => Promise<void>;
    selectedFiles?: DbFile[]; // Files selected for batch tagging
    onBatchTagModeChange?: (isActive: boolean) => void;
    onExecuteBatchTag?: (tagNames: string[], files: DbFile[]) => Promise<void>;
}): JSX.Element {
    const [folderTagInput, setFolderTagInput] = useState("");
    const [folderTagInputFocused, setFolderTagInputFocused] = useState(false);
    const [batchTagInput, setBatchTagInput] = useState("");
    const [batchTagInputFocused, setBatchTagInputFocused] = useState(false);
    const folderTagInputRef = useRef<HTMLInputElement>(null);
    const batchTagInputRef = useRef<HTMLInputElement>(null);
    const [folderTagHighlightedIndex, setFolderTagHighlightedIndex] = useState(0);
    const [batchTagHighlightedIndex, setBatchTagHighlightedIndex] = useState(0);

    // Staged tags for batch operation
    const [stagedTags, setStagedTags] = useState<DbTag[]>([]);
    const [isBatchTagMode, setIsBatchTagMode] = useState(false);

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

    // Folder tag filtered suggestions
    const folderTagFiltered = useMemo(() => {
        if (!folderTagInput.trim()) return [];

        const q = folderTagInput.toLowerCase();

        return allTags
            .filter(
                (t) =>
                    t.name.toLowerCase().includes(q) &&
                    !folderTags.some((e) => e.id === t.id),
            )
            .sort((a, b) => {
                const aStart = a.name.toLowerCase().startsWith(q);
                const bStart = b.name.toLowerCase().startsWith(q);

                if (aStart && !bStart) return -1;
                if (!aStart && bStart) return 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 8);
    }, [folderTagInput, allTags, folderTags]);

    // Batch tag filtered suggestions
    const batchTagFiltered = useMemo(() => {
        if (!batchTagInput.trim()) return [];

        const q = batchTagInput.toLowerCase();

        return allTags
            .filter(
                (t) =>
                    t.name.toLowerCase().includes(q) &&
                    !stagedTags.some((e) => e.id === t.id),
            )
            .sort((a, b) => {
                const aStart = a.name.toLowerCase().startsWith(q);
                const bStart = b.name.toLowerCase().startsWith(q);

                if (aStart && !bStart) return -1;
                if (!aStart && bStart) return 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 8);
    }, [batchTagInput, allTags, stagedTags]);

    useEffect(() => setFolderTagHighlightedIndex(0), [folderTagInput]);
    useEffect(() => setBatchTagHighlightedIndex(0), [batchTagInput]);

    // Notify parent when batch tag mode changes
    useEffect(() => {
        onBatchTagModeChange?.(isBatchTagMode);
    }, [isBatchTagMode, onBatchTagModeChange]);

    const addFolderTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) return;

            await onAddFolderTag(trimmed);
            setFolderTagInput("");
        },
        [folderTags, onAddFolderTag],
    );

    // NEW: mirrors TagPanel's createTag — actually creates the tag record
    // before applying it to the folder, so brand-new tag names work here too.
    const createFolderTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) {
                setFolderTagInput("");
                return;
            }

            // add-tag-to-folder upserts the tag without touching its category.
            await onAddFolderTag(trimmed);
            await refreshTags();
            setFolderTagInput("");
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
            setBatchTagInput("");
        },
        [stagedTags, allTags],
    );

    // NEW: creates a brand-new tag record, then stages it directly using the
    // object the API returns — doesn't rely on a (possibly stale) allTags
    // lookup, since refreshTags() hasn't necessarily resolved yet.
    const createStagedTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || stagedTags.some((t) => t.name === trimmed)) {
                setBatchTagInput("");
                return;
            }

            // Reuse an existing tag if there is one — createTag(name, null) would
            // wipe that tag's category.
            const existing = allTags.find((t) => t.name === trimmed);
            const newTag = existing ?? (await window.api.createTag(trimmed, null));
            if (!existing) await refreshTags();

            if (newTag) {
                setStagedTags((prev) => [...prev, newTag]);
            }
            setBatchTagInput("");
        },
        [stagedTags, allTags, refreshTags],
    );

    const removeStagedTag = useCallback((tag: DbTag) => {
        setStagedTags((prev) => prev.filter((t) => t.id !== tag.id));
    }, []);

    const startBatchTagMode = useCallback(() => {
        setIsBatchTagMode(true);
    }, []);

    const cancelBatchTag = useCallback(() => {
        setIsBatchTagMode(false);
        setStagedTags([]);
    }, []);

    const executeBatchTag = useCallback(async () => {
        if (stagedTags.length === 0 || selectedFiles.length === 0) return;

        const tagNames = stagedTags.map((t) => t.name);
        await onExecuteBatchTag?.(tagNames, selectedFiles);

        // Reset state after execution
        setStagedTags([]);
        setIsBatchTagMode(false);
    }, [stagedTags, selectedFiles, onExecuteBatchTag]);

    const groupByCategory = useCallback((tags: DbTagWithCategory[]) => {
        const map = new Map<string, TagGroup>();

        for (const tag of tags) {
            const key =
                tag.category_id != null
                    ? `cat-${tag.category_id}`
                    : "uncategorized";

            if (!map.has(key)) {
                map.set(key, {
                    label: tag.category?.name ?? "Uncategorized",
                    color: tag.category?.color ?? null,
                    icon: tag.category?.icon ?? null,
                    tags: [],
                    categoryId: tag.category_id ?? null,
                    orderIndex: tag.category?.order_index ?? Infinity,
                });
            }

            map.get(key)!.tags.push(tag);
        }

        // Sort groups by order_index (nulls/uncategorized last)
        return Array.from(map.values()).sort((a, b) => {
            if (a.categoryId === null) return 1;
            if (b.categoryId === null) return -1;
            return (a.orderIndex ?? Infinity) - (b.orderIndex ?? Infinity);
        });
    }, []);

    // Folder tag keyboard navigation
    useEffect(() => {
        if (!folderTagInputFocused) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                setFolderTagHighlightedIndex((i) =>
                    Math.min(i + 1, folderTagFiltered.length - 1),
                );
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                setFolderTagHighlightedIndex((i) => Math.max(i - 1, -1));
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFolderTagInputFocused(false);
            }
            if (e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setFolderTagInput((i) => i + " ");
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [folderTagInputFocused, folderTagFiltered.length]);

    // Batch tag keyboard navigation
    useEffect(() => {
        if (!batchTagInputFocused) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                setBatchTagHighlightedIndex((i) =>
                    Math.min(i + 1, batchTagFiltered.length - 1),
                );
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                setBatchTagHighlightedIndex((i) => Math.max(i - 1, -1));
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setBatchTagInputFocused(false);
            }
            if (e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setBatchTagInput((i) => i + " ");
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [batchTagInputFocused, batchTagFiltered.length]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

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
                        {groupByCategory(folderTagsWithCategory).map((g) => (
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

                    {/* Input */}
                    <div className="px-3 pb-3 relative">
                        <input
                            ref={folderTagInputRef}
                            value={folderTagInput}
                            onChange={(e) => setFolderTagInput(e.target.value)}
                            onFocus={() => setFolderTagInputFocused(true)}
                            onBlur={() =>
                                setTimeout(() => setFolderTagInputFocused(false), 120)
                            }
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    if (folderTagFiltered[folderTagHighlightedIndex]) {
                                        addFolderTag(
                                            folderTagFiltered[folderTagHighlightedIndex].name,
                                        );
                                    } else if (folderTagInput.trim()) {
                                        createFolderTag(folderTagInput.trim());
                                    }
                                }
                            }}
                            placeholder="Add tag…"
                            className="w-full px-2 py-1.5 text-xs bg-neutral-950 border border-neutral-700 rounded-md text-neutral-200"
                        />

                        {/* Dropdown (overlay style) */}
                        {folderTagInputFocused && folderTagFiltered.length > 0 && (
                            <div className="absolute left-3 right-3 top-full mt-1 bg-neutral-950 border border-neutral-700 rounded-md shadow-xl z-20 overflow-hidden">
                                {folderTagFiltered.map((tag, i) => (
                                    <button
                                        key={tag.id}
                                        onMouseDown={() => addFolderTag(tag.name)}
                                        onMouseEnter={() =>
                                            setFolderTagHighlightedIndex(i)
                                        }
                                        className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-2
                                    ${
                                        i === folderTagHighlightedIndex
                                            ? "bg-neutral-800"
                                            : "hover:bg-neutral-900"
                                    }`}
                                    >
                                        {tag.category?.icon && (
                                            <span
                                                style={{
                                                    color: tag.category.color,
                                                }}
                                            >
                                                {tag.category.icon}
                                            </span>
                                        )}
                                        {tag.name}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
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
                        Add tags to multiple files at once.
                    </p>
                </div>

                {/* Staged tags */}
                {stagedTags.length > 0 && (
                    <div className="px-3 py-3 space-y-2">
                        {groupByCategory(stagedTagsWithCategory).map((g) => (
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

                {/* Input */}
                <div className="px-3 py-3 relative">
                    <input
                        ref={batchTagInputRef}
                        value={batchTagInput}
                        onChange={(e) => setBatchTagInput(e.target.value)}
                        onFocus={() => setBatchTagInputFocused(true)}
                        onBlur={() => setTimeout(() => setBatchTagInputFocused(false), 120)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                if (batchTagFiltered[batchTagHighlightedIndex]) {
                                    addStagedTag(
                                        batchTagFiltered[batchTagHighlightedIndex].name,
                                    );
                                } else if (batchTagInput.trim()) {
                                    createStagedTag(batchTagInput.trim());
                                }
                            }
                        }}
                        placeholder="Add tag…"
                        className="w-full px-2 py-1.5 text-xs bg-neutral-950 border border-neutral-700 rounded-md text-neutral-200"
                    />

                    {/* Dropdown (overlay style) */}
                    {batchTagInputFocused && batchTagFiltered.length > 0 && (
                        <div className="absolute left-3 right-3 top-full mt-1 bg-neutral-950 border border-neutral-700 rounded-md shadow-xl z-20 overflow-hidden">
                            {batchTagFiltered.map((tag, i) => (
                                <button
                                    key={tag.id}
                                    onMouseDown={() => addStagedTag(tag.name)}
                                    onMouseEnter={() =>
                                        setBatchTagHighlightedIndex(i)
                                    }
                                    className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-2
                                        ${
                                            i === batchTagHighlightedIndex
                                                ? "bg-neutral-800"
                                                : "hover:bg-neutral-900"
                                        }`}
                                >
                                    {tag.category?.icon && (
                                        <span
                                            style={{
                                                color: tag.category.color,
                                            }}
                                        >
                                            {tag.category.icon}
                                        </span>
                                    )}
                                    {tag.name}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Action buttons */}
                <div className="px-3 pb-3 flex gap-2">
                    {!isBatchTagMode ? (
                        <button
                            onClick={startBatchTagMode}
                            disabled={stagedTags.length === 0}
                            className="flex-1 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-md transition-colors"
                        >
                            Select Files ({stagedTags.length} tag{stagedTags.length !== 1 ? 's' : ''})
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={cancelBatchTag}
                                className="flex-1 px-3 py-1.5 text-xs font-medium bg-neutral-700 hover:bg-neutral-600 text-white rounded-md transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={executeBatchTag}
                                disabled={selectedFiles.length === 0}
                                className="flex-1 px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-md transition-colors"
                            >
                                Apply to {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''}
                            </button>
                        </>
                    )}
                </div>

                {/* Info text */}
                {isBatchTagMode && (
                    <div className="px-3 pb-3">
                        <p className="text-xs text-neutral-500 italic">
                            Select files to tag, then click Apply.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}