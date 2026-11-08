import { useTags } from "@renderer/contexts/TagsContext";
import { DbTag } from "@renderer/shared/types/types";
import { useEffect, useMemo, useState } from "react";

// The "Add tag…" box with its suggestion dropdown, shared by the tag panels.
// Picking a suggestion calls onPick; Enter with nothing highlighted calls
// onCreate with the typed text. The box clears once either one finishes.
export function TagInput({
    exclude,
    onPick,
    onCreate,
    className,
}: {
    exclude: DbTag[]; // tags left out of the suggestions (already applied)
    onPick: (name: string) => unknown;
    onCreate: (name: string) => unknown;
    className: string; // wrapper padding; the dropdown lines up with px-3
}): JSX.Element {
    const { allTags } = useTags();
    const [input, setInput] = useState("");
    const [focused, setFocused] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(0);

    const filtered = useMemo(() => {
        if (!input.trim()) return [];

        const q = input.toLowerCase();

        return allTags
            .filter(
                (t) =>
                    t.name.toLowerCase().includes(q) &&
                    !exclude.some((e) => e.id === t.id),
            )
            .sort((a, b) => {
                const aStart = a.name.toLowerCase().startsWith(q);
                const bStart = b.name.toLowerCase().startsWith(q);

                if (aStart && !bStart) return -1;
                if (!aStart && bStart) return 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 8);
    }, [input, allTags, exclude]);

    useEffect(() => setHighlightedIndex(0), [input]);

    const pick = async (name: string): Promise<void> => {
        await onPick(name);
        setInput("");
    };

    const create = async (name: string): Promise<void> => {
        await onCreate(name);
        setInput("");
    };

    // While focused, take arrows, Escape and Space before the views'
    // own hotkeys see them.
    useEffect(() => {
        if (!focused) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex((i) => Math.max(i - 1, -1));
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFocused(false);
            }
            if (e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setInput((i) => i + " ");
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [focused, filtered.length]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    return (
        <div className={`${className} relative`}>
            <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setTimeout(() => setFocused(false), 120)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        if (filtered[highlightedIndex]) {
                            pick(filtered[highlightedIndex].name);
                        } else if (input.trim()) {
                            create(input.trim());
                        }
                    }
                }}
                placeholder="Add tag…"
                className="w-full px-2 py-1.5 text-xs bg-neutral-950 border border-neutral-700 rounded-md text-neutral-200"
            />

            {focused && filtered.length > 0 && (
                <div className="absolute left-3 right-3 top-full mt-1 bg-neutral-950 border border-neutral-700 rounded-md shadow-xl z-20 overflow-hidden">
                    {filtered.map((tag, i) => (
                        <button
                            key={tag.id}
                            onMouseDown={() => pick(tag.name)}
                            onMouseEnter={() => setHighlightedIndex(i)}
                            className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-2
                                ${i === highlightedIndex ? "bg-neutral-800" : "hover:bg-neutral-900"}`}
                        >
                            {tag.category?.icon && (
                                <span style={{ color: tag.category.color }}>
                                    {tag.category.icon}
                                </span>
                            )}
                            {tag.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
