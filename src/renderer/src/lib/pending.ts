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
    return list.map((a) => ({ fileId: a.fileId, detail: affectedDetail(a), loses: a.loses, cleared: a.cleared }));
}

/** Own tags removed in all. */
export const removesCount = (list: AffectedFile[]): number =>
    list.reduce((n, a) => n + a.loses.length, 0);

/** Merges items for the same file (details joined, tags and noes pooled). */
export function mergeItems(items: PendingItem[]): PendingItem[] {
    const m = new Map<number, { details: string[]; loses: Set<string>; cleared: Set<string>; pills: boolean }>();
    for (const i of items) {
        if (!i.detail) continue;
        const e = m.get(i.fileId) ?? { details: [], loses: new Set(), cleared: new Set(), pills: false };
        if (!e.details.includes(i.detail)) e.details.push(i.detail);
        i.loses?.forEach((t) => e.loses.add(t));
        i.cleared?.forEach((t) => e.cleared.add(t));
        if (i.loses || i.cleared) e.pills = true;
        m.set(i.fileId, e);
    }
    return [...m].map(([fileId, e]) => ({
        fileId,
        detail: e.details.join(" · "),
        ...(e.pills ? { loses: [...e.loses], cleared: [...e.cleared] } : {}),
    }));
}
