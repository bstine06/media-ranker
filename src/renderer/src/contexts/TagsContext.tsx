import {
    DbTag,
    DbTagCategory,
    DbTagWithCategory,
    TagImplication,
    TagUsage,
} from "@renderer/shared/types/types";
import { missingCategory } from "@renderer/lib/tagFilters";
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

    // Filtering state (unchanged)
    activeTags: Set<number>;
    tagMode: "and" | "or";
    /** Also takes the special filters in lib/tagFilters.ts ({ id: UNTAGGED }). */
    toggleTag: (tag: Pick<DbTag, "id">) => void;
    setTagMode: (mode: "and" | "or") => void;
    clearTags: () => void;
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
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon" | "order_index" | "quick_tags">>,
    ) => Promise<void>;
    deleteCategory: (id: number) => Promise<void>;
    /** Puts these tags first in the category, in this order (moving any
     *  from other categories into it). */
    reorderTags: (categoryId: number | null, tagIds: number[]) => Promise<void>;

    // upgrade tags
    getTagsWithCategory: (tags: DbTag[]) => DbTagWithCategory[];
    tagMap: Map<number, DbTagWithCategory>;
}

const TagsContext = createContext<Tags>({
    allTags: [],
    allCategories: [],
    implications: [],
    activeTags: new Set(),
    tagMode: "or",
    toggleTag: () => {},
    setTagMode: () => {},
    clearTags: () => {},
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
    getTagsWithCategory: () => [],
    tagMap: new Map(),
});

export function TagsProvider({ children }: { children: React.ReactNode }) {
    const [allTags, setAllTags] = useState<DbTag[]>([]);
    const [allCategories, setAllCategories] = useState<DbTagCategory[]>([]);
    const [implications, setImplications] = useState<TagImplication[]>([]);
    const [activeTags, setActiveTags] = useState<Set<number>>(new Set());
    const [tagMode, setTagMode] = useState<"and" | "or">("or");

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
                // Keep a file tag's `inherited` flag and its source (the
                // map's copy has neither).
                return full && t.inherited
                    ? { ...full, inherited: true, inheritedVia: t.inheritedVia }
                    : full;
            })
            .filter((t): t is DbTagWithCategory => t != null);
    },
    [tagMap],
);

    // --- Filtering ---

    const toggleTag = useCallback((tag: Pick<DbTag, "id">) => {
        setActiveTags((prev) => {
            const next = new Set(prev);
            next.has(tag.id) ? next.delete(tag.id) : next.add(tag.id);
            return next;
        });
    }, []);

    const clearTags = useCallback(() => setActiveTags(new Set()), []);

    const resetTags = useCallback(() => {
        setAllTags([]);
        setAllCategories([]);
        setImplications([]);
        setActiveTags(new Set());
        setTagMode("or");
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
            // A filter on the merged-away tag now means the target.
            setActiveTags((prev) => {
                if (!prev.has(sourceId)) return prev;
                const next = new Set(prev);
                next.delete(sourceId);
                next.add(targetId);
                return next;
            });
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
        setActiveTags((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
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
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon" | "order_index" | "quick_tags">>,
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
        // Drop a "no <category>" filter for it.
        setActiveTags((prev) => {
            const special = missingCategory(id);
            if (!prev.has(special)) return prev;
            const next = new Set(prev);
            next.delete(special);
            return next;
        });
    }, []);

    return (
        <TagsContext.Provider
            value={{
                allTags: allTagsWithCategory,
                allCategories,
                implications,
                activeTags,
                tagMode,
                toggleTag,
                setTagMode,
                clearTags,
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
                getTagsWithCategory,
                tagMap
            }}
        >
            {children}
        </TagsContext.Provider>
    );
}

export const useTags = () => useContext(TagsContext);
