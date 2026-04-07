import { useEffect, useRef, useState } from "react";
import type { FolderNode } from "../types";
import NavItem from "./NavItem";
import { useSettings } from "../contexts/SettingsContext";
import { useStatus } from "../contexts/StatusContext";

type View = "browse" | "compare" | "file";

// Collect all relativePaths from a tree
function getAllPaths(nodes: FolderNode[]): string[] {
    const paths: string[] = [];
    function walk(ns: FolderNode[]) {
        for (const n of ns) {
            paths.push(n.relativePath);
            walk(n.children);
        }
    }
    walk(nodes);
    return paths;
}

// Returns a filtered copy of the tree, keeping nodes whose name matches,
// plus any ancestors needed to show them in context.
function filterTree(nodes: FolderNode[], query: string): FolderNode[] {
    const q = query.toLowerCase();
    return nodes.reduce<FolderNode[]>((acc, node) => {
        const filteredChildren = filterTree(node.children, q);
        const selfMatches = node.name.toLowerCase().includes(q);
        if (selfMatches || filteredChildren.length > 0) {
            acc.push({ ...node, children: filteredChildren });
        }
        return acc;
    }, []);
}

function FolderTreeNode({
    node,
    activeFolder,
    depth,
    mode,
    checkedFolders,
    onSelectFolder,
    onToggleFolder,
    forceExpanded,
}: {
    node: FolderNode;
    activeFolder: string | null;
    depth: number;
    mode: "browse" | "compare";
    checkedFolders: Set<string>;
    onSelectFolder: (relativePath: string) => void;
    onToggleFolder: (relativePath: string, allPaths: string[]) => void;
    forceExpanded?: boolean;
}): JSX.Element {
    const [expanded, setExpanded] = useState(depth === 0);
    const hasChildren = node.children.length > 0;
    const isActive = activeFolder === node.relativePath;
    const allDescendantPaths = [
        node.relativePath,
        ...getAllPaths(node.children),
    ];

    const checkedCount = allDescendantPaths.filter((p) =>
        checkedFolders.has(p),
    ).length;
    const isChecked = checkedCount === allDescendantPaths.length;
    const isIndeterminate =
        checkedCount > 0 && checkedCount < allDescendantPaths.length;

    const isExpanded = forceExpanded ?? expanded;

    return (
        <div>
            <div
                className="flex items-center group"
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
                {/* Chevron */}
                <button
                    className="mr-1 w-4 shrink-0 text-neutral-600 hover:text-neutral-400 transition-colors text-xs"
                    onClick={() => hasChildren && setExpanded((e) => !e)}
                >
                    {hasChildren ? (isExpanded ? "▾" : "▸") : ""}
                </button>

                {/* Checkbox — only in compare mode */}
                {mode === "compare" && (
                    <input
                        type="checkbox"
                        checked={isChecked}
                        ref={(el) => {
                            if (el) el.indeterminate = isIndeterminate;
                        }}
                        onChange={() =>
                            onToggleFolder(
                                node.relativePath,
                                allDescendantPaths,
                            )
                        }
                        className="mr-2 shrink-0 accent-white cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                    />
                )}

                {/* Folder name */}
                <button
                    onClick={() =>
                        mode === "browse" && onSelectFolder(node.relativePath)
                    }
                    className={`flex-1 truncate rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
                        mode === "browse"
                            ? isActive
                                ? "text-white font-medium"
                                : "text-neutral-400 hover:text-white"
                            : isChecked
                              ? "text-white"
                              : isIndeterminate
                                ? "text-neutral-300"
                                : "text-neutral-300"
                    }`}
                >
                    {node.name}
                </button>
            </div>

            {hasChildren && isExpanded && (
                <div>
                    {node.children.map((child) => (
                        <FolderTreeNode
                            key={child.relativePath}
                            node={child}
                            activeFolder={activeFolder}
                            depth={depth + 1}
                            mode={mode}
                            checkedFolders={checkedFolders}
                            onSelectFolder={onSelectFolder}
                            onToggleFolder={onToggleFolder}
                            forceExpanded={forceExpanded}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function TagFilterSection({
    allTags,
    activeTags,
    tagMode,
    onToggleTag,
    onSetTagMode,
}: {
    allTags: string[];
    activeTags: Set<string>;
    tagMode: "and" | "or";
    onToggleTag: (tag: string) => void;
    onSetTagMode: (mode: "and" | "or") => void;
}): JSX.Element {
    const [search, setSearch] = useState("");
    const [focused, setFocused] = useState(false);

    const suggestions = search.trim()
        ? allTags.filter((t) => t.toLowerCase().includes(search.toLowerCase()))
        : [];

    return (
        <div className="px-3 mb-3 mt-1">
            <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs pl-3 font-semibold uppercase tracking-widest text-neutral-500">
                    Tags
                </p>
                {activeTags.size >= 2 && (
                    <button
                        onClick={() =>
                            onSetTagMode(tagMode === "and" ? "or" : "and")
                        }
                        className="text-[10px] rounded px-1.5 py-0.5 bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        {tagMode.toUpperCase()}
                    </button>
                )}
            </div>

            {/* Active tag chips */}
            {activeTags.size > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                    {[...activeTags].map((tag) => (
                        <button
                            key={tag}
                            onClick={() => onToggleTag(tag)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-900 text-xs"
                        >
                            {tag}
                            <span className="opacity-50 hover:opacity-100">
                                ×
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {/* Search input + dropdown */}
            <div className="relative">
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 150)}
                    placeholder="Filter by tag…"
                    className="w-full rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:ring-1 focus:ring-neutral-600 transition-colors"
                />
                {focused && suggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden z-10 shadow-lg max-h-40 overflow-y-auto">
                        {suggestions.slice(0, 20).map((tag) => (
                            <button
                                key={tag}
                                onMouseDown={() => {
                                    onToggleTag(tag);
                                    setSearch("");
                                }}
                                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                    activeTags.has(tag)
                                        ? "text-white bg-neutral-700"
                                        : "text-neutral-300 hover:bg-neutral-800"
                                }`}
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function SettingsSection(): JSX.Element {
    const {
        hoverPreviewEnabled,
        toggleHoverPreview,
        volume,
        handleVolumeChange,
    } = useSettings();
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close when clicking outside
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    return (
        <div ref={containerRef} className="relative">
            <button
                onClick={() => setOpen((p) => !p)}
                className="flex items-center justify-between w-full mb-1 px-2 group"
            >
                <p className="w-full rounded-md px-1 py-2 text-left text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
                   ⚙ Settings
                </p>
            </button>

            {open && (
                <div className="absolute bottom-full left-0 mb-2 w-56 rounded-lg border border-neutral-700 bg-neutral-900 shadow-lg p-3 z-50">
                    <div className="flex items-center justify-between py-2 border-b border-neutral-800">
                        <p className="text-xs text-neutral-500">Toggle Hover Preview (Z)</p>
                        <button
                            onClick={toggleHoverPreview}
                            className={`text-[10px] rounded px-2 py-0.5 transition-colors font-medium ${
                                hoverPreviewEnabled
                                    ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                            }`}
                        >
                            {hoverPreviewEnabled ? "on" : "off"}
                        </button>
                    </div>

                    <div className="flex items-center justify-between py-2">
                        <p className="text-xs text-neutral-500">Volume</p>
                        <div className="flex items-center gap-2">
                            <div
                                className="relative w-24 h-1 bg-neutral-700 rounded cursor-pointer"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    const el = e.currentTarget;
                                    const calc = (clientX: number) => {
                                        const rect = el.getBoundingClientRect();
                                        const pct = Math.min(
                                            100,
                                            Math.max(
                                                0,
                                                Math.round(
                                                    ((clientX - rect.left) /
                                                        rect.width) *
                                                        100,
                                                ),
                                            ),
                                        );
                                        handleVolumeChange(pct);
                                    };
                                    calc(e.clientX);
                                    const onMove = (e: MouseEvent) => calc(e.clientX);
                                    const onUp = () => {
                                        document.removeEventListener("mousemove", onMove);
                                        document.removeEventListener("mouseup", onUp);
                                    };
                                    document.addEventListener("mousemove", onMove);
                                    document.addEventListener("mouseup", onUp);
                                }}
                            >
                                <div
                                    className="absolute inset-y-0 left-0 bg-neutral-300 rounded"
                                    style={{ width: `${volume}%` }}
                                />
                            </div>
                            <span className="text-xs text-neutral-500 w-7 text-right tabular-nums">
                                {volume}
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function Sidebar({
    view,
    setView,
    subfolders,
    activeFolder,
    checkedFolders,
    onSelectFolder,
    onToggleFolder,
    onCheckAll,
    onChangeLibrary,
    onRescanLibrary,
    allTags,
    activeTags,
    tagMode,
    onToggleTag,
    onSetTagMode,
}: {
    view: View;
    setView: (v: View) => void;
    subfolders: FolderNode[];
    activeFolder: string | null;
    checkedFolders: Set<string>;
    onSelectFolder: (folder: string | null) => void;
    onToggleFolder: (relativePath: string, allPaths: string[]) => void;
    onCheckAll: () => void;
    onChangeLibrary: () => void;
    onRescanLibrary: () => void;
    allTags: string[];
    activeTags: Set<string>;
    tagMode: "and" | "or";
    onToggleTag: (tag: string) => void;
    onSetTagMode: (mode: "and" | "or") => void;
}): JSX.Element {
    const [search, setSearch] = useState("");

    const isFilterable = view === "compare";
    const isSearching = search.trim().length > 0;
    const visibleFolders = isSearching
        ? filterTree(subfolders, search.trim())
        : subfolders;

    const allPaths = getAllPaths(subfolders);
    const allChecked = allPaths.every((p) => checkedFolders.has(p));
    const someChecked = allPaths.some((p) => checkedFolders.has(p));
    const isIndeterminate = someChecked && !allChecked;

    const { status } = useStatus();

    return (
        <aside className="flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900  h-full">
            

            <div className="flex flex-col gap-1 p-3 shrink-0">
                <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                    Views
                </p>
                <NavItem
                    label="Browse"
                    active={view === "browse"}
                    onClick={() => setView("browse")}
                />
                <NavItem
                    label="Compare"
                    active={view === "compare"}
                    onClick={() => setView("compare")}
                />
            </div>
            
            

            {subfolders.length > 0 && (
                <div className="flex flex-col flex-1 pb-3 min-h-0">
                    <div className="flex items-center justify-between px-3 mb-1">
                        <p className="text-xs pl-3 font-semibold uppercase tracking-widest text-neutral-500">
                            Folders
                        </p>
                        {isFilterable && (
                            <button
                                onClick={onCheckAll}
                                className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                            >
                                {allChecked ? "None" : "All"}
                            </button>
                        )}
                    </div>

                    {/* Search bar */}
                    <div className="px-3 mb-2 flex items-center gap-1.5">
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search folders…"
                            className="flex-1 min-w-0 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:ring-1 focus:ring-neutral-600 transition-colors"
                        />
                        {search && (
                            <button
                                onClick={() => setSearch("")}
                                className="flex-shrink-0 flex items-center justify-center w-4 h-4 rounded-full bg-neutral-600 text-neutral-300 hover:bg-neutral-500 transition-colors text-xs leading-none"
                            >
                                ✕
                            </button>
                        )}
                    </div>

                    {/* "All" entry — hidden while searching */}
                    {!isSearching && (
                        <div className="flex items-center px-2">
                            <span className="mr-1 w-4" />
                            {isFilterable && (
                                <input
                                    type="checkbox"
                                    checked={allChecked}
                                    ref={(el) => {
                                        if (el)
                                            el.indeterminate = isIndeterminate;
                                    }}
                                    onChange={onCheckAll}
                                    className="mr-2 shrink-0 accent-white cursor-pointer"
                                />
                            )}
                            <button
                                onClick={() =>
                                    !isFilterable && onSelectFolder(null)
                                }
                                className={`flex-1 truncate rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
                                    !isFilterable && activeFolder === null
                                        ? "text-white font-medium"
                                        : isFilterable && allChecked
                                          ? "text-white"
                                          : isFilterable && someChecked
                                            ? "text-neutral-300"
                                            : "text-neutral-400 hover:text-white"
                                }`}
                            >
                                All
                            </button>
                        </div>
                    )}
                    <div className="overflow-y-auto flex-1 min-h-0">
                        {visibleFolders.length > 0 ? (
                            visibleFolders.map((node) => (
                                <FolderTreeNode
                                    key={node.relativePath}
                                    node={node}
                                    activeFolder={activeFolder}
                                    depth={0}
                                    mode={isFilterable ? "compare" : "browse"}
                                    checkedFolders={checkedFolders}
                                    onSelectFolder={(path) =>
                                        onSelectFolder(path)
                                    }
                                    onToggleFolder={onToggleFolder}
                                    forceExpanded={
                                        isSearching ? true : undefined
                                    }
                                />
                            ))
                        ) : (
                            <p className="px-5 py-2 text-xs text-neutral-600">
                                No folders match
                            </p>
                        )}
                    </div>
                </div>
            )}
            {/* Tags filter */}
            {allTags.length > 0 && (
                <TagFilterSection
                    allTags={allTags}
                    activeTags={activeTags}
                    tagMode={tagMode}
                    onToggleTag={onToggleTag}
                    onSetTagMode={onSetTagMode}
                />
            )}

            <div className="shrink-0 p-3 border-t border-neutral-800">

                <div className="flex gap-1 p-3 pb-0 shrink-0">
                <p className="w-full rounded-md px-3 py-2 text-left text-xs text-neutral-500 ">Status: {status}</p>
            </div>
                <button
                    onClick={onRescanLibrary}
                    className="w-full rounded-md px-3 py-2 text-left text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                    ↻ Rescan Library
                </button>
                <button
                    onClick={onChangeLibrary}
                    className="w-full rounded-md px-3 py-2 text-left text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                    ⌂ Change library
                </button>
                <SettingsSection />
            </div>
        </aside>
    );
}
