import { DbTag, DbTagWithCategory, TagGroup } from "@renderer/shared/types/types";

/** A category's tags in their Tag Manager order. */
export const byTagOrder = (a: DbTag, b: DbTag): number =>
    a.order_index - b.order_index || a.name.localeCompare(b.name);

// Groups tags by their category, in the categories' order, with
// Uncategorized last.
export function groupTagsByCategory(tags: DbTagWithCategory[]): TagGroup[] {
    const map = new Map<string, TagGroup>();

    for (const tag of tags) {
        const key = tag.category_id != null ? `cat-${tag.category_id}` : "uncategorized";

        if (!map.has(key)) {
            map.set(key, {
                label: tag.category?.name ?? "Uncategorized",
                color: tag.category?.color ?? null,
                icon: tag.category?.icon ?? null,
                tags: [],
                categoryId: tag.category_id ?? null,
                orderIndex: tag.category?.order_index ?? Infinity,
            });
        }

        map.get(key)!.tags.push(tag);
    }

    return Array.from(map.values()).sort((a, b) => {
        if (a.categoryId === null) return 1;
        if (b.categoryId === null) return -1;
        // Same order as Tag Manager: order_index, then creation (id).
        return (a.orderIndex ?? Infinity) - (b.orderIndex ?? Infinity) || a.categoryId - b.categoryId;
    });
}
