import { useTags } from "@renderer/contexts/TagsContext";
import { DbTag, DbTagCategory, DbTagWithCategory } from "@renderer/shared/types/types";
import React, { useState } from "react";
import { TagIcon } from "./icons/TagIcon";

type FocusTarget =
    | { kind: "tag"; item: DbTagWithCategory }
    | { kind: "category"; item: DbTagCategory }
    | { kind: "newCategory" }
    | { kind: "newTag" }
    | null;

const PRESET_COLORS = [
    "#7F77DD", "#1D9E75", "#D85A30", "#378ADD",
    "#D4537E", "#BA7517", "#639922", "#E24B4A",
];

const PRESET_ICONS = ["●", "▲", "■", "◆", "★"];

// ─── CategoryEditor ───────────────────────────────────────────────────────────

function CategoryEditor({
    category,
    onDone,
}: {
    category: DbTagCategory | null;
    onDone: () => void;
}) {
    const [name, setName] = useState(category?.name ?? "");
    const [color, setColor] = useState(category?.color ?? PRESET_COLORS[0]);
    const [icon, setIcon] = useState(category?.icon ?? PRESET_ICONS[0]);
    const [customIcon, setCustomIcon] = useState("");

    const { createCategory, updateCategory, deleteCategory } = useTags();

    const handleCustomIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        // Take the last typed character so the field always shows 1 char
        const char = val.slice(-1);
        if (char) {
            setIcon(char);
            setCustomIcon(char);
        }
    };

    const handleSave = async () => {
        if (category) {
            const updates: Partial<Pick<DbTagCategory, "name" | "color" | "icon">> = {};
            if (name !== category.name) updates.name = name;
            if (color !== category.color) updates.color = color;
            if (icon !== category.icon) updates.icon = icon;
            if (Object.keys(updates).length > 0) {
                await updateCategory(category.id, updates);
            }
        } else {
            await createCategory(name, color, icon);
        }
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

            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Category name
                </label>
                <input
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Color
                </label>
                <div className="flex gap-2 flex-wrap">
                    {PRESET_COLORS.map((c) => (
                        <button
                            key={c}
                            onClick={() => setColor(c)}
                            className="w-6 h-6 rounded-full transition-transform hover:scale-110 focus:outline-none"
                            style={{
                                background: c,
                                boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 3px ${c}` : "none",
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
                            onClick={() => { setIcon(ic); setCustomIcon(""); }}
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

            <div className="flex gap-2">
                <button
                    onClick={onDone}
                    className="px-3 py-1.5 text-xs text-neutral-400 border border-neutral-700 rounded-md hover:bg-neutral-800 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSave}
                    className="px-3 py-1.5 text-xs bg-neutral-200 text-neutral-900 rounded-md hover:bg-white transition-colors"
                >
                    {category ? "Save changes" : "Create category"}
                </button>
                {category && (
                    <button
                        onClick={handleDelete}
                        className="ml-auto px-3 py-1.5 text-xs text-red-400 border border-red-900/50 rounded-md hover:bg-red-950/30 transition-colors"
                    >
                        Delete category
                    </button>
                )}
            </div>
        </div>
    );
}

// ─── NewTagEditor ─────────────────────────────────────────────────────────────

function NewTagEditor({ onDone }: { onDone: () => void }) {
    const [name, setName] = useState("");
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const { allCategories, createTag } = useTags();

    const handleSave = async () => {
        if (!name.trim()) return;
        await createTag(name.trim(), categoryId);
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
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSave()}
                    placeholder="Tag name"
                />
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Category <span className="normal-case text-neutral-600">(optional)</span>
                </label>
                <select
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={categoryId ?? ""}
                    onChange={(e) =>
                        setCategoryId(e.target.value === "" ? null : Number(e.target.value))
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
                    disabled={!name.trim()}
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
}: {
    tag: DbTagWithCategory;
    onDone: () => void;
}) {
    const [name, setName] = useState(tag.name);
    const [categoryId, setCategoryId] = useState<number | null>(tag.category_id);
    const { allCategories, updateTag, deleteTag } = useTags();

    const handleSave = async () => {
        await updateTag(tag.id, name, categoryId);
        onDone();
    };

    const handleDelete = async () => {
        await deleteTag(tag.id);
        onDone();
    };

    return (
        <div className="p-5 flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Tag name
                </label>
                <input
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                    Category
                </label>
                <select
                    className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    value={categoryId ?? ""}
                    onChange={(e) =>
                        setCategoryId(e.target.value === "" ? null : Number(e.target.value))
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
                    className="px-3 py-1.5 text-xs bg-neutral-200 text-neutral-900 rounded-md hover:bg-white transition-colors"
                >
                    Save changes
                </button>
                <button
                    onClick={handleDelete}
                    className="ml-auto px-3 py-1.5 text-xs text-red-400 border border-red-900/50 rounded-md hover:bg-red-950/30 transition-colors"
                >
                    Delete tag
                </button>
            </div>
        </div>
    );
}

// ─── TagManagerView ───────────────────────────────────────────────────────────

export default function TagManagerView(): JSX.Element {
    const { allTags, allCategories, refreshTags } = useTags();
    const [focus, setFocus] = useState<FocusTarget>(null);
    const [collapsedCategories, setCollapsedCategories] = useState<Set<number>>(new Set());
    const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(false);

    React.useEffect(() => {
        refreshTags();
    }, []);

    const toggleCollapsed = (id: number) => {
        setCollapsedCategories((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const tagsByCategory = allCategories.map((cat) => ({
        category: cat,
        tags: allTags.filter((t) => t.category_id === cat.id),
    }));
    const uncategorized = allTags.filter((t) => t.category_id === null);

    const handleDone = () => setFocus(null);

    return (
        <div className="flex flex-1 flex-col overflow-hidden w-full min-h-full">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3 flex-shrink-0">
                <h2 className="text-sm font-medium text-neutral-300">Tag Manager</h2>
            </div>

            <div className="flex flex-1 overflow-hidden" onClick={() => setFocus(null)}>
                {/* Sidebar */}
                <div
                    className="w-48 flex-shrink-0 border-r border-neutral-800 overflow-y-auto flex flex-col"
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
                            const isCollapsed = collapsedCategories.has(category.id);
                            const isSelected = focus?.kind === "category" && focus.item.id === category.id;
                            return (
                                <React.Fragment key={category.id}>
                                    <button
                                        onClick={() => {
                                            // Single click selects; clicking selected category toggles collapse
                                            if (isSelected) {
                                                toggleCollapsed(category.id);
                                            } else {
                                                setFocus({ kind: "category", item: category });
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
                                            style={{ color: category.color ?? "#888" }}
                                        >
                                            {category.icon ?? "●"}
                                        </span>
                                        {category.name}
                                    </button>

                                    {!isCollapsed && catTags.map((tag) => (
                                        <button
                                            key={tag.id}
                                            onClick={() => setFocus({ kind: "tag", item: tag })}
                                            className={`flex items-center gap-2 pl-6 pr-2 py-0.5 rounded-md text-xs transition-colors text-left w-full ${
                                                focus?.kind === "tag" && focus.item.id === tag.id
                                                    ? "bg-neutral-700 text-neutral-100"
                                                    : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                                            }`}
                                        >
                                            <span
                                                className="text-[10px] leading-none flex-shrink-0"
                                                style={{ color: category.color ?? "#888" }}
                                            >
                                                {category.icon ?? "●"}
                                            </span>
                                            {tag.name}
                                        </button>
                                    ))}
                                </React.Fragment>
                            );
                        })}

                        {uncategorized.length > 0 && (
                            <>
                                <div className="h-px bg-neutral-800 my-1" />
                                <button
                                    onClick={() => setUncategorizedCollapsed((v) => !v)}
                                    className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wider text-neutral-600 hover:text-neutral-400 transition-colors text-left w-full"
                                >
                                    <span className="text-[10px] w-3 flex-shrink-0">
                                        {uncategorizedCollapsed ? "▸" : "▾"}
                                    </span>
                                    Uncategorized
                                </button>

                                {!uncategorizedCollapsed && uncategorized.map((tag) => (
                                    <button
                                        key={tag.id}
                                        onClick={() => setFocus({ kind: "tag", item: tag })}
                                        className={`flex items-center gap-2 pl-6 pr-2 py-0.5 rounded-md text-xs transition-colors text-left w-full ${
                                            focus?.kind === "tag" && focus.item.id === tag.id
                                                ? "bg-neutral-700 text-neutral-100"
                                                : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                                        }`}
                                    >
                                        <span className="w-1.5 h-1.5 rounded-full bg-neutral-700 flex-shrink-0" />
                                        {tag.name}
                                    </button>
                                ))}
                            </>
                        )}
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
                            <span className="text-sm">Select a tag or category to edit</span>
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
                        />
                    )}
                    {focus?.kind === "tag" && (
                        <TagEditor
                            key={focus.item.id}
                            tag={focus.item}
                            onDone={handleDone}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}