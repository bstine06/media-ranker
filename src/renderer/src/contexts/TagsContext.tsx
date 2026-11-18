import {
    DbTag,
    DbTagCategory,
    DbTagWithCategory,
    Feed,
    FilterNode,
    TagImplication,
    TagUsage,
} from "@renderer/shared/types/types";
import {
    canonical,
    filterIsBroken,
    filterKey,
    pruneFilter,
    replaceTag,
} from "@renderer/lib/tagFilters";
import {
    createContext,
    useContext,
    useState,
    useCallback,
    useEffect,
    useMemo,
} from "react";

interface Tags {
    // Data
    allTags: DbTagWithCategory[];
    allCategories: DbTagCategory[];
    /** Tag links: "kitten" (tag_id) implies "cat" (implies_id). */
    implications: TagImplication[];

    // The tag filter (a tree, see lib/tagFilters.ts), edited in the filter
    // builder and applied when it closes.
    /** The applied filter as built: empty groups dropped, may be broken. */
    filter: FilterNode | null;
    /** What views filter by: `filter`, or null when it's broken. */
    activeFilter: FilterNode | null;
    /** filterKey(activeFilter), for effect dependencies. */
    activeFilterKey: string;
    /** The applied filter refers to a deleted tag or category, so it's off. */
    filterBroken: boolean;
    /** The saved feed the filter came from (its saved version), if any. */
    loadedFeed: Feed | null;
    /** Applies a filter (and records it in the recent filters). `feed` is the
     *  saved feed it was loaded from, kept to tell when it's been edited. */
    applyFilter: (tree: FilterNode | null, feed: Feed | null) => void;
    /** Keeps the loaded feed's name and saved version current after a save or rename. */
    setLoadedFeed: (feed: Feed | null) => void;
    clearFilter: () => void;
    resetTags: () => void;

    // Refresh
    refreshTags: () => Promise<void>;

    // Tag CRUD
    createTag: (name: string, categoryId: number | null) => Promise<void>;
    /** On a name clash nothing changes and the other tag comes back as
     *  `conflict`, so the caller can offer to merge. */
    updateTag: (
        id: number,
        name: string,
        categoryId: number | null,
    ) => Promise<
        | { ok: true }
        | { ok: false; conflict: DbTag & TagUsage }
    >;
    /** Source's files and folders get target instead; source is deleted.
     *  Refused when the tags' links would then go round in a circle. */
    mergeTags: (
        sourceId: number,
        targetId: number,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;

    // Tag links
    addImplication: (
        tagId: number,
        impliesId: number,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    removeImplication: (tagId: number, impliesId: number) => Promise<void>;
    deleteTag: (id: number) => Promise<void>;

    // Category CRUD
    createCategory: (
        name: string,
        color: string,
        icon: string,
    ) => Promise<void>;
    updateCategory: (
        id: number,
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon" | "order_index" | "sweep">>,
    ) => Promise<void>;
    deleteCategory: (id: number) => Promise<void>;
    /** Puts these tags first in the category, in this order (moving any
     *  from other categories into it). */
    reorderTags: (categoryId: number | null, tagIds: number[]) => Promise<void>;
    /** Whether a tag is offered in Sweep. */
    setTagSweep: (tagId: number, on: boolean) => Promise<void>;
    /** Every tag in a category in or out of Sweep. */
    setCategoryTagsSweep: (categoryId: number, on: boolean) => Promise<void>;

    // upgrade tags
    getTagsWithCategory: (tags: DbTag[]) => DbTagWithCategory[];
    tagMap: Map<number, DbTagWithCategory>;
}

const TagsContext = createContext<Tags>({
    allTags: [],
    allCategories: [],
    implications: [],
    filter: null,
    activeFilter: null,
    activeFilterKey: "",
    filterBroken: false,
    loadedFeed: null,
    applyFilter: () => {},
    setLoadedFeed: () => {},
    clearFilter: () => {},
    resetTags: () => {},
    refreshTags: async () => {},
    createTag: async () => {},
    updateTag: async () => ({ ok: true }),
    mergeTags: async () => ({ ok: true }),
    addImplication: async () => ({ ok: true }),
    removeImplication: async () => {},
    deleteTag: async () => {},
    createCategory: async () => {},
    updateCategory: async () => {},
    deleteCategory: async () => {},
    reorderTags: async () => {},
    setTagSweep: async () => {},
    setCategoryTagsSweep: async () => {},
    getTagsWithCategory: () => [],
    tagMap: new Map(),
});

export function TagsProvider({ children }: { children: React.ReactNode }) {
    const [allTags, setAllTags] = useState<DbTag[]>([]);
    const [allCategories, setAllCategories] = useState<DbTagCategory[]>([]);
    const [implications, setImplications] = useState<TagImplication[]>([]);
    const [filter, setFilter] = useState<FilterNode | null>(null);
    const [loadedFeed, setLoadedFeed] = useState<Feed | null>(null);

    const refreshTags = useCallback(async () => {
        const [tags, categories, links] = await Promise.all([
            window.api.getAllTags(),
            window.api.getAllTagCategories(),
            window.api.getTagImplications(),
        ]);
        setAllTags(tags);
        setAllCategories(categories);
        setImplications(links);
    }, []);

    // Join tags with their categories in one memo — components never have to do this themselves
    const allTagsWithCategory = useMemo<DbTagWithCategory[]>(() => {
        const catMap = new Map(allCategories.map((c) => [c.id, c]));
        return allTags.map((tag) => ({
            ...tag,
            category:
                tag.category_id != null
                    ? (catMap.get(tag.category_id) ?? null)
                    : null,
        }));
    }, [allTags, allCategories]);

    const tagMap = useMemo(() => {
        return new Map(allTagsWithCategory.map((t) => [t.id, t]));
    }, [allTagsWithCategory]);

    const getTagsWithCategory = useCallback(
    (tags: DbTag[]) => {
        return tags
            .map((t) => {
                const full = tagMap.get(t.id);
                // Keep a file tag's `inherited` flag, its source and any
                // conflict (the map's copy has none of them).
                if (!full || (!t.inherited && !t.conflict)) return full;
                return {
                    ...full,
                    ...(t.inherited ? { inherited: true, inheritedVia: t.inheritedVia } : {}),
                    ...(t.conflict ? { conflict: t.conflict } : {}),
                };
            })
            .filter((t): t is DbTagWithCategory => t != null);
    },
    [tagMap],
);

    // --- Filtering ---

    const applyFilter = useCallback((tree: FilterNode | null, feed: Feed | null) => {
        const pruned = pruneFilter(tree);
        const next = pruned ? canonical(pruned) : null;
        setFilter(next);
        setLoadedFeed(feed);
        if (!next) return;
        // An unedited saved feed goes in the history as itself; anything
        // else as the filter it is.
        const unedited = feed && filterKey(feed.tree) === filterKey(next);
        void window.api.pushFeedHistory(unedited ? { feedId: feed.id } : { tree: next });
    }, []);

    const clearFilter = useCallback(() => {
        setFilter(null);
        setLoadedFeed(null);
    }, []);

    const filterBroken = useMemo(
        () => filterIsBroken(filter, allTags, allCategories),
        [filter, allTags, allCategories],
    );
    const activeFilter = filterBroken ? null : filter;
    const activeFilterKey = useMemo(() => filterKey(activeFilter), [activeFilter]);

    const resetTags = useCallback(() => {
        setAllTags([]);
        setAllCategories([]);
        setImplications([]);
        setFilter(null);
        setLoadedFeed(null);
    }, []);

    // --- Tag CRUD ---

    const createTag = useCallback(
        async (name: string, categoryId: number | null) => {
            await window.api.createTag(name, categoryId);
            await refreshTags();
        },
        [refreshTags],
    );

    const updateTag = useCallback(
        async (id: number, name: string, categoryId: number | null) => {
            const result = await window.api.updateTag(id, name, categoryId);
            if (!result.ok) return result;
            // Swap in the saved values without a round-trip
            setAllTags((prev) =>
                prev.map((t) => (t.id === id ? result.tag : t)),
            );
            return { ok: true as const };
        },
        [],
    );

    const mergeTags = useCallback(
        async (sourceId: number, targetId: number) => {
            const result = await window.api.mergeTags(sourceId, targetId);
            if (!result.ok) return result;
            await refreshTags();
            // The filter follows the merge (main rewrites saved feeds).
            setFilter((prev) => (prev ? replaceTag(prev, sourceId, targetId) : prev));
            setLoadedFeed((prev) =>
                prev ? { ...prev, tree: replaceTag(prev.tree, sourceId, targetId) } : prev,
            );
            return result;
        },
        [refreshTags],
    );

    // --- Tag links ---

    const addImplication = useCallback(
        async (tagId: number, impliesId: number) => {
            const result = await window.api.addTagImplication(tagId, impliesId);
            setImplications(await window.api.getTagImplications());
            return result;
        },
        [],
    );

    const removeImplication = useCallback(
        async (tagId: number, impliesId: number) => {
            await window.api.removeTagImplication(tagId, impliesId);
            setImplications(await window.api.getTagImplications());
        },
        [],
    );

    const deleteTag = useCallback(async (id: number) => {
        await window.api.deleteTag(id);
        setAllTags((prev) => prev.filter((t) => t.id !== id));
        setImplications((prev) =>
            prev.filter((l) => l.tag_id !== id && l.implies_id !== id),
        );
        // A filter using it is now broken (see filterBroken).
    }, []);

    const reorderTags = useCallback(
        async (categoryId: number | null, tagIds: number[]) => {
            // Optimistic, so a dragged tag doesn't jump back for a moment.
            const position = new Map(tagIds.map((id, i) => [id, i]));
            setAllTags((prev) =>
                prev.map((t) =>
                    position.has(t.id)
                        ? { ...t, category_id: categoryId, order_index: position.get(t.id)! }
                        : t.category_id === categoryId
                          ? { ...t, order_index: t.order_index + tagIds.length }
                          : t,
                ),
            );
            await window.api.reorderTags(categoryId, tagIds);
            await refreshTags();
        },
        [refreshTags],
    );

    const setTagSweep = useCallback(async (tagId: number, on: boolean) => {
        setAllTags((prev) => prev.map((t) => (t.id === tagId ? { ...t, sweep: on ? 1 : 0 } : t)));
        await window.api.setTagSweep(tagId, on);
    }, []);

    const setCategoryTagsSweep = useCallback(async (categoryId: number, on: boolean) => {
        setAllTags((prev) =>
            prev.map((t) => (t.category_id === categoryId ? { ...t, sweep: on ? 1 : 0 } : t)),
        );
        await window.api.setCategoryTagsSweep(categoryId, on);
    }, []);

    // --- Category CRUD ---

    const createCategory = useCallback(
        async (name: string, color: string, icon: string) => {
            await window.api.createTagCategory(name, color, icon);
            await refreshTags();
            console.log("create category");
        },
        [refreshTags],
    );

    const updateCategory = useCallback(
    async (
        id: number,
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon" | "order_index" | "sweep">>,
    ) => {
        await window.api.updateTagCategory(id, updates);
        // Optimistic update
        setAllCategories((prev) =>
            prev.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        );
    },
    [],
);

    const deleteCategory = useCallback(async (id: number) => {
        await window.api.deleteTagCategory(id);
        // Null out category_id on any tags that belonged to it
        setAllTags((prev) =>
            prev.map((t) =>
                t.category_id === id ? { ...t, category_id: null } : t,
            ),
        );
        setAllCategories((prev) => prev.filter((c) => c.id !== id));
        // A filter counting tags in it is now broken (see filterBroken).
    }, []);

    return (
        <TagsContext.Provider
            value={{
                allTags: allTagsWithCategory,
                allCategories,
                implications,
                filter,
                activeFilter,
                activeFilterKey,
                filterBroken,
                loadedFeed,
                applyFilter,
                setLoadedFeed,
                clearFilter,
                resetTags,
                refreshTags,
                createTag,
                updateTag,
                mergeTags,
                addImplication,
                removeImplication,
                deleteTag,
                createCategory,
                updateCategory,
                deleteCategory,
                reorderTags,
                setTagSweep,
                setCategoryTagsSweep,
                getTagsWithCategory,
                tagMap
            }}
        >
            {children}
        </TagsContext.Provider>
    );
}

export const useTags = () => useContext(TagsContext);
