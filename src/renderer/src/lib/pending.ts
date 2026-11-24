import type { AffectedFile } from "@renderer/shared/types/types";
import type { PendingItem } from "@renderer/contexts/PendingChangeContext";

export const plural = (n: number, word: string): string =>
    `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** Tag names in quotes: "cat", "dog" */
export const quoted = (names: string[]): string => names.map((n) => `"${n}"`).join(", ");

/** Will remove "cat", "dog" · Will remove 'no' for "kitten" */
export function affectedDetail(a: Pick<AffectedFile, "loses" | "cleared">): string {
    return [
        a.loses.length > 0 ? `Will remove ${quoted(a.loses)}` : null,
        a.cleared.length > 0 ? `Will remove 'no' for ${quoted(a.cleared)}` : null,
    ]
        .filter(Boolean)
        .join(" · ");
}

export function affectedItems(list: AffectedFile[]): PendingItem[] {
    return list.map((a) => ({ fileId: a.fileId, detail: affectedDetail(a) }));
}

/** Own tags removed in all. */
export const removesCount = (list: AffectedFile[]): number =>
    list.reduce((n, a) => n + a.loses.length, 0);

/** Merges items for the same file (details joined). */
export function mergeItems(items: PendingItem[]): PendingItem[] {
    const m = new Map<number, string[]>();
    for (const i of items) {
        if (!i.detail) continue;
        const list = m.get(i.fileId) ?? [];
        if (!list.includes(i.detail)) list.push(i.detail);
        m.set(i.fileId, list);
    }
    return [...m].map(([fileId, d]) => ({ fileId, detail: d.join(" · ") }));
}
