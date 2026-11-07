// Quick tags: a bar over the media (Scroll, Discover, Compare) whose keys
// 1–4 turn a category's first tags on and off for the file on screen, and `
// switches category. Categories opt out in Tag Manager; the order of a
// category's tags (dragged in Tag Manager) decides which get keys.

import { DbTag, DbTagCategory } from "@renderer/shared/types/types";

/** How many of a category's tags get keys (1 to this). */
export const QUICK_TAG_SLOTS = 4;

/** A category's tags in their Tag Manager order. */
export const byTagOrder = (a: DbTag, b: DbTag): number =>
    a.order_index - b.order_index || a.name.localeCompare(b.name);

/** Categories the bar can offer: opted in, with at least one tag. */
export function quickTagCategories(
    categories: DbTagCategory[],
    tags: DbTag[],
): DbTagCategory[] {
    return categories.filter(
        (c) => c.quick_tags && tags.some((t) => t.category_id === c.id),
    );
}
