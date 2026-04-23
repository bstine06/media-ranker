import { TagPill } from "@renderer/components/TagPill";
import { useTags } from "@renderer/contexts/TagsContext";
import { DbTag, DbTagWithCategory, TagGroup } from "@renderer/shared/types/types";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CategoryGroup from "@renderer/components/CategoryGroup";

export default function FolderTagPanel({
    folderTags,
    onAddFolderTag,
    onRemoveFolderTag,
}: {
    folderTags: DbTag[];
    onAddFolderTag: (tag: string) => Promise<void>;
    onRemoveFolderTag: (tag: string) => Promise<void>;
}): JSX.Element {
    const [input, setInput] = useState("");
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);

    const { allTags, getTagsWithCategory } = useTags();

    const tagsWithCategory = useMemo(
        () => getTagsWithCategory(folderTags),
        [folderTags, getTagsWithCategory],
    );

    const filtered = useMemo(() => {
        if (!input.trim()) return [];

        const q = input.toLowerCase();

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
    }, [input, allTags, folderTags]);

    useEffect(() => setHighlightedIndex(0), [input]);

    const addTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || folderTags.some((t) => t.name === trimmed)) return;

            await onAddFolderTag(trimmed);
            setInput("");
        },
        [folderTags, onAddFolderTag],
    );

    const removeTag = useCallback(
        async (tag: DbTag) => {
            await onRemoveFolderTag(tag.name);
        },
        [onRemoveFolderTag],
    );

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

    // keyboard
    useEffect(() => {
        if (!focused) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex((i) =>
                    Math.min(i + 1, filtered.length - 1),
                );
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex((i) => Math.max(i - 1, -1));
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFocused(false);
            }
            if (e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setInput((i) => i + " ");
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [focused, filtered.length]);

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
                {groupByCategory(tagsWithCategory).map((g) => (
                    <CategoryGroup
                        key={g.label}
                        applied={true}
                        activeTags={tagsWithCategory}
                        group={g}
                        onRemoveTag={removeTag}
                        onAddTag={addTag}
                    />
                ))}
            </div>

            {/* Input */}
            <div className="px-3 pb-1 relative">
                <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 120)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && filtered[highlightedIndex]) {
                            addTag(filtered[highlightedIndex].name);
                        }
                    }}
                    placeholder="Add tag…"
                    className="w-full px-2 py-1.5 text-xs bg-neutral-950 border border-neutral-700 rounded-md text-neutral-200"
                />

                {/* Dropdown (overlay style) */}
                {focused && filtered.length > 0 && (
                    <div className="absolute left-3 right-3 top-full mt-1 bg-neutral-950 border border-neutral-700 rounded-md shadow-xl z-20 overflow-hidden">
                        {filtered.map((tag, i) => (
                            <button
                                key={tag.id}
                                onMouseDown={() => addTag(tag.name)}
                                onMouseEnter={() => setHighlightedIndex(i)}
                                className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-2
                                    ${
                                        i === highlightedIndex
                                            ? "bg-neutral-800"
                                            : "hover:bg-neutral-900"
                                    }`}
                            >
                                {tag.category?.icon && (
                                    <span style={{ color: tag.category.color }}>
                                        {tag.category.icon}
                                    </span>
                                )}
                                {tag.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {/* Header */}
            <div className="px-4 py-3 border-b border-neutral-800">
                <p className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">
                    Batch Tag
                </p>
                <p className="text-xs text-neutral-500 italic">
                    Coming soon
                </p>
            </div>
        </div>
    );
}