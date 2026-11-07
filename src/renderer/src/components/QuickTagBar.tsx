import { useEffect, useMemo, useRef, useState } from "react";
import { DbFile } from "@renderer/shared/types/types";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFileTags } from "@renderer/hooks/useFileTags";
import { QUICK_TAG_SLOTS, byTagOrder, quickTagCategories } from "@renderer/lib/quickTags";

const SLOT_KEYS = ["Digit1", "Digit2", "Digit3", "Digit4"].slice(0, QUICK_TAG_SLOTS);

/**
 * The quick tag bar (see lib/quickTags.ts): keys 1–4 turn the category's
 * first tags on and off for `file`, ` / Shift+` switch category. Shown
 * while the setting is on (T); keys only work while `active`.
 */
export function QuickTagBar({
    file,
    active,
    className = "",
}: {
    file: DbFile | null;
    active: boolean;
    className?: string;
}): JSX.Element | null {
    const { quickTagsEnabled, quickTagCategoryId, setQuickTagCategoryId } = useSettings();
    const { allTags, allCategories } = useTags();
    const { tags, addTag, removeTag } = useFileTags(
        quickTagsEnabled && file ? file.id : null,
    );
    // An inherited tag's key was pressed: it can't be turned off here.
    const [flashId, setFlashId] = useState<number | null>(null);

    const categories = useMemo(
        () => quickTagCategories(allCategories, allTags),
        [allCategories, allTags],
    );
    // Stays on the chosen category until the user switches. If that one
    // can't be offered any more (deleted, opted out, emptied), the first.
    const category =
        categories.find((c) => c.id === quickTagCategoryId) ?? categories[0] ?? null;
    const slots = useMemo(
        () =>
            category
                ? allTags
                      .filter((t) => t.category_id === category.id)
                      .sort(byTagOrder)
                      .slice(0, QUICK_TAG_SLOTS)
                : [],
        [allTags, category],
    );

    // Latest values for the key handler, without re-binding on every change.
    const state = useRef({ categories, category, slots, tags, addTag, removeTag });
    state.current = { categories, category, slots, tags, addTag, removeTag };

    const cycle = (step: 1 | -1) => {
        const { categories, category } = state.current;
        if (categories.length === 0) return;
        const i = category ? categories.findIndex((c) => c.id === category.id) : -1;
        const next = categories[(i + step + categories.length) % categories.length];
        setQuickTagCategoryId(next.id);
    };

    const toggle = (index: number) => {
        const { slots, tags, addTag, removeTag } = state.current;
        const tag = slots[index];
        if (!tag) return;
        const onFile = tags.find((t) => t.id === tag.id);
        if (onFile?.inherited) {
            setFlashId(tag.id);
            return;
        }
        if (onFile) removeTag(tag.name);
        else addTag(tag.name);
    };

    useEffect(() => {
        if (flashId == null) return;
        const t = setTimeout(() => setFlashId(null), 450);
        return () => clearTimeout(t);
    }, [flashId]);

    const keysOn = quickTagsEnabled && active && file != null;
    useEffect(() => {
        if (!keysOn) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const el = document.activeElement as HTMLElement | null;
            const typing =
                (el instanceof HTMLInputElement &&
                    !["checkbox", "radio", "range", "button", "submit"].includes(el.type)) ||
                el?.tagName === "TEXTAREA" ||
                el?.tagName === "SELECT" ||
                el?.isContentEditable;
            if (typing) return;
            if (e.code === "Backquote") {
                e.preventDefault();
                if (!e.repeat) cycle(e.shiftKey ? -1 : 1);
                return;
            }
            const slot = SLOT_KEYS.indexOf(e.code);
            if (slot >= 0 && !e.shiftKey) {
                e.preventDefault();
                if (!e.repeat) toggle(slot);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [keysOn]);

    if (!quickTagsEnabled || !file) return null;

    return (
        <div
            className={`pointer-events-auto flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-full bg-black/70 px-1.5 py-1 text-xs text-neutral-300 shadow-lg backdrop-blur ${className}`}
            // Clicks here are for the bar, not the media under it.
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        >
            {category ? (
                <>
                    <button
                        onClick={() => cycle(1)}
                        title="Switch category (` · Shift+` goes back)"
                        className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 hover:bg-white/10 transition-colors"
                    >
                        <Key>`</Key>
                        <span style={{ color: category.color }}>{category.icon}</span>
                        <span className="max-w-[8rem] truncate text-neutral-200">{category.name}</span>
                    </button>
                    <span className="h-4 w-px shrink-0 bg-white/15" />
                    {slots.map((tag, i) => {
                        const onFile = tags.find((t) => t.id === tag.id);
                        const inherited = onFile?.inherited ?? false;
                        return (
                            <button
                                key={tag.id}
                                onClick={() => toggle(i)}
                                title={
                                    inherited
                                        ? onFile?.inheritedVia
                                            ? `Comes with "${onFile.inheritedVia}". Remove "${onFile.inheritedVia}" to take it off.`
                                            : "From the folder's tags. Remove it there to take it off."
                                        : undefined
                                }
                                className={`flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 transition-colors ${
                                    onFile
                                        ? "bg-neutral-200 text-neutral-900"
                                        : "hover:bg-white/10"
                                } ${inherited ? "opacity-50 cursor-default" : ""} ${
                                    flashId === tag.id ? "ring-2 ring-red-400" : ""
                                }`}
                            >
                                <Key dark={!!onFile}>{i + 1}</Key>
                                <span className="truncate">{tag.name}</span>
                            </button>
                        );
                    })}
                </>
            ) : (
                <span className="px-2 py-0.5 text-neutral-400">
                    No categories for quick tags. Turn them on in Tag Manager · T hides this
                </span>
            )}
        </div>
    );
}

function Key({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
    return (
        <kbd
            className={`rounded px-1 font-mono text-[10px] leading-4 ${
                dark ? "bg-neutral-900/15 text-neutral-700" : "bg-white/10 text-neutral-400"
            }`}
        >
            {children}
        </kbd>
    );
}
