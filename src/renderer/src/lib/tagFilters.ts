// Special tag filters. They're negative ids so they travel through the same
// activeTags / tagList plumbing as real tags; main/tagFilter.ts turns them
// into SQL.
import type { DbTag, DbTagCategory } from "@renderer/shared/types/types";

/** Files with no tags at all (their own or from their folder). */
export const UNTAGGED = -1;

/** Files with no tag from this category. */
export const missingCategory = (categoryId: number): number => UNTAGGED - categoryId;

/** The category a missingCategory() id stands for, else null. */
export const missingCategoryId = (id: number): number | null =>
    id < UNTAGGED ? UNTAGGED - id : null;

export const isSpecialFilter = (id: number): boolean => id < 0;

/** How to show a filter id: a tag's name, "untagged", or "no <category>". */
export function filterLabel(
    id: number,
    tags: DbTag[],
    categories: DbTagCategory[],
): string | null {
    if (id === UNTAGGED) return "untagged";
    const catId = missingCategoryId(id);
    if (catId != null) {
        const cat = categories.find((c) => c.id === catId);
        return cat ? `no ${cat.name}` : null;
    }
    return tags.find((t) => t.id === id)?.name ?? null;
}
