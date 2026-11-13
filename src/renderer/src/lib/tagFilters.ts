// Helpers for the tag filter tree (FilterNode; main/tagFilter.ts turns it
// into SQL). A group joins its items with one word, AND or OR; any node can
// be WITHOUT. Empty groups are ignored; an empty tree is no filter.
import type { DbTag, DbTagCategory, FilterGroup, FilterNode } from "@renderer/shared/types/types";

export const emptyFilter = (): FilterGroup => ({ kind: "group", op: "and", items: [] });

/**
 * The tree with a fixed key order and no `without: false`, so equal filters
 * stringify the same (main stores and dedupes them in this form too).
 */
export function canonical(node: FilterNode): FilterNode {
    const w = node.without ? { without: true } : {};
    if (node.kind === "group") {
        return { kind: "group", op: node.op, items: node.items.map(canonical), ...w };
    }
    if (node.kind === "tag") return { kind: "tag", id: node.id, ...w };
    return { kind: "count", op: node.op, n: node.n, from: node.from, ...w };
}

/** A stable string for a filter: for equality and effect dependencies. */
export const filterKey = (node: FilterNode | null): string =>
    node ? JSON.stringify(canonical(node)) : "";

/** The tree without empty groups (at any depth), or null if nothing's left. */
export function pruneFilter(node: FilterNode | null): FilterNode | null {
    if (!node) return null;
    if (node.kind !== "group") return node;
    const items = node.items.map(pruneFilter).filter((i): i is FilterNode => i !== null);
    return items.length === 0 ? null : { ...node, items };
}

export const filterIsEmpty = (node: FilterNode | null): boolean => pruneFilter(node) === null;

/** Whether one item refers to a tag or category that no longer exists. */
export function nodeIsBroken(
    node: FilterNode,
    tags: Pick<DbTag, "id">[],
    categories: Pick<DbTagCategory, "id">[],
): boolean {
    if (node.kind === "tag") return !tags.some((t) => t.id === node.id);
    if (node.kind === "count") {
        return typeof node.from === "number" && !categories.some((c) => c.id === node.from);
    }
    return false;
}

/**
 * Whether anywhere in the tree refers to a deleted tag or category. Such a
 * filter isn't applied: a deleted tag under WITHOUT would quietly match
 * everything.
 */
export function filterIsBroken(
    node: FilterNode | null,
    tags: Pick<DbTag, "id">[],
    categories: Pick<DbTagCategory, "id">[],
): boolean {
    if (!node) return false;
    if (node.kind === "group") return node.items.some((i) => filterIsBroken(i, tags, categories));
    return nodeIsBroken(node, tags, categories);
}

/** The filter with tag `from` replaced by `to` (a tag merge). */
export function replaceTag(node: FilterNode, from: number, to: number): FilterNode {
    if (node.kind === "tag") return node.id === from ? { ...node, id: to } : node;
    if (node.kind === "count") return node;
    return { ...node, items: node.items.map((i) => replaceTag(i, from, to)) };
}
