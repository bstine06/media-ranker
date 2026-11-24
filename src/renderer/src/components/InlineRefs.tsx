import type { ReactNode } from "react";
import { useTags } from "@renderer/contexts/TagsContext";
import type { DbTagWithCategory } from "@renderer/shared/types/types";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { CollectionChip } from "./ScopeSummary";

// Tags and folders named inside confirms, warnings and the side panel,
// drawn as the pills and chips they are everywhere else (not "quoted").

/** A tag by name, as its pill (looks like TagPill, but read-only: no
 *  buttons or right-click menu inside a confirm or a list row).
 *  `no`: as a no (reddish ⊘). */
export function TagRef({ name, no = false }: { name: string; no?: boolean }): JSX.Element {
    const { allTags, tagMap } = useTags();
    const { showTagCategoryNames } = useSettings();
    const found = allTags.find((t) => t.name === name);
    const tag: DbTagWithCategory | undefined = found ? tagMap.get(found.id) ?? found : undefined;
    const color = tag?.category?.color ?? "#888";
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 align-middle text-xs font-normal normal-case tracking-normal ${
                no
                    ? "border-red-800/80 bg-red-950/60 text-red-200"
                    : "border-neutral-500 bg-neutral-800 text-neutral-300"
            }`}
        >
            {no && <span className="text-[10px] leading-none text-red-400">⊘</span>}
            {tag?.category && !showTagCategoryNames && (
                <span className="text-[10px] leading-none" style={{ color }}>
                    {tag.category.icon}
                </span>
            )}
            {name}
        </span>
    );
}

/** Several tags as pills. */
export function TagRefs({ names, no = false }: { names: string[]; no?: boolean }): JSX.Element {
    return (
        <>
            {names.map((n) => (
                <TagRef key={n} name={n} no={no} />
            ))}
        </>
    );
}

/** A folder (collection) by path, as its chip ("" = Unsorted). */
export function FolderRef({ path }: { path: string }): JSX.Element {
    return (
        <span className="inline-flex align-middle font-normal normal-case tracking-normal">
            <CollectionChip path={path} />
        </span>
    );
}

/** One effect per line: words, pills and chips wrapped together. */
export function Effect({
    mark,
    tone = "plain",
    children,
}: {
    /** ✓ ⊘ ! or nothing. */
    mark?: string;
    tone?: "plain" | "strong" | "muted" | "warn";
    children: ReactNode;
}): JSX.Element {
    const color =
        tone === "strong"
            ? "text-neutral-100 font-semibold"
            : tone === "muted"
              ? "text-neutral-500"
              : tone === "warn"
                ? "text-amber-200/90"
                : "text-neutral-300";
    return (
        <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${color}`}>
            {mark && <span className="w-3 shrink-0 text-center">{mark}</span>}
            {children}
        </div>
    );
}

/** What a file loses / has cleared, as pills: Will remove [cat] · Will remove 'no' for [⊘ dog] */
export function AffectedPills({ loses, cleared }: { loses: string[]; cleared: string[] }): JSX.Element {
    return (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {loses.length > 0 && (
                <>
                    <span>Will remove</span>
                    <TagRefs names={loses} />
                </>
            )}
            {loses.length > 0 && cleared.length > 0 && <span className="text-neutral-600">·</span>}
            {cleared.length > 0 && (
                <>
                    <span>Will remove 'no' for</span>
                    <TagRefs names={cleared} no />
                </>
            )}
        </span>
    );
}

/** A message from the main process with its names marked: "tag" becomes
 *  the tag's pill, «folder» the folder's chip. Anything else is text. */
export function RichText({ text }: { text: string }): JSX.Element {
    const parts: ReactNode[] = [];
    const re = /"([^"]+)"|«([^»]+)»/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m.index > last) parts.push(text.slice(last, m.index));
        parts.push(m[1] != null ? <TagRef key={m.index} name={m[1]} /> : <FolderRef key={m.index} path={m[2]} />);
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    // Inline, so the text's own spaces (and none before a comma) set the gaps.
    return <span className="leading-6">{parts}</span>;
}

/** The same message as plain text (for hover titles): markers dropped. */
export const plainText = (text: string): string => text.replace(/«([^»]+)»/g, "$1");
