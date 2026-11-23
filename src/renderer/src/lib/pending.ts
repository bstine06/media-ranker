import type { AffectedFile, FolderRuleClash } from "@renderer/shared/types/types";
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

/** One line for a folder rule a batch takes off its folder. */
export function folderRuleText(r: FolderRuleClash): string {
    const keep = (what: string) =>
        r.others > 0 ? ` The other ${plural(r.others, "file")} there keep ${what} as their own.` : "";
    return r.kind === "tag"
        ? `"${r.tag}" comes off ${r.folder} as a folder tag.${keep("the tag")}`
        : `${r.folder}'s no for "${r.tag}" comes off the folder.${keep("the no")}`;
}

/** What a folder rule does to one file of the batch in that folder. */
export function folderRuleDetail(r: FolderRuleClash): string {
    return r.kind === "tag"
        ? `"${r.tag}" comes off ${r.folder} as a folder tag`
        : `${r.folder}'s no for "${r.tag}" comes off`;
}

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
