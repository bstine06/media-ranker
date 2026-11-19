import { useTags } from "@renderer/contexts/TagsContext";
import {
    DbTag,
    DbTagCategory,
    DbTagWithCategory,
    TagCoverage,
    TagImplicationPreview,
    TagUsage,
    View,
} from "@renderer/shared/types/types";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { usePass } from "@renderer/contexts/PassContext";
import TagCoverageView, { TagCoverageSummary, useTagCoverage } from "./TagCoverageView";
import ConfirmDialog from "./ConfirmDialog";
import React, { useEffect, useMemo, useState } from "react";
import { TagIcon } from "./icons/TagIcon";
import { TagPill } from "./TagPill";
import { byTagOrder } from "@renderer/lib/tagGroups";

type FocusTarget =
    | { kind: "tag"; item: DbTagWithCategory }
    | { kind: "category"; item: DbTagCategory }
    | { kind: "newCategory" }
    | { kind: "newTag" }
    | null;

export const PRESET_COLORS = [
    "#FFFFFF", // pure white (max contrast)
    "#FFFF00", // electric yellow
    "#00FFFF", // cyan
    "#FF00FF", // magenta
    "#39FF14", // neon green
    "#FF3131", // bright red
    "#66FF66", // light green
    "#66CCFF", // light sky blue
    "#FF66CC", // bright pink
    "#FFD700", // gold (high luminance)
];

export const PRESET_ICONS = ["●", "▲", "■", "◆", "★"];

// ─── CategoryEditor ───────────────────────────────────────────────────────────


// Deleting a tag or category a saved feed uses breaks that feed: it won't
// apply until it's fixed in the filter builder.
function feedsWarning(names: string[]): string {
    if (names.length === 0) return "";
    const list = names.map((n) => `"${n}"`).join(", ");
    return names.length === 1
        ? ` The saved feed ${list} uses it, and won't apply until you fix it.`
        : ` The saved feeds ${list} use it, and won't apply until you fix them.`;
}

function CategoryEditor({
    category,
    onDone,
    onToggleQuickAdd,
    isQuickAdding,
}: {
    category: DbTagCategory | null;
    onDone: () => void;
    onToggleQuickAdd?: () => void;
    isQuickAdding?: boolean;
}) {
    const [name, setName] = useState(category?.name ?? "");
    const [color, setColor] = useState(category?.color ?? PRESET_COLORS[0]);
    const [icon, setIcon] = useState(category?.icon ?? PRESET_ICONS[0]);
    const [customIcon, setCustomIcon] = useState("");

    const {
        allTags,
        allCategories,
        createCategory,
        updateCategory,
        deleteCategory,
        setCategoryTagsSweep,
    } = useTags();
    // Live copy: the toggle below saves straight away.
    const liveCategory = category
        ? allCategories.find((c) => c.id === category.id)
        : undefined;
    const [confirmDelete, setConfirmDelete] = useState(false);
    // Saved feeds counting tags in this category, named in the delete confirm.
    const [deleteFeeds, setDeleteFeeds] = useState<string[]>([]);
    const nameTaken = allCategories.some(
        (c) => c.name === name.trim() && c.id !== category?.id,
    );
    const tagsInCategory = category
        ? allTags.filter((t) => t.category_id === category.id).length
        : 0;

    // An existing category saves color and icon as they're picked; only a
    // name change waits for Save (or Enter). A new one is made by Create.
    const pickColor = (c: string) => {
        setColor(c);
        if (category) updateCategory(category.id, { color: c });
    };
    const pickIcon = (ic: string) => {
        setIcon(ic);
        if (category) updateCategory(category.id, { icon: ic });
    };

    const handleCustomIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        // Take the last typed character so the field always shows 1 char
        const char = val.slice(-1);
        if (char) {
            pickIcon(char);
            setCustomIcon(char);
        }
    };

    const trimmedName = name.trim().toLowerCase();
    const nameChanged =
        liveCategory != null && trimmedName !== "" && trimmedName !== liveCategory.name;

    const saveName = async () => {
        if (!category || !nameChanged || nameTaken) return;
        await updateCategory(category.id, { name: trimmedName });
        setName(trimmedName);
    };

    const handleCreate = async () => {
        if (!trimmedName || nameTaken) return;
        await createCategory(trimmedName, color, icon);
        onDone();
    };

    const handleDelete = async () => {
        if (!category) return;
        await deleteCategory(category.id);
        onDone();
    };

    return (
        <div className="p-5 flex flex-col gap-5">
            {/* Live preview badge */}
            <div
                className="self-start flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium"
                style={{ background: color + "22", color }}
            >
                <span className="text-xs leading-none">{icon}</span>
                {name || "Category name"}
            </div>
            {category && (
                <div className="flex gap-3 items-center">
                    <button
                        onClick={onToggleQuickAdd}
                        className={`px-3 py-1.5 w-fit text-xs ${isQuickAdding ? "bg-neutral-200 text-neutral-900 border-neutral-400 hover:bg-neutral-100" : "text-neutral-400 border-neutral-700 hover:bg-neutral-800"}  border  rounded-md  transition-colors`}
                    >
                        {"Quick Add"}
                    </button>
                    <span className="text-xs italic text-neutral-500">
                        {isQuickAdding
                            ? "Stop Quick Adding"
                            : "Click tags in the tag list to quickly add them to this category"}
                    </span>
                </div>
            )}

            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Category name
                </label>
                <input
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={name}
                    // Force lowercase as-typed, same as tag names.
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                    onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        if (category) saveName();
                        else handleCreate();
                    }}
                />
                {nameChanged && (
                    <div className="flex gap-2 mt-1">
                        <button
                            onClick={saveName}
                            disabled={nameTaken}
                            className="px-3 py-1 text-xs bg-neutral-200 text-neutral-900 rounded-md hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Save name
                        </button>
                        <button
                            onClick={() => setName(liveCategory!.name)}
                            className="px-3 py-1 text-xs text-neutral-400 border border-neutral-700 rounded-md hover:bg-neutral-800 transition-colors"
                        >
                            Undo
                        </button>
                    </div>
                )}
                {nameTaken && (
                    <p className="text-[11px] text-red-400">
                        A category named "{name.trim()}" already exists.
                    </p>
                )}
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Color
                </label>
                <div className="flex gap-2 flex-wrap">
                    {PRESET_COLORS.map((c) => (
                        <button
                            key={c}
                            onClick={() => pickColor(c)}
                            className="w-6 h-6 rounded-full transition-transform hover:scale-110 focus:outline-none"
                            style={{
                                background: c,
                                boxShadow:
                                    color === c
                                        ? `0 0 0 2px #fff, 0 0 0 3px ${c}`
                                        : "none",
                            }}
                        />
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Icon
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                    {PRESET_ICONS.map((ic) => (
                        <button
                            key={ic}
                            onClick={() => {
                                pickIcon(ic);
                                setCustomIcon("");
                            }}
                            className={`w-8 h-8 rounded-md text-sm border transition-colors ${
                                icon === ic && !customIcon
                                    ? "bg-neutral-600 border-neutral-500 text-neutral-100"
                                    : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:bg-neutral-700"
                            }`}
                        >
                            {ic}
                        </button>
                    ))}
                    <div className="flex items-center gap-1.5 ml-1">
                        <span className="text-[11px] text-neutral-600">or</span>
                        <input
                            className={`w-8 h-8 rounded-md text-sm border text-center bg-neutral-800 text-neutral-200 outline-none transition-colors ${
                                customIcon
                                    ? "border-neutral-500 bg-neutral-600"
                                    : "border-neutral-700 focus:border-neutral-500"
                            }`}
                            value={customIcon}
                            onChange={handleCustomIconChange}
                            maxLength={2}
                            placeholder="?"
                        />
                    </div>
                </div>
            </div>

            {liveCategory && (() => {
                const own = allTags.filter((t) => t.category_id === liveCategory.id);
                const onCount = own.filter((t) => t.sweep).length;
                return (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex flex-col gap-0.5">
                                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                                    Tag pointer
                                </label>
                                <p className="text-[11px] text-neutral-600">
                                    Offer this category's tags in the tag pointer (its tag list and
                                    random picks). Off overrides each tag's own setting.
                                </p>
                            </div>
                            <OnOff
                                on={!!liveCategory.sweep}
                                onToggle={() =>
                                    updateCategory(liveCategory.id, { sweep: liveCategory.sweep ? 0 : 1 })
                                }
                            />
                        </div>
                        {own.length > 0 && (
                            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                                <span>
                                    {onCount} of {own.length} tags on
                                </span>
                                <button
                                    onClick={() => setCategoryTagsSweep(liveCategory.id, true)}
                                    disabled={onCount === own.length}
                                    className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                                >
                                    Turn all on
                                </button>
                                <button
                                    onClick={() => setCategoryTagsSweep(liveCategory.id, false)}
                                    disabled={onCount === 0}
                                    className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                                >
                                    Turn all off
                                </button>
                            </div>
                        )}
                    </div>
                );
            })()}

            <div className="flex gap-2">
                {!category && (
                    <>
                        <button
                            onClick={onDone}
                            className="px-3 py-1.5 text-xs text-neutral-400 border border-neutral-700 rounded-md hover:bg-neutral-800 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={!name.trim() || nameTaken}
                            className="px-3 py-1.5 text-xs bg-neutral-200 text-neutral-900 rounded-md hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Create category
                        </button>
                    </>
                )}

                {category && (
                    <button
                        onClick={async () => {
                            setDeleteFeeds(await window.api.feedsUsing({ categoryId: category.id }));
                            setConfirmDelete(true);
                        }}
                        className="ml-auto px-3 py-1.5 text-xs text-red-400 border border-red-900/50 rounded-md hover:bg-red-950/30 transition-colors"
                    >
                        Delete category
                    </button>
                )}
            </div>

            {confirmDelete && category && (
                <ConfirmDialog
                    title="Delete category?"
                    message={
                        `Delete the category "${category.name}"?` +
                        (tagsInCategory > 0
                            ? ` Its ${tagsInCategory} tag${tagsInCategory === 1 ? "" : "s"} ` +
                              `will be kept, without a category.`
                            : "") +
                        feedsWarning(deleteFeeds)
                    }
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}

// The small on/off switch used for Tag Manager settings.
function OnOff({
    on,
    onToggle,
    disabled = false,
}: {
    on: boolean;
    onToggle: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            onClick={onToggle}
            disabled={disabled}
            className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                on
                    ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            }`}
        >
            {on ? "on" : "off"}
        </button>
    );
}

/** Drag data set when a tag in the list starts dragging. */
const TAG_DRAG_TYPE = "application/x-media-ranker-tag";

// ─── NewTagEditor ─────────────────────────────────────────────────────────────

function NewTagEditor({ onDone }: { onDone: () => void }) {
    const [name, setName] = useState("");
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const { allTags, allCategories, createTag } = useTags();

    // Belt-and-suspenders: lowercase again on save in case name was ever
    // set some other way. The input's onChange already keeps it lowercase
    // as the user types, so this should normally be a no-op.
    const trimmed = name.trim().toLowerCase();
    const exists = allTags.some((t) => t.name === trimmed);

    const handleSave = async () => {
        if (!trimmed || exists) return;
        await createTag(trimmed, categoryId);
        onDone();
    };

    return (
        <div className="p-5 flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Tag name
                </label>
                <input
                    autoFocus
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={name}
                    // Force lowercase as-typed so it matches how TagPanel /
                    // FolderTagPanel create and compare tag names.
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                    onKeyDown={(e) => e.key === "Enter" && handleSave()}
                    placeholder="Tag name"
                />
                {exists && (
                    <p className="text-[11px] text-red-400">
                        A tag named "{trimmed}" already exists.
                    </p>
                )}
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Category{" "}
                    <span className="normal-case text-neutral-600">
                        (optional)
                    </span>
                </label>
                <select
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={categoryId ?? ""}
                    onChange={(e) =>
                        setCategoryId(
                            e.target.value === ""
                                ? null
                                : Number(e.target.value),
                        )
                    }
                >
                    <option value="">— none —</option>
                    {allCategories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                            {cat.icon} {cat.name}
                        </option>
                    ))}
                </select>
            </div>

            <div className="flex gap-2">
                <button
                    onClick={onDone}
                    className="px-3 py-1.5 text-xs text-neutral-400 border border-neutral-700 rounded-md hover:bg-neutral-800 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSave}
                    disabled={!trimmed || exists}
                    className="px-3 py-1.5 text-xs bg-neutral-200 text-neutral-900 rounded-md hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    Create tag
                </button>
            </div>
        </div>
    );
}

// ─── TagEditor ────────────────────────────────────────────────────────────────

function TagEditor({
    tag,
    onDone,
    coverage,
}: {
    tag: DbTagWithCategory;
    onDone: () => void;
    coverage: TagCoverage | null;
}) {
    const [name, setName] = useState(tag.name);
    const [categoryId, setCategoryId] = useState<number | null>(
        tag.category_id,
    );
    const { allCategories, tagMap, updateTag, mergeTags, deleteTag, setTagSweep } = useTags();
    // The saved name (the input holds an unsaved edit).
    const savedName = tagMap.get(tag.id)?.name ?? tag.name;
    // Renamed onto an existing tag: confirm before merging, since the user
    // may not know it exists, or it may mean something else.
    const [mergeTarget, setMergeTarget] = useState<
        (DbTag & TagUsage) | null
    >(null);
    const [deleteUsage, setDeleteUsage] = useState<TagUsage | null>(null);
    // Saved feeds using this tag, named in the delete confirm.
    const [deleteFeeds, setDeleteFeeds] = useState<string[]>([]);
    const [mergeError, setMergeError] = useState<string | null>(null);

    // Same lowercase enforcement here: renaming a tag to mixed case would
    // silently break the lowercase-based matching in TagPanel /
    // FolderTagPanel just as badly as creating one with capitals would.
    const trimmed = name.trim().toLowerCase();
    const nameChanged = trimmed !== "" && trimmed !== savedName;

    // Only a name change waits for Save (or Enter); the category saves as
    // it's picked.
    const saveName = async () => {
        if (!nameChanged) return;
        const result = await updateTag(tag.id, trimmed, categoryId);
        if (!result.ok) {
            setMergeTarget(result.conflict);
            return;
        }
        setName(trimmed);
    };

    const pickCategory = (id: number | null) => {
        setCategoryId(id);
        updateTag(tag.id, savedName, id);
    };

    const handleMerge = async () => {
        if (!mergeTarget) return;
        const result = await mergeTags(tag.id, mergeTarget.id);
        setMergeTarget(null);
        if (!result.ok) {
            setMergeError(result.error);
            return;
        }
        onDone();
    };

    const handleDelete = async () => {
        await deleteTag(tag.id);
        setDeleteUsage(null);
        onDone();
    };

    const targetCategory = mergeTarget
        ? allCategories.find((c) => c.id === mergeTarget.category_id)
        : undefined;

    return (
        <div className="p-5 flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Tag name
                </label>
                <input
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                    onKeyDown={(e) => e.key === "Enter" && saveName()}
                />
                {nameChanged && (
                    <div className="flex gap-2 mt-1">
                        <button
                            onClick={saveName}
                            className="px-3 py-1 text-xs bg-neutral-200 text-neutral-900 rounded-md hover:bg-white transition-colors"
                        >
                            Save name
                        </button>
                        <button
                            onClick={() => setName(savedName)}
                            className="px-3 py-1 text-xs text-neutral-400 border border-neutral-700 rounded-md hover:bg-neutral-800 transition-colors"
                        >
                            Undo
                        </button>
                    </div>
                )}
                <p className="text-[11px] text-neutral-600">
                    Renaming it to another tag's name lets you merge the two.
                </p>
                {mergeError && (
                    <p className="text-[11px] text-red-400">
                        Couldn't merge: {mergeError}
                    </p>
                )}
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Category
                </label>
                <select
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={categoryId ?? ""}
                    onChange={(e) =>
                        pickCategory(
                            e.target.value === ""
                                ? null
                                : Number(e.target.value),
                        )
                    }
                >
                    <option value="">— none —</option>
                    {allCategories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                            {cat.icon} {cat.name}
                        </option>
                    ))}
                </select>
            </div>

            <TagCoverageSummary tagId={tag.id} coverage={coverage} />

            <TagLinksEditor tag={tag} />

            {(() => {
                const live = tagMap.get(tag.id) ?? tag;
                const category = live.category_id != null
                    ? allCategories.find((c) => c.id === live.category_id)
                    : undefined;
                const locked = category != null && !category.sweep;
                return (
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                                Tag pointer
                            </label>
                            <p className="text-[11px] text-neutral-600">
                                {locked
                                    ? `Can't be changed: its category "${category!.name}" is off in the tag pointer. Turn the category on to choose for this tag.`
                                    : "Offer this tag in the tag pointer (its tag list and random picks)."}
                            </p>
                        </div>
                        <OnOff
                            on={!locked && !!live.sweep}
                            disabled={locked}
                            onToggle={() => setTagSweep(tag.id, !live.sweep)}
                        />
                    </div>
                );
            })()}

            <div className="flex gap-2">
                <button
                    onClick={async () => {
                        const [usage, feeds] = await Promise.all([
                            window.api.getTagUsage(tag.id),
                            window.api.feedsUsing({ tagId: tag.id }),
                        ]);
                        setDeleteFeeds(feeds);
                        setDeleteUsage(usage);
                    }}
                    className="ml-auto px-3 py-1.5 text-xs text-red-400 border border-red-900/50 rounded-md hover:bg-red-950/30 transition-colors"
                >
                    Delete tag
                </button>
            </div>

            {mergeTarget && (
                <ConfirmDialog
                    title="Merge tags?"
                    message={
                        `A tag named "${mergeTarget.name}" already exists` +
                        ` (${usageText(mergeTarget)}). ` +
                        `Merge "${tag.name}" into it? Everything tagged ` +
                        `"${tag.name}" will be tagged "${mergeTarget.name}" ` +
                        `instead, and "${tag.name}" will be deleted. ` +
                        (targetCategory
                            ? `"${mergeTarget.name}" stays in ${targetCategory.name}.`
                            : `"${mergeTarget.name}" has no category.`)
                    }
                    confirmText="Merge"
                    danger={false}
                    onConfirm={handleMerge}
                    onCancel={() => setMergeTarget(null)}
                />
            )}
            {deleteUsage && (
                <ConfirmDialog
                    title="Delete tag?"
                    message={
                        (deleteUsage.files === 0 && deleteUsage.folders === 0
                            ? `Delete "${tag.name}"? It isn't on any files.`
                            : `Delete "${tag.name}"? It's on ${usageText(deleteUsage)}, ` +
                              `and will be removed from all of them. ⌘Z brings it back.`) +
                        feedsWarning(deleteFeeds)
                    }
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleteUsage(null)}
                />
            )}
        </div>
    );
}

// ─── TagLinksEditor ───────────────────────────────────────────────────────────
// "kitten" implies "cat": anything tagged kitten also gets cat (inherited,
// like a folder's tags). Links save straight away, after a confirm when
// they change any files.

function TagLinksEditor({ tag }: { tag: DbTagWithCategory }) {
    const { allTags, implications, tagMap, refreshTags, addImplication, removeImplication } =
        useTags();
    const [input, setInput] = useState("");
    const [highlighted, setHighlighted] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<{
        action: "add" | "remove";
        target: DbTagWithCategory;
        preview: TagImplicationPreview;
    } | null>(null);

    const byId = (id: number) => tagMap.get(id);
    const implies = implications
        .filter((l) => l.tag_id === tag.id)
        .map((l) => byId(l.implies_id))
        .filter((t): t is DbTagWithCategory => t != null)
        .sort((a, b) => a.name.localeCompare(b.name));
    const impliedBy = implications
        .filter((l) => l.implies_id === tag.id)
        .map((l) => byId(l.tag_id))
        .filter((t): t is DbTagWithCategory => t != null)
        .sort((a, b) => a.name.localeCompare(b.name));

    // Tags it gets through chains (implies cat, cat implies animal).
    const alsoGets = useMemo(() => {
        const next = new Map<number, number[]>();
        for (const l of implications) {
            next.set(l.tag_id, [...(next.get(l.tag_id) ?? []), l.implies_id]);
        }
        const direct = new Set(next.get(tag.id) ?? []);
        const seen = new Set<number>();
        const stack = [...direct];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            stack.push(...(next.get(id) ?? []));
        }
        return [...seen]
            .filter((id) => !direct.has(id) && id !== tag.id)
            .map(byId)
            .filter((t): t is DbTagWithCategory => t != null)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [implications, tag.id, tagMap]);

    const query = input.trim().toLowerCase();
    const candidates = useMemo(() => {
        if (!query) return [];
        return allTags
            .filter(
                (t) =>
                    t.id !== tag.id &&
                    !implies.some((i) => i.id === t.id) &&
                    t.name.includes(query),
            )
            .sort((a, b) => {
                const aStart = a.name.startsWith(query);
                const bStart = b.name.startsWith(query);
                if (aStart !== bStart) return aStart ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 8);
    }, [query, allTags, implies, tag.id]);

    useEffect(() => setHighlighted(0), [query]);

    const changesNothing = (p: TagImplicationPreview) =>
        p.files === 0 && p.convertedFiles === 0 && p.convertedFolders === 0;

    const link = async (target: DbTagWithCategory) => {
        setError(null);
        const preview = await window.api.previewTagImplication(tag.id, target.id, "add");
        if ("error" in preview) {
            setError(preview.error);
            return;
        }
        setInput("");
        if (changesNothing(preview)) {
            await commit("add", target);
        } else {
            setPending({ action: "add", target, preview });
        }
    };

    const unlink = async (target: DbTagWithCategory) => {
        setError(null);
        const preview = await window.api.previewTagImplication(tag.id, target.id, "remove");
        if ("error" in preview) {
            setError(preview.error);
            return;
        }
        if (changesNothing(preview)) {
            await commit("remove", target);
        } else {
            setPending({ action: "remove", target, preview });
        }
    };

    const commit = async (action: "add" | "remove", target: DbTagWithCategory) => {
        setPending(null);
        if (action === "add") {
            const result = await addImplication(tag.id, target.id);
            if (!result.ok) setError(result.error);
        } else {
            await removeImplication(tag.id, target.id);
        }
    };

    // Enter with no match makes the tag, then links it.
    const createAndLink = async () => {
        if (!query || query === tag.name) return;
        const created = await window.api.createTag(query, null);
        await refreshTags();
        await link({ ...created, category: null });
    };

    const confirmMessage = (): string => {
        if (!pending) return "";
        const { action, target, preview } = pending;
        if (action === "remove") {
            return (
                `"${tag.name}" will no longer bring "${target.name}" with it. ` +
                `${count(-preview.files, "file")} will lose "${target.name}".`
            );
        }
        let message = `Everything tagged "${tag.name}" will also get "${target.name}".`;
        if (preview.files > 0) {
            message += ` That adds "${target.name}" to ${count(preview.files, "file")}.`;
        }
        const converted = [
            preview.convertedFiles > 0 ? count(preview.convertedFiles, "file") : null,
            preview.convertedFolders > 0 ? count(preview.convertedFolders, "folder") : null,
        ].filter(Boolean);
        if (converted.length > 0) {
            const one = preview.convertedFiles + preview.convertedFolders === 1;
            message +=
                ` ${converted.join(" and ")} already ${one ? "has" : "have"} ` +
                `"${target.name}" and will get it from "${tag.name}" instead, ` +
                `so ${one ? "it loses" : "they lose"} it if "${tag.name}" is ` +
                `removed or this link is deleted.`;
        }
        return message;
    };

    return (
        <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                Also tags as
            </label>
            <p className="text-[11px] text-neutral-600 -mt-1">
                Anything tagged "{tag.name}" gets these too, like a folder's tags.
            </p>

            {implies.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {implies.map((t) => (
                        <TagPill
                            key={t.id}
                            tag={t}
                            applied={true}
                            onRemove={() => unlink(t)}
                        />
                    ))}
                </div>
            )}
            {alsoGets.length > 0 && (
                <p className="text-[11px] text-neutral-500">
                    Through those, also: {alsoGets.map((t) => t.name).join(", ")}
                </p>
            )}

            <div className="relative">
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value.toLowerCase())}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setHighlighted((i) => Math.min(i + 1, candidates.length - 1));
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setHighlighted((i) => Math.max(i - 1, 0));
                        } else if (e.key === "Enter") {
                            const exact = allTags.find((t) => t.name === query);
                            if (candidates[highlighted]) link(candidates[highlighted]);
                            else if (exact && exact.id !== tag.id) link(exact);
                            else if (!exact) createAndLink();
                        } else if (e.key === "Escape") {
                            setInput("");
                        }
                    }}
                    placeholder="Add a tag…"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                />
                {candidates.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-neutral-950 border border-neutral-700 rounded-md shadow-xl z-20 overflow-hidden">
                        {candidates.map((t, i) => (
                            <button
                                key={t.id}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    link(t);
                                }}
                                onMouseEnter={() => setHighlighted(i)}
                                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                                    i === highlighted ? "bg-neutral-800" : "hover:bg-neutral-900"
                                }`}
                            >
                                {t.category?.icon && (
                                    <span style={{ color: t.category.color }}>
                                        {t.category.icon}
                                    </span>
                                )}
                                {t.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {error && <p className="text-[11px] text-red-400">{error}</p>}

            {impliedBy.length > 0 && (
                <p className="text-[11px] text-neutral-500">
                    Comes with: {impliedBy.map((t) => t.name).join(", ")}
                </p>
            )}

            {pending && (
                <ConfirmDialog
                    title={pending.action === "add" ? "Link tags?" : "Remove link?"}
                    message={confirmMessage()}
                    confirmText={pending.action === "add" ? "Link" : "Remove link"}
                    danger={pending.action === "remove"}
                    onConfirm={() => commit(pending.action, pending.target)}
                    onCancel={() => setPending(null)}
                />
            )}
        </div>
    );
}

// "1 file", "3 files"
function count(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// "3 files and 1 folder"
function usageText({ files, folders }: TagUsage): string {
    const n = (count: number, word: string) =>
        `${count} ${word}${count === 1 ? "" : "s"}`;
    if (folders === 0) return n(files, "file");
    return `${n(files, "file")} and ${n(folders, "folder")}`;
}

// ─── TagManagerView ───────────────────────────────────────────────────────────

export default function TagManagerView({
    active,
    setView,
}: {
    active: boolean;
    setView: (view: View) => void;
}): JSX.Element {
    const { allTags, allCategories, tagMap, refreshTags, updateTag, updateCategory, reorderTags } =
        useTags();
    const { openLobby } = usePass();
    const [tab, setTab] = useState<"tags" | "coverage">("tags");
    const coverage = useTagCoverage(active);
    // The tag a dragged tag would be dropped in front of.
    const [dropBeforeId, setDropBeforeId] = useState<number | null>(null);
    const [focus, setFocus] = useState<FocusTarget>(null);
    const [collapsedCategories, setCollapsedCategories] = useState<Set<number>>(
        new Set(),
    );
    const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(false);
    const [isQuickAdding, setIsQuickAdding] = useState(false);
    const [draggedTag, setDraggedTag] = useState<DbTag | null>(null);
    const [draggedCategory, setDraggedCategory] =
        useState<DbTagCategory | null>(null);

    useEffect(() => {
        refreshTags();
    }, []);

    useEffect(() => {
        setCollapsedCategories((prev) => {
            if (prev.size > 0) return prev; // don’t overwrite user interaction
            return new Set(allCategories.map((c) => c.id));
        });
    }, [allCategories]);

    useEffect(() => {
        if (focus === null || focus.kind !== "category") {
            setIsQuickAdding(false);
        }
    }, [focus]);

    const toggleCollapsed = (id: number) => {
        setCollapsedCategories((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
        console.log(collapsedCategories);
    };

    const handleCategoryReorder = (
        dragged: DbTagCategory,
        target: DbTagCategory,
    ) => {
        const reordered = [...allCategories];
        const draggedIndex = reordered.findIndex((c) => c.id === dragged.id);
        const targetIndex = reordered.findIndex((c) => c.id === target.id);

        reordered.splice(draggedIndex, 1);
        reordered.splice(targetIndex, 0, dragged);

        reordered.forEach((cat, index) => {
            updateCategory(cat.id, { order_index: index });
        });

        refreshTags();
    };

    const toggleQuickAdd = () => {
        if (isQuickAdding) {
            setIsQuickAdding(false);
        } else {
            setIsQuickAdding(true);
        }
    };

    const tagsByCategory = allCategories.map((cat) => ({
        category: cat,
        tags: allTags.filter((t) => t.category_id === cat.id).sort(byTagOrder),
    }));
    const uncategorized = allTags
        .filter((t) => t.category_id === null)
        .sort(byTagOrder);

    // Drag a tag onto another to put it in front of that one (in that
    // tag's category).
    const tagDropProps = (target: DbTag, list: DbTag[]) => ({
        onDragOver: (e: React.DragEvent) => {
            if (!draggedTag) return;
            e.preventDefault();
            e.stopPropagation();
            if (dropBeforeId !== target.id) setDropBeforeId(target.id);
        },
        onDragLeave: () => setDropBeforeId(null),
        onDrop: (e: React.DragEvent) => {
            if (!draggedTag) return;
            e.preventDefault();
            e.stopPropagation();
            setDropBeforeId(null);
            if (draggedTag.id !== target.id) {
                const ids = list.filter((t) => t.id !== draggedTag.id).map((t) => t.id);
                ids.splice(ids.indexOf(target.id), 0, draggedTag.id);
                reorderTags(target.category_id, ids);
            }
            setDraggedTag(null);
        },
    });
    const dropLine = (tag: DbTag) =>
        dropBeforeId === tag.id ? "shadow-[inset_0_2px_0_0_#a3a3a3]" : "";

    const handleDone = () => setFocus(null);

    // From the Coverage tab: open a tag in the editor, its category opened
    // in the list so it shows there too.
    const editTag = (tagId: number) => {
        const t = tagMap.get(tagId);
        if (!t) return;
        setTab("tags");
        setFocus({ kind: "tag", item: t });
        if (t.category_id == null) {
            setUncategorizedCollapsed(false);
        } else {
            const catId = t.category_id;
            setCollapsedCategories((prev) => {
                const next = new Set(prev);
                next.delete(catId);
                return next;
            });
        }
    };

    // From the Coverage tab: sweep for this tag (random off, or it'd be
    // rerolled away).
    // Coverage's "Pass with this tag": the pass lobby, with it added.
    const passTag = (tagId: number) => {
        setView("pass");
        openLobby([tagId]);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
    };

    const handleDrop = (
        e: React.DragEvent<HTMLDivElement>,
        categoryId: number | null,
    ) => {
        if (!draggedTag) return;
        if (draggedTag.category_id === categoryId) {
            // Onto its own category: to the end.
            const ids = allTags
                .filter((t) => t.category_id === categoryId && t.id !== draggedTag.id)
                .sort(byTagOrder)
                .map((t) => t.id);
            reorderTags(categoryId, [...ids, draggedTag.id]);
        } else {
            updateTag(draggedTag.id, draggedTag.name, categoryId);
        }
        setDraggedTag(null);
        setDropBeforeId(null);
    };

    return (
        <div className="flex flex-1 flex-col overflow-hidden w-full">
            <div className="flex items-center gap-1 border-b border-neutral-800 px-4 py-2 flex-shrink-0">
                {(["tags", "coverage"] as const).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                            tab === t
                                ? "bg-neutral-800 text-neutral-100"
                                : "text-neutral-500 hover:text-neutral-300"
                        }`}
                    >
                        {t === "tags" ? "Tags" : "Coverage"}
                    </button>
                ))}
            </div>

            {tab === "coverage" && (
                <TagCoverageView
                    coverage={coverage}
                    onEditTag={editTag}
                    onPassTag={passTag}
                    active={active}
                    setView={setView}
                />
            )}

            <div
                className={tab === "tags" ? "flex flex-1 overflow-hidden" : "hidden"}
                onClick={() => setFocus(null)}
            >
                {/* Sidebar */}
                <div
                    className="w-64 flex-shrink-0 border-r border-neutral-800 overflow-y-auto flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="p-2 flex items-center justify-between">
                        <button
                            onClick={() => setFocus({ kind: "newCategory" })}
                            className="text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                        >
                            + Category
                        </button>
                        <button
                            onClick={() => setFocus({ kind: "newTag" })}
                            className="text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                        >
                            + Tag
                        </button>
                    </div>

                    <div className="p-2 flex flex-col gap-0.5">
                        {tagsByCategory.map(({ category, tags: catTags }) => {
                            const isCollapsed = collapsedCategories.has(
                                category.id,
                            );
                            const isSelected =
                                focus?.kind === "category" &&
                                focus.item.id === category.id;
                            return (
                                <React.Fragment key={category.id}>
                                    <div
                                        onDragOver={handleDragOver}
                                        onDrop={(e) =>
                                            handleDrop(e, category.id)
                                        }
                                    >
                                        <button
                                            draggable
                                            onDragStart={() =>
                                                setDraggedCategory(category)
                                            }
                                            onDragOver={(e) => {
                                                if (draggedCategory) {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }
                                            }}
                                            onDrop={(e) => {
                                                if (draggedCategory) {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    if (
                                                        draggedCategory.id !==
                                                        category.id
                                                    ) {
                                                        // Reorder logic here
                                                        handleCategoryReorder(
                                                            draggedCategory,
                                                            category,
                                                        );
                                                    }
                                                }
                                            }}
                                            onClick={() => {
                                                // Single click selects; clicking selected category toggles collapse
                                                if (isSelected) {
                                                    toggleCollapsed(
                                                        category.id,
                                                    );
                                                } else {
                                                    setFocus({
                                                        kind: "category",
                                                        item: category,
                                                    });
                                                }
                                            }}
                                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors text-left w-full ${
                                                isSelected
                                                    ? "bg-neutral-700 text-neutral-100"
                                                    : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                                            }`}
                                        >
                                            <span className="text-[10px] text-neutral-600 w-3 flex-shrink-0">
                                                {isCollapsed ? "▸" : "▾"}
                                            </span>
                                            <span
                                                className="text-[10px] leading-none flex-shrink-0"
                                                style={{
                                                    color:
                                                        category.color ??
                                                        "#888",
                                                }}
                                            >
                                                {category.icon ?? "●"}
                                            </span>
                                            {category.name}
                                        </button>

                                        {!isCollapsed &&
                                            catTags.map((tag) => (
                                                <button
                                                    key={tag.id}
                                                    draggable={!isQuickAdding}
                                                    onDragStart={(e) => {
                                                        setDraggedTag(tag);
                                                        e.dataTransfer.setData(TAG_DRAG_TYPE, String(tag.id));
                                                    }}
                                                    onDragEnd={() => {
                                                        setDraggedTag(null);
                                                        setDropBeforeId(null);
                                                    }}
                                                    {...tagDropProps(tag, catTags)}
                                                    onClick={() => {
                                                        if (
                                                            focus &&
                                                            focus.kind ===
                                                                "category" &&
                                                            focus.item &&
                                                            isQuickAdding
                                                        ) {
                                                            updateTag(
                                                                tag.id,
                                                                tag.name,
                                                                focus.item
                                                                    .id ===
                                                                    tag.category_id
                                                                    ? null
                                                                    : focus.item
                                                                          .id,
                                                            );
                                                        } else {
                                                            setFocus({
                                                                kind: "tag",
                                                                item: tag,
                                                            });
                                                        }
                                                    }}
                                                    className={`flex items-center gap-2 pl-10 pr-2 py-0.5 rounded-md text-xs transition-colors text-left w-full ${dropLine(tag)} ${
                                                        focus?.kind === "tag" &&
                                                        focus.item.id === tag.id
                                                            ? "bg-neutral-700 text-neutral-100"
                                                            : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                                                    }`}
                                                >
                                                    <span
                                                        className="text-[10px] leading-none flex-shrink-0"
                                                        style={{
                                                            color:
                                                                category.color ??
                                                                "#888",
                                                        }}
                                                    >
                                                        {category.icon ?? "●"}
                                                    </span>
                                                    {tag.name}
                                                </button>
                                            ))}
                                    </div>
                                </React.Fragment>
                            );
                        })}

                        {
                            <div
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, null)}
                            >
                                <div className="h-px bg-neutral-800 my-1" />
                                <button
                                    onClick={() =>
                                        setUncategorizedCollapsed((v) => !v)
                                    }
                                    className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wider text-neutral-600 hover:text-neutral-400 transition-colors text-left w-full"
                                >
                                    <span className="text-[10px] w-3 flex-shrink-0">
                                        {uncategorizedCollapsed ? "▸" : "▾"}
                                    </span>
                                    Uncategorized
                                </button>

                                {!uncategorizedCollapsed &&
                                    uncategorized.map((tag) => (
                                        <button
                                            draggable={!isQuickAdding}
                                            onDragStart={(e) => {
                                                setDraggedTag(tag);
                                                e.dataTransfer.setData(TAG_DRAG_TYPE, String(tag.id));
                                            }}
                                            onDragEnd={() => {
                                                setDraggedTag(null);
                                                setDropBeforeId(null);
                                            }}
                                            {...tagDropProps(tag, uncategorized)}
                                            key={tag.id}
                                            onClick={() => {
                                                if (
                                                    focus &&
                                                    focus.kind === "category" &&
                                                    focus.item &&
                                                    isQuickAdding
                                                ) {
                                                    updateTag(
                                                        tag.id,
                                                        tag.name,
                                                        focus.item.id,
                                                    );
                                                } else {
                                                    setFocus({
                                                        kind: "tag",
                                                        item: tag,
                                                    });
                                                }
                                            }}
                                            className={`flex items-center gap-2 pl-6 pr-2 py-0.5 rounded-md text-xs transition-colors text-left w-full ${dropLine(tag)} ${
                                                focus?.kind === "tag" &&
                                                focus.item.id === tag.id
                                                    ? "bg-neutral-700 text-neutral-100"
                                                    : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                                            }`}
                                        >
                                            <span className="w-1.5 h-1.5 rounded-full bg-neutral-700 flex-shrink-0" />
                                            {tag.name}
                                        </button>
                                    ))}
                            </div>
                        }
                    </div>
                </div>

                {/* Detail panel */}
                <div
                    className="flex flex-col flex-1 overflow-y-auto"
                    onClick={(e) => e.stopPropagation()}
                >
                    {focus === null && (
                        <div className="flex flex-col items-center justify-center h-full gap-2 text-neutral-600">
                            <TagIcon className="w-10 h-10" />
                            <span className="text-sm">
                                Select a tag or category to edit
                            </span>
                        </div>
                    )}
                    {focus?.kind === "newCategory" && (
                        <CategoryEditor category={null} onDone={handleDone} />
                    )}
                    {focus?.kind === "newTag" && (
                        <NewTagEditor onDone={handleDone} />
                    )}
                    {focus?.kind === "category" && (
                        <CategoryEditor
                            key={focus.item.id}
                            category={focus.item}
                            onDone={handleDone}
                            onToggleQuickAdd={toggleQuickAdd}
                            isQuickAdding={isQuickAdding}
                        />
                    )}
                    {focus?.kind === "tag" && (
                        <TagEditor
                            key={focus.item.id}
                            tag={focus.item}
                            onDone={handleDone}
                            coverage={coverage}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}