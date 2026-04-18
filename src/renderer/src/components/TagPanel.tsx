import { useTags } from "@renderer/contexts/TagsContext";
import { DbFile, DbTag, DbTagWithCategory } from "@renderer/shared/types/types";
import {
    ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { TagPill } from "./TagPill";
import { useSettings } from "@renderer/contexts/SettingsContext";

type TagGroup = {
    label: string;
    color: string | null;
    icon: string | null;
    tags: DbTagWithCategory[];
};

function groupByCategory(tags: DbTagWithCategory[]) {
    const groups = new Map<string, TagGroup>();

    for (const tag of tags) {
        const key =
            tag.category_id != null ? String(tag.category_id) : "uncategorized";
        if (!groups.has(key)) {
            groups.set(key, {
                label: tag.category?.name ?? "Uncategorized",
                color: tag.category?.color ?? null,
                icon: tag.category?.icon ?? null,
                tags: [],
            });
        }
        groups.get(key)!.tags.push(tag);
    }

    return Array.from(groups.values());
}

export function TagPanel({ file }: { file: DbFile }): JSX.Element {
    const [tags, setTags] = useState<DbTag[]>([]);
    const [input, setInput] = useState("");
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [suggestionMode, setSuggestionMode] = useState<"folder" | "global">(
        "folder",
    );

    const [popularTags, setPopularTags] = useState<{
        folder: DbTagWithCategory[];
        global: DbTagWithCategory[];
    }>({ folder: [], global: [] });

    const visiblePopularTags =
        suggestionMode === "folder" ? popularTags.folder : popularTags.global;

    const { allTags, refreshTags, getTagsWithCategory } = useTags();
    const { showTagCategoryNames } = useSettings();

    const tagsWithCategory = useMemo(
        () => getTagsWithCategory(tags),
        [tags, getTagsWithCategory],
    );

    useEffect(() => {
        (async () => {
            const fileTags = await window.api.getTags(file.id);
            setTags(getTagsWithCategory(fileTags));
        })();
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
                .slice(0, 20);

            const folderIds = new Set(topFolder.map((t) => t.id));

            const topGlobal = globalTags
                .filter((t) => !currentIds.has(t.id) && !folderIds.has(t.id))
                .slice(0, 20);

            setPopularTags({
                folder: getTagsWithCategory(topFolder),
                global: getTagsWithCategory(topGlobal),
            });
        });
    }, [file.folder_id, tags, getTagsWithCategory]);

    const filtered = useMemo(() => {
        if (!input.trim()) return [];

        const q = input.toLowerCase();

        return allTags
            .filter(
                (t) =>
                    t.name.toLowerCase().includes(q) &&
                    !tags.some((e) => e.id === t.id),
            )
            .sort((a, b) => {
                const aStart = a.name.toLowerCase().startsWith(q);
                const bStart = b.name.toLowerCase().startsWith(q);

                if (aStart && !bStart) return -1;
                if (!aStart && bStart) return 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 8);
    }, [input, allTags, tags]);

    useEffect(() => setHighlightedIndex(0), [input]);

    const addTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || tags.some((t) => t.name === trimmed)) return;

            const updated = await window.api.addTag(file.id, trimmed);
            await refreshTags();
            setTags(updated);
            setInput("");
        },
        [file.id, tags, refreshTags],
    );

    const removeTag = useCallback(
        async (tag: DbTag) => {
            const updated = await window.api.removeTag(file.id, tag.name);
            setTags(updated);
        },
        [file.id],
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
                });
            }

            map.get(key)!.tags.push(tag);
        }

        return Array.from(map.values());
    }, []);

    type CategoryGroupProps = {
        group: TagGroup;
        applied: boolean;
    };

    const CategoryGroup = ({ group, applied }: CategoryGroupProps) => (
        <div className="mb-2">
            {showTagCategoryNames && (
                <div className="flex items-center gap-2 mb-1 opacity-70">
                    {group.icon && (
                        <span style={{ color: group.color ?? undefined }}>
                            {group.icon}
                        </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide">
                        {group.label}
                    </span>
                </div>
            )}

            <div className={applied ? "flex flex-wrap gap-1.5" : "flex gap-1.5 overflow-x-auto pb-1 [&>*]:flex-shrink-0"} 
     style={!applied ? { scrollbarWidth: 'thin' } : {}}>
                {group.tags.map((tag) => (
                    applied
                        ? <TagPill
                                key={tag.id}
                                tag={tag}
                                onRemove={() => removeTag(tag)}
                            />
                        : <TagPill
                                key={tag.id}
                                tag={tag}
                                onAdd={() => addTag(tag.name)}
                            />
                    
                ))}
            </div>
        </div>
    );

    return (
        <div className="flex flex-col w-56 h-full bg-neutral-900 border-neutral-800 overflow-y-auto" style={{scrollbarGutter: "stable"}}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-neutral-800">
                <p className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">
                    Tags
                </p>
            </div>

            {/* Applied tags */}
            <div className="px-3 py-3 space-y-2">
                {groupByCategory(tagsWithCategory).map((g) => (
                    <CategoryGroup key={g.label} applied={true} group={g} />
                ))}
            </div>

            {/* Input */}
            <div className="px-3 py-2 relative">
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

            {/* Helper
            <div className="px-3 pb-3 text-[10px] text-neutral-600">
                Enter or comma to add
            </div> */}

            <div className="px-4 py-3 border-t border-neutral-800">
                <p className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">
                    Popular
                </p>
            </div>

            <div className="flex items-center justify-around px-3 py-2 border-t border-neutral-800">
                <button
                    onClick={() => setSuggestionMode("folder")}
                    className={`text-[10px] p-1 rounded-sm  uppercase tracking-wide ${
                        suggestionMode === "folder"
                            ? "text-neutral-800 bg-neutral-300"
                            : "text-neutral-600"
                    }`}
                >
                    Folder
                </button>

                <button
                    onClick={() => setSuggestionMode("global")}
                    className={`text-[10px] p-1 rounded-sm uppercase tracking-wide ${
                        suggestionMode === "global"
                            ? "text-neutral-800 bg-neutral-300"
                            : "text-neutral-600"
                    }`}
                >
                    Global
                </button>
            </div>

            {/* Suggestions */}

            {(popularTags.folder.length > 0 ||
                popularTags.global.length > 0) && (
                <div className="px-3 pb-4 space-y-4 border-t border-neutral-800 pt-3">
                    {popularTags.folder.length > 0 &&
                        suggestionMode === "folder" && (
                            <div className="opacity-80">
                                {groupByCategory(popularTags.folder).map(
                                    (g) => (
                                        <CategoryGroup
                                            key={g.label}
                                            applied={false}
                                            group={g}
                                        />
                                    ),
                                )}
                            </div>
                        )}

                    {popularTags.global.length > 0 &&
                        suggestionMode === "global" && (
                            <div className="opacity-70">
                                {groupByCategory(popularTags.global).map(
                                    (g) => (
                                        <CategoryGroup
                                            key={g.label}
                                            applied={false}
                                            group={g}
                                        />
                                    ),
                                )}
                            </div>
                        )}
                </div>
            )}
        </div>
    );
}