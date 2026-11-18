import { useSettings } from "@renderer/contexts/SettingsContext";
import { DbTagWithCategory, TagGroup } from "@renderer/shared/types/types";
import React, { useEffect, useRef, useState } from "react";
import { TagPill } from "./TagPill";

type CategoryGroupProps = {
    group: TagGroup;
    applied: boolean;
    activeTags: DbTagWithCategory[];
    onRemoveTag: (tag: DbTagWithCategory) => void;
    onAddTag: (tagName: string) => void;
    /** Briefly highlight this tag (it just moved here, e.g. a swap). */
    glowTagId?: number | null;
};

const CategoryGroup = ({ group, applied, activeTags, onRemoveTag, onAddTag, glowTagId }: CategoryGroupProps) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    const {showTagCategoryNames} = useSettings();

    const checkScroll = () => {
        if (scrollRef.current) {
            const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
            setCanScrollLeft(scrollLeft > 0);
            setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 1);
        }
    };

    const activeTagIds = new Set(activeTags.map(t => t.id));
    // Inherited tags (from the folder, or implied by another tag): shown,
    // but removed at their source. Value: the implying tag, if any.
    const inheritedTags = new Map(
        activeTags.filter(t => t.inherited).map(t => [t.id, t.inheritedVia]),
    );
    // A no disagrees with the tag on this file (see getTagsForFile).
    const conflicts = new Map(
        activeTags.filter(t => t.conflict).map(t => [t.id, t.conflict]),
    );

    useEffect(() => {
        if (!applied) {
            checkScroll();
            window.addEventListener("resize", checkScroll);
            return () => window.removeEventListener("resize", checkScroll);
        }
    }, [applied, group.tags]);

    return (
        <div className="mb-1">
            {showTagCategoryNames && (
                <div className="flex items-center gap-2 opacity-70">
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

            <div className="relative">
                <div
                    ref={scrollRef}
                    className={
                        applied
                            ? "flex flex-wrap gap-1.5"
                            : "flex gap-1.5 overflow-x-auto pb-1 [&>*]:flex-shrink-0 scrollbar-hide"
                    }
                    onScroll={checkScroll}
                >
                    {group.tags.map((tag) => {
                        const isActive = activeTagIds.has(tag.id);
                        const isInherited = inheritedTags.has(tag.id);
                        return (
                            <TagPill
                                key={tag.id}
                                tag={tag}
                                applied={isActive}
                                inherited={isInherited}
                                inheritedVia={inheritedTags.get(tag.id)}
                                conflict={applied ? conflicts.get(tag.id) : undefined}
                                className={glowTagId === tag.id ? "ring-2 ring-amber-300/70 animate-pulse" : ""}
                                onRemove={isActive && !isInherited ? () => onRemoveTag(tag) : undefined}
                                onAdd={!isActive ? () => onAddTag(tag.name) : undefined}
                            />
                        );
                    })}
                </div>

                {!applied && canScrollLeft && (
                    <div className="absolute left-0 top-0 bottom-0 w-5 bg-gradient-to-r from-neutral-600 to-transparent pointer-events-none flex items-center text-white">
                        ‹
                    </div>
                )}

                {!applied && canScrollRight && (
                    <div className="absolute right-0 top-0 bottom-0 w-5 bg-gradient-to-l from-neutral-600 to-transparent pointer-events-none flex items-center justify-end text-white">
                        ›
                    </div>
                )}
            </div>
        </div>
    );
};

export default CategoryGroup;