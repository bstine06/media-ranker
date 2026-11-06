import {
    DbTag,
    DbTagCategory,
    DbTagWithCategory,
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
    /** Source's files and folders get target instead; source is deleted. */
    mergeTags: (sourceId: number, targetId: number) => Promise<void>;
    deleteTag: (id: number) => Promise<void>;

    // Category CRUD
    createCategory: (
        name: string,
        color: string,
        icon: string,
    ) => Promise<void>;
    updateCategory: (
        id: number,
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon" | "order_index">>,
    ) => Promise<void>;
    deleteCategory: (id: number) => Promise<void>;

    // upgrade tags
    getTagsWithCategory: (tags: DbTag[]) => DbTagWithCategory[];
    tagMap: Map<number, DbTagWithCategory>;
}

const TagsContext = createContext<Tags>({
    allTags: [],
    allCategories: [],
    activeTags: new Set(),
    tagMode: "or",
    toggleTag: () => {},
    setTagMode: () => {},
    clearTags: () => {},
    resetTags: () => {},
    refreshTags: async () => {},
    createTag: async () => {},
    updateTag: async () => ({ ok: true }),
    mergeTags: async () => {},
    deleteTag: async () => {},
    createCategory: async () => {},
    updateCategory: async () => {},
    deleteCategory: async () => {},
    getTagsWithCategory: () => [],
    tagMap: new Map(),
});

export function TagsProvider({ children }: { children: React.ReactNode }) {
    const [allTags, setAllTags] = useState<DbTag[]>([]);
    const [allCategories, setAllCategories] = useState<DbTagCategory[]>([]);
    const [activeTags, setActiveTags] = useState<Set<number>>(new Set());
    const [tagMode, setTagMode] = useState<"and" | "or">("or");

    const refreshTags = useCallback(async () => {
        const [tags, categories] = await Promise.all([
            window.api.getAllTags(),
            window.api.getAllTagCategories(),
        ]);
        setAllTags(tags);
        setAllCategories(categories);
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
                // Keep a file tag's `inherited` flag (the map's copy has none).
                return full && t.inherited ? { ...full, inherited: true } : full;
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
            await window.api.mergeTags(sourceId, targetId);
            await refreshTags();
            // A filter on the merged-away tag now means the target.
            setActiveTags((prev) => {
                if (!prev.has(sourceId)) return prev;
                const next = new Set(prev);
                next.delete(sourceId);
                next.add(targetId);
                return next;
            });
        },
        [refreshTags],
    );

    const deleteTag = useCallback(async (id: number) => {
        await window.api.deleteTag(id);
        setAllTags((prev) => prev.filter((t) => t.id !== id));
        setActiveTags((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
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
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon" | "order_index">>,
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
                deleteTag,
                createCategory,
                updateCategory,
                deleteCategory,
                getTagsWithCategory,
                tagMap
            }}
        >
            {children}
        </TagsContext.Provider>
    );
}

export const useTags = () => useContext(TagsContext);
