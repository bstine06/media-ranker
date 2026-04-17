import {
    DbTag,
    DbTagCategory,
    DbTagWithCategory,
} from "@renderer/shared/types/types";
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
    toggleTag: (tag: DbTag) => void;
    setTagMode: (mode: "and" | "or") => void;
    clearTags: () => void;
    resetTags: () => void;

    // Refresh
    refreshTags: () => Promise<void>;

    // Tag CRUD
    createTag: (name: string, categoryId: number | null) => Promise<void>;
    updateTag: (
        id: number,
        name: string,
        categoryId: number | null,
    ) => Promise<void>;
    deleteTag: (id: number) => Promise<void>;

    // Category CRUD
    createCategory: (
        name: string,
        color: string,
        icon: string,
    ) => Promise<void>;
    updateCategory: (
        id: number,
        updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon">>,
    ) => Promise<void>;
    deleteCategory: (id: number) => Promise<void>;

    // upgrade tags
    getTagsWithCategory: (tags: DbTag[]) => DbTagWithCategory[];
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
    updateTag: async () => {},
    deleteTag: async () => {},
    createCategory: async () => {},
    updateCategory: async () => {},
    deleteCategory: async () => {},
    getTagsWithCategory: () => [],
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
            return tags.map((t) => tagMap.get(t.id)!);
        },
        [tagMap],
    );

    // --- Filtering ---

    const toggleTag = useCallback((tag: DbTag) => {
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
            await window.api.updateTag(id, name, categoryId);
            // Optimistic update — swap in the new values without a round-trip
            setAllTags((prev) =>
                prev.map((t) =>
                    t.id === id ? { ...t, name, category_id: categoryId } : t,
                ),
            );
        },
        [],
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
            updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon">>,
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
                deleteTag,
                createCategory,
                updateCategory,
                deleteCategory,
                getTagsWithCategory
            }}
        >
            {children}
        </TagsContext.Provider>
    );
}

export const useTags = () => useContext(TagsContext);
