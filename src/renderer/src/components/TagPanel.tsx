import { useTags } from "@renderer/contexts/TagsContext";
import { DbFile, DbTag, DbTagWithCategory } from "@renderer/shared/types/types";
import { useCallback, useEffect, useRef, useState } from "react";

export function TagPanel({ file }: { file: DbFile }): JSX.Element {
    const [tags, setTags] = useState<DbTagWithCategory[]>([]);
    const [input, setInput] = useState("");
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [popularTags, setPopularTags] = useState<{
        folder: DbTag[];
        global: DbTag[];
    }>({ folder: [], global: [] });

    const { allTags, refreshTags, getTagsWithCategory } = useTags();

    const addCategoryToTags = (tags: DbTag[]): DbTagWithCategory[] => {
        return getTagsWithCategory(tags);
    };

    useEffect(() => {
        const loadTags = async () => {
            const fileTags = await window.api.getTags(file.id);
            setTags(addCategoryToTags(fileTags));
        };
        loadTags();
    }, [file.id]);

    useEffect(() => {
        Promise.all([
            file.folder_id
                ? window.api.getMostUsedTags(file.folder_id)
                : Promise.resolve([]),
            window.api.getMostUsedTags(),
        ]).then(([folderTags, globalTags]) => {
            const currentIds = new Set(tags.map((t) => t.id));

            const topFolder = folderTags
                .filter((t) => !currentIds.has(t.id))
                .slice(0, 8);

            const folderIds = new Set(topFolder.map((t) => t.id));
            const topGlobal = globalTags
                .filter((t) => !currentIds.has(t.id) && !folderIds.has(t.id))
                .slice(0, 8);

            setPopularTags({ folder: topFolder, global: topGlobal });
        });
    }, [file.folder_id, tags]);

    const filtered = input.trim()
        ? allTags
              .filter(
                  (t) =>
                      t.name.toLowerCase().includes(input.toLowerCase()) &&
                      !tags.some((existing) => existing.id === t.id),
              )
              .sort((a, b) => {
                  const aStarts = a.name
                      .toLowerCase()
                      .startsWith(input.toLowerCase());
                  const bStarts = b.name
                      .toLowerCase()
                      .startsWith(input.toLowerCase());
                  if (aStarts && !bStarts) return -1;
                  if (!aStarts && bStarts) return 1;
                  return a.name.localeCompare(b.name);
              })
              .slice(0, 8)
        : [];

    useEffect(() => {
        setHighlightedIndex(0);
    }, [input]);

    const addTag = useCallback(
        async (tag: string) => {
            const trimmed = tag.trim().toLowerCase();
            if (!trimmed || tags.some((t) => t.name === trimmed)) return;
            const updated = await window.api.addTag(file.id, trimmed);
            setTags(addCategoryToTags(updated));
            await refreshTags();
            setInput("");
        },
        [file.id, tags, refreshTags],
    );

    const removeTag = useCallback(
        async (tag: DbTag) => {
            const updated = await window.api.removeTag(file.id, tag.name);
            setTags(addCategoryToTags(updated));
        },
        [file.id],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (["ArrowUp", "ArrowDown", "Tab"].includes(e.key)) {
                e.stopPropagation();
            }

            if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightedIndex((i) =>
                    Math.min(i + 1, filtered.length - 1),
                );
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightedIndex((i) => Math.max(i - 1, -1));
            } else if (e.key === "Tab") {
                e.preventDefault();
                if (filtered[highlightedIndex]) {
                    setInput(filtered[highlightedIndex].name);
                    setHighlightedIndex(0);
                }
            } else if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                if (filtered[highlightedIndex]) {
                    addTag(filtered[highlightedIndex].name);
                } else {
                    addTag(input);
                }
            } else if (
                e.key === "Backspace" &&
                input === "" &&
                tags.length > 0
            ) {
                removeTag(tags[tags.length - 1]);
            } else if (e.key === "Escape") {
                setInput("");
                inputRef.current?.blur();
            }
        },
        [input, tags, filtered, highlightedIndex, addTag, removeTag],
    );

    return (
        <div className="flex flex-col w-56 shrink-0 border-neutral-800 bg-neutral-900 overflow-y-auto flex-grow h-full">
            <div className="px-4 py-3 border-b border-neutral-800">
                <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                    Tags
                </p>
            </div>

            {/* Tag chips */}
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {tags.map((tag) => (
                    <>
                        <span
                            key={tag.id}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300 text-xs group"
                        >
                            {tag.category && (
                                <span
                                    className="text-[10px] leading-none flex-shrink-0"
                                    style={{
                                        color: tag.category.color ?? "#888",
                                    }}
                                >
                                    {tag.category.icon ?? "●"}
                                </span>
                            )}
                            {tag.name}
                            <button
                                onClick={() => removeTag(tag)}
                                className="text-neutral-600 hover:text-neutral-300 transition-colors leading-none"
                            >
                                ×
                            </button>
                        </span>
                    </>
                ))}
            </div>

            {/* Input */}
            <div className="relative px-3 pt-2 pb-0">
                <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 150)}
                    placeholder="Add tag…"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors"
                />

                {/* Suggestions dropdown */}
                {focused && filtered.length > 0 && (
                    <div className="absolute left-3 right-3 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden z-10 shadow-lg">
                        {filtered.map((tag, i) => (
                            <button
                                key={tag.id}
                                onMouseDown={() => addTag(tag.name)}
                                onMouseEnter={() => setHighlightedIndex(i)}
                                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                    i === highlightedIndex
                                        ? "bg-neutral-700 text-neutral-100"
                                        : "text-neutral-300 hover:bg-neutral-800"
                                }`}
                            >
                                {tag.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="px-3 pb-2">
                <p className="text-xs text-neutral-700 mt-3">
                    Enter or comma to add
                </p>
            </div>

            {/* Popular tags */}
            {popularTags.folder.length > 0 && (
                <div className="px-3 pt-1 pb-3">
                    <p className="text-xs text-neutral-500 mb-2">
                        Popular in this folder
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {popularTags.folder.map((tag) => (
                            <button
                                key={tag.id}
                                onClick={() => addTag(tag.name)}
                                className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 text-xs hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                            >
                                + {tag.name}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {popularTags.global.length > 0 && (
                <div className="px-3 pt-1 pb-3">
                    <p className="text-xs text-neutral-500 mb-2">
                        Popular everywhere
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {popularTags.global.map((tag) => (
                            <button
                                key={tag.id}
                                onClick={() => addTag(tag.name)}
                                className="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 text-xs hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                            >
                                + {tag.name}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
