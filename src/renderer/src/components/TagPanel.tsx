import { useTags } from "@renderer/contexts/TagsContext";
import {
    DbFile,
    DbTag,
    DbTagWithCategory,
    FileNo,
    isDbTagArray,
} from "@renderer/shared/types/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import CategoryGroup from "./CategoryGroup";
import { plainText, RichText } from "./InlineRefs";
import { TagPill } from "./TagPill";
import { useClipboard } from "@renderer/contexts/ClipboardContext";
import { useFileTags } from "@renderer/hooks/useFileTags";
import { TagInput } from "./TagInput";
import { groupTagsByCategory } from "@renderer/lib/tagGroups";

// The "Not" section stays open or closed across files (this session).
let notOpenRemembered = false;

/** Where a no on a file comes from, one line each, names marked for
 *  RichText ("tag", «folder»); plainText() of it for hover titles. */
function noSource(n: FileNo): string {
    const lines: string[] = [];
    if (n.hard) lines.push("Marked as no");
    if (n.pass) lines.push("No from a pass");
    if (n.folder) {
        lines.push(
            n.via
                ? `Not allowed in «${n.folder}»: "${n.name}" means "${n.via}"`
                : `Not allowed in «${n.folder}»`,
        );
    }
    if (n.impliedBy) {
        lines.push(`From its no for "${n.impliedBy}": "${n.name}" means "${n.impliedBy}"`);
    }
    return lines.join("\n");
}

export function TagPanel({ file }: { file: DbFile }): JSX.Element {
    const { tags, setTags } = useFileTags(file.id);
    const { tagMap } = useTags();
    // Firm noes (own and from the folder); reread whenever the tags change,
    // since adding a tag settles a no and taking one off makes one.
    const [noes, setNoes] = useState<FileNo[]>([]);
    const [notOpen, setNotOpenState] = useState(notOpenRemembered);
    const setNotOpen = (open: boolean) => {
        notOpenRemembered = open;
        setNotOpenState(open);
    };
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        window.api
            .getFileNoes(file.id)
            .then((n) => {
                if (live) setNoes(n);
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [file.id, tags]);
    useEffect(() => setNote(null), [file.id]);
    useEffect(() => {
        if (!note) return;
        const t = setTimeout(() => setNote(null), 4000);
        return () => clearTimeout(t);
    }, [note]);
    const clearNo = useCallback(
        async (n: FileNo) => {
            await window.api.clearFileNo(file.id, n.id);
            setNoes(await window.api.getFileNoes(file.id));
        },
        [file.id],
    );
    const [suggestionMode, setSuggestionMode] = useState<"folder" | "global">(
        "folder",
    );

    const [popularTags, setPopularTags] = useState<{
        folder: DbTagWithCategory[];
        global: DbTagWithCategory[];
    }>({ folder: [], global: [] });

    const { refreshTags, getTagsWithCategory } = useTags();
    const { copyTags, clipboard } = useClipboard();

    const tagsWithCategory = useMemo(
        () => getTagsWithCategory(tags),
        [tags, getTagsWithCategory],
    );

    useEffect(() => {
        Promise.all([
            file.folder_id
                ? window.api.getMostUsedTags(file.folder_id)
                : Promise.resolve([]),
            window.api.getMostUsedTags(), // ← Use this for sort order
            window.api.getAllTags(), // ← Use this for complete list
        ]).then(([folderTags, sortedGlobalTags, allGlobalTags]) => {
            // Create a map of tag ID -> popularity rank
            const popularityRank = new Map(
                sortedGlobalTags.map((t, i) => [t.id, i]),
            );

            // Sort all tags by popularity (tags not in getMostUsedTags go to end)
            const allGlobal = allGlobalTags.sort((a, b) => {
                const rankA = popularityRank.get(a.id) ?? Infinity;
                const rankB = popularityRank.get(b.id) ?? Infinity;
                return rankA - rankB;
            });

            setPopularTags({
                folder: getTagsWithCategory(folderTags),
                global: getTagsWithCategory(allGlobal),
            });
        });
    }, [file.folder_id, tags, getTagsWithCategory]);

    // add-tag upserts the tag without touching an existing tag's category,
    // so this both applies existing tags and creates new ones.
    const addTag = useCallback(
        async (name: string) => {
            const trimmed = name.trim().toLowerCase();
            if (!trimmed || tags.some((t) => t.name === trimmed)) return;

            const updated = await window.api.addTag(file.id, trimmed);
            await refreshTags();
            setTags(updated);
            // Refused: the folder rules it out.
            if (!updated.some((t) => t.name === trimmed)) {
                const ruled = noes.find((n) => n.name === trimmed && n.folder);
                if (ruled) setNote(noSource({ ...ruled, hard: false, pass: false }));
            }
        },
        [file.id, tags, refreshTags, setTags, noes],
    );

    const removeTag = useCallback(
        async (tag: DbTag) => {
            const updated = await window.api.removeTag(file.id, tag.name);
            setTags(updated);
        },
        [file.id, setTags],
    );

    const handlePasteTags = () => {
        if (!isDbTagArray(clipboard)) return;
        clipboard.forEach((tag) => {
            addTag(tag.name);
        });
    };

    const visiblePopularTags =
        suggestionMode === "folder" ? popularTags.folder : popularTags.global;

    return (
        <div
            className="flex flex-col w-full h-full bg-neutral-900 border-neutral-800 overflow-y-auto"
            style={{ scrollbarGutter: "stable" }}
        >
            {/* Header */}
            <div className="px-4 py-3 border-b border-neutral-800 flex items-center">
                <p className="text-[11px] uppercase tracking-wider text-neutral-400 font-medium">
                    Tags
                </p>

                <div className="ml-auto flex gap-2">
                    <button
                        onClick={() => copyTags(tags)}
                        className="px-2 py-1 text-xs rounded-full bg-neutral-700 text-neutral-300 hover:bg-neutral-600 transition"
                    >
                        Copy
                    </button>
                    <button
                        onClick={handlePasteTags}
                        className="px-2 py-1 text-xs rounded-full bg-neutral-700 text-neutral-300 hover:bg-neutral-600 transition"
                    >
                        Paste
                    </button>
                </div>
            </div>

            {/* Applied tags */}
            <div className="px-3 py-3 space-y-2">
                {groupTagsByCategory(tagsWithCategory).map((g) => (
                    <CategoryGroup
                        key={g.label}
                        applied={true}
                        activeTags={tagsWithCategory}
                        group={g}
                        onRemoveTag={removeTag}
                        onAddTag={addTag}
                    />
                ))}
            </div>

            <TagInput
                exclude={tags}
                onPick={addTag}
                onCreate={addTag}
                className="px-3 pb-1"
            />
            {note && (
                <p className="px-4 pb-1 text-[11px] text-red-300/90">
                    <RichText text={note} />
                </p>
            )}

            {/* Noes: less useful than the tags, so folded away by default. */}
            <div className="border-t border-neutral-800 mt-2">
                <button
                    onClick={() => setNotOpen(!notOpen)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                    <span className={`inline-block transition-transform ${notOpen ? "rotate-90" : ""}`}>›</span>
                    Not
                    <span className="normal-case tracking-normal text-neutral-600 tabular-nums">
                        ({noes.length})
                    </span>
                </button>
                {notOpen && (
                    // Grouped by category, in category order, like the tags above.
                    <div className="px-3 pb-3 space-y-2">
                        {noes.length === 0 && (
                            <p className="px-1 text-[11px] text-neutral-600">No firm noes yet.</p>
                        )}
                        {groupTagsByCategory(
                            noes.map((n) => (tagMap.get(n.id) ?? n) as DbTagWithCategory),
                        ).map((g) => (
                            <CategoryGroup
                                key={g.label}
                                applied={true}
                                activeTags={[]}
                                group={g}
                                onRemoveTag={() => {}}
                                onAddTag={() => {}}
                                renderTag={(tag) => {
                                    const n = noes.find((x) => x.id === tag.id)!;
                                    const own = n.hard || n.pass;
                                    return (
                                        <TagPill
                                            tag={tag}
                                            applied
                                            no
                                            inherited={!own}
                                            title={plainText(noSource(n))}
                                            onRemove={own ? () => clearNo(n) : undefined}
                                        />
                                    );
                                }}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className="flex px-4 py-3 items-center border-neutral-800">
                <p className="text-[11px] flex grow text-neutral-400 font-medium">
                    Popular
                </p>
                <button
                    onClick={() => setSuggestionMode("folder")}
                    className={`text-xs p-1 rounded-sm flex-grow uppercase tracking-wide ${
                        suggestionMode === "folder"
                            ? "text-neutral-200 bg-neutral-600"
                            : "text-neutral-600"
                    }`}
                >
                    Folder
                </button>

                <button
                    onClick={() => setSuggestionMode("global")}
                    className={`text-xs p-1 rounded-sm flex-grow uppercase tracking-wide ${
                        suggestionMode === "global"
                            ? "text-neutral-200 bg-neutral-600"
                            : "text-neutral-600"
                    }`}
                >
                    Global
                </button>
            </div>

            {/* Suggestions */}
            {(popularTags.folder.length > 0 ||
                popularTags.global.length > 0) && (
                <div className="px-3 pb-4 space-y-4 border-t border-neutral-800 pt-3">
                    {visiblePopularTags.length > 0 && (
                        <div>
                            {groupTagsByCategory(visiblePopularTags).map((g) => (
                                <CategoryGroup
                                    key={g.label}
                                    applied={false}
                                    activeTags={tagsWithCategory}
                                    group={g}
                                    onRemoveTag={removeTag}
                                    onAddTag={addTag}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
