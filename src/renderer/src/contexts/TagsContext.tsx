import { DbTag } from "@renderer/shared/types/types";
import { createContext, useContext, useState, useCallback, useEffect } from "react";

interface Tags {
    allTags: DbTag[];
    refreshTags: () => Promise<void>;
    activeTags: Set<number>;
    tagMode: "and" | "or";
    toggleTag: (tag: DbTag) => void;
    setTagMode: (mode: "and" | "or") => void;
    clearTags: () => void;
    resetTags: () => void;
}

const TagsContext = createContext<Tags>({
    allTags: [],
    refreshTags: async () => {},
    activeTags: new Set(),
    tagMode: "or",
    toggleTag: (tag: DbTag) => {},
    setTagMode: (mode: "and" | "or") => {},
    clearTags: () => {},
    resetTags: () => {},
});

export function TagsProvider({ children }: { children: React.ReactNode }) {

    const [allTags, setAllTags] = useState<DbTag[]>([]);
    const [activeTags, setActiveTags] = useState<Set<number>>(new Set());
    const [tagMode, setTagMode] = useState<"and" | "or">("or");

    useEffect(() => {
        refreshTags();
    }, []);

    const toggleTag = useCallback((tag: DbTag) => {
        setActiveTags((prev) => {
            const next = new Set(prev);
            next.has(tag.id) ? next.delete(tag.id) : next.add(tag.id);
            return next;
        });
    }, []);

    const clearTags = useCallback(() => {
        setActiveTags(new Set());
    }, []);

    const refreshTags = useCallback(async () => {
        const tags = await window.api.getAllTags();
        setAllTags(tags);
    }, []);

    const resetTags = useCallback(() => {
        setAllTags([]);
        setActiveTags(new Set());
        setTagMode("or");
    }, [])

    return (
        <TagsContext.Provider
            value={{
                allTags,
                refreshTags,
                activeTags,
                tagMode,
                toggleTag,
                setTagMode,
                clearTags,
                resetTags
            }}
        >
            {children}
        </TagsContext.Provider>
    );
}

export const useTags = () => useContext(TagsContext);
