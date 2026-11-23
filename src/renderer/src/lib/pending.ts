import type { AffectedFile } from "@renderer/shared/types/types";
import type { PendingItem } from "@renderer/contexts/PendingChangeContext";

export const plural = (n: number, word: string): string =>
    `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** "loses cat, dog · no for kitten cleared" */
export function affectedDetail(a: Pick<AffectedFile, "loses" | "cleared">): string {
    return [
        a.loses.length > 0 ? `loses ${a.loses.join(", ")}` : null,
        a.cleared.length > 0 ? `no for ${a.cleared.join(", ")} cleared` : null,
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
