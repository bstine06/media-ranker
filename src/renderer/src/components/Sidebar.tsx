import { useEffect, useRef, useState } from "react";
import type { DbFile, DbTag, FolderNode, View } from "../shared/types/types";
import NavItem from "./NavItem";
import {
    useSettings,
    PLACEMENT_MIN,
    PLACEMENT_MAX,
} from "../contexts/SettingsContext";
import { usePlacement } from "@renderer/contexts/PlacementContext";
import { useStatus } from "../contexts/StatusContext";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { FolderIcon } from "./icons/FolderIcon";
import { useFolders, type Lane } from "@renderer/contexts/FolderContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { CompareIcon } from "./icons/CompareIcon";
import { ScrollIcon } from "./icons/ScrollIcon";
import { TagIcon } from "./icons/TagIcon";
import {
    UNTAGGED,
    missingCategory,
    filterLabel,
    isSpecialFilter,
} from "@renderer/lib/tagFilters";

// Makes an element a drop target for files dragged from Browse / the media
// player / Finder. dragenter/leave also fire for child elements, so track
// depth rather than a boolean.
function useFileDropTarget(onDropFiles: (absPaths: string[]) => void) {
    const [dragDepth, setDragDepth] = useState(0);
    const hasFiles = (e: React.DragEvent) =>
        Array.from(e.dataTransfer.types).includes("Files");
    return {
        isDropTarget: dragDepth > 0,
        dropHandlers: {
            onDragEnter: (e: React.DragEvent) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                setDragDepth((d) => d + 1);
            },
            onDragOver: (e: React.DragEvent) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
            },
            onDragLeave: () => setDragDepth((d) => Math.max(0, d - 1)),
            onDrop: (e: React.DragEvent) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setDragDepth(0);
                const paths = Array.from(e.dataTransfer.files)
                    .map((f) => window.api.getPathForFile(f))
                    .filter(Boolean);
                if (paths.length > 0) onDropFiles(paths);
            },
        },
    };
}

function FolderItem({
    node,
    activeFolder,
    isFilterable,
    checkedFolders,
    onSelectFolder,
    onToggleFolder,
    folderMetaVersion,
    onDropFiles,
    lanes,
}: {
    node: FolderNode;
    activeFolder: string | null;
    isFilterable: boolean;
    /** Compare: a left and a right checkbox instead of the single filter one. */
    lanes?: { checked: Record<Lane, boolean>; onToggle: (lane: Lane) => void };
    checkedFolders: Set<string>;
    onSelectFolder: (relativePath: string) => void;
    onToggleFolder: (relativePath: string, allPaths: string[]) => void;
    folderMetaVersion: number;
    onDropFiles: (absPaths: string[]) => void;
}): JSX.Element {
    const isActive = activeFolder === node.relativePath;
    const isChecked = checkedFolders.has(node.relativePath);

    const { isDropTarget, dropHandlers } = useFileDropTarget(onDropFiles);

    const [profileImageHash, setProfileImageHash] = useState<string | null>();

    useEffect(() => {
    const load = async () => {
        try {
            const folder = await window.api.getFolder(node.relativePath);
            setProfileImageHash(folder?.profile_image_hash ?? null);
        } catch {
            setProfileImageHash(null);
        }
    };
    load();
}, [node, folderMetaVersion]);

    return (
        <div
            className={`flex items-center pr-4 transition-colors ${
                isDropTarget
                    ? "bg-neutral-700 ring-1 ring-inset ring-neutral-400"
                    : "hover:bg-neutral-800"
            }`}
            {...dropHandlers}
        >
            <span className="mr-1 w-4" />
            {lanes ? (
                <LaneCheckboxes
                    checked={lanes.checked}
                    onToggle={lanes.onToggle}
                />
            ) : (
                isFilterable && (
                    <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() =>
                            onToggleFolder(node.relativePath, [node.relativePath])
                        }
                        className="mr-2 shrink-0 accent-white cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                    />
                )
            )}
            <button
                onClick={() => {
                    if (lanes) {
                        // Name toggles both sides together.
                        const both = lanes.checked.a && lanes.checked.b;
                        if (lanes.checked.a === both) lanes.onToggle("a");
                        if (lanes.checked.b === both) lanes.onToggle("b");
                        return;
                    }
                    if (isFilterable)
                        onToggleFolder(node.relativePath, [node.relativePath]);
                    else onSelectFolder(node.relativePath);
                }}
                className={`flex-1 truncate rounded-md py-1 pr-2 text-left text-sm transition-colors ${
                    !isFilterable
                        ? isActive
                            ? "text-white font-medium"
                            : "text-neutral-400 hover:text-white"
                        : (lanes ? lanes.checked.a || lanes.checked.b : isChecked)
                          ? "text-white"
                          : "text-neutral-300"
                }`}
            >
                <div className="flex items-center">
                    {profileImageHash ? (
                        <ThumbnailImage
                            contentHash={profileImageHash}
                            className="w-6 h-6 rounded-full mr-2"
                        />
                    ) : (
                        <div className="bg-neutral-700 rounded-full mr-2">
                            <FolderIcon className="w-4 h-4 m-1 text-neutral-500" />
                        </div>
                    )}
                    {node.name}
                </div>
            </button>
        </div>
    );
}

// Compare's left / right folder checkboxes for one row.
function LaneCheckboxes({
    checked,
    indeterminate,
    onToggle,
}: {
    checked: Record<Lane, boolean>;
    indeterminate?: Record<Lane, boolean>;
    onToggle: (lane: Lane) => void;
}): JSX.Element {
    return (
        <span className="mr-2 flex shrink-0 items-center gap-1.5">
            {(["a", "b"] as const).map((lane) => (
                <input
                    key={lane}
                    type="checkbox"
                    title={lane === "a" ? "Left side" : "Right side"}
                    checked={checked[lane]}
                    ref={(el) => {
                        if (el) el.indeterminate = !!indeterminate?.[lane];
                    }}
                    onChange={() => onToggle(lane)}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 accent-white cursor-pointer"
                />
            ))}
        </span>
    );
}

// A row that accepts dropped files (highlights while a file is over it).
function FileDropRow({
    onDropFiles,
    children,
}: {
    onDropFiles: (absPaths: string[]) => void;
    children: React.ReactNode;
}): JSX.Element {
    const { isDropTarget, dropHandlers } = useFileDropTarget(onDropFiles);
    return (
        <div
            className={`flex items-center transition-colors ${
                isDropTarget
                    ? "bg-neutral-700 ring-1 ring-inset ring-neutral-400"
                    : ""
            }`}
            {...dropHandlers}
        >
            {children}
        </div>
    );
}

function UnsortedItem({
    active,
    count,
    onSelect,
    onDropFiles,
}: {
    active: boolean;
    count: number;
    onSelect: () => void;
    onDropFiles: (absPaths: string[]) => void;
}): JSX.Element {
    const { isDropTarget, dropHandlers } = useFileDropTarget(onDropFiles);
    return (
        <div
            className={`flex items-center pr-4 transition-colors ${
                isDropTarget
                    ? "bg-neutral-700 ring-1 ring-inset ring-neutral-400"
                    : ""
            }`}
            {...dropHandlers}
        >
            {/* Same leading spacer as the All Collections row */}
            <span className="mr-1 w-4" />
            <button
                onClick={onSelect}
                title="Files sitting directly in the library folder"
                className={`flex flex-1 items-center justify-between truncate rounded-md py-1.5 pr-2 pl-8 text-left text-sm transition-colors ${
                    active
                        ? "text-white font-medium"
                        : "text-neutral-400 hover:text-white"
                }`}
            >
                <span>Unsorted</span>
                <span className="text-xs tabular-nums text-neutral-500">
                    {count}
                </span>
            </button>
        </div>
    );
}

function TagFilterSection({
}: {
}): JSX.Element {
    const [search, setSearch] = useState("");
    const [focused, setFocused] = useState(false);
    const { allTags, allCategories, activeTags, tagMode, toggleTag, setTagMode } =
        useTags();

    const q = search.trim().toLowerCase();
    // Tags matching the search, then "no <category>" for matching categories
    // (files missing a tag from it, e.g. ones still needing a subject).
    const suggestions: { id: number; label: string; special: boolean }[] = q
        ? [
              ...allTags
                  .filter((t) => t.name.toLowerCase().includes(q))
                  .map((t) => ({ id: t.id, label: t.name, special: false })),
              ...allCategories
                  .filter((c) => c.name.toLowerCase().includes(q))
                  .map((c) => ({
                      id: missingCategory(c.id),
                      label: `no ${c.name}`,
                      special: true,
                  })),
          ]
        : [];
    const untaggedOn = activeTags.has(UNTAGGED);

    return (
        <div className="px-2 mb-3 mt-1">
            <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs px-1 font-semibold uppercase tracking-widest text-neutral-500">
                    Tags
                </p>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => toggleTag({ id: UNTAGGED })}
                        title="Only files with no tags at all (their own or their folder's)"
                        className={`text-[10px] rounded px-1.5 py-0.5 transition-colors ${
                            untaggedOn
                                ? "bg-neutral-200 text-neutral-900"
                                : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                        }`}
                    >
                        UNTAGGED
                    </button>
                    {activeTags.size >= 2 && (
                        <button
                            onClick={() =>
                                setTagMode(tagMode === "and" ? "or" : "and")
                            }
                            className="text-[10px] rounded px-1.5 py-0.5 bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                        >
                            {tagMode.toUpperCase()}
                        </button>
                    )}
                </div>
            </div>

            {activeTags.size > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                    {[...activeTags].map((tagId) => {
                        const label = filterLabel(tagId, allTags, allCategories);
                        if (!label) return null;
                        return (
                            <button
                                key={tagId}
                                onClick={() => toggleTag({ id: tagId })}
                                className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-900 text-xs ${
                                    isSpecialFilter(tagId) ? "italic" : ""
                                }`}
                            >
                                {label}
                                <span className="opacity-50 hover:opacity-100">
                                    ×
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="relative">
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 150)}
                    placeholder="Filter by tag or category…"
                    className="w-full rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:ring-1 focus:ring-neutral-600 transition-colors"
                />
                {focused && suggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden z-10 shadow-lg max-h-40 overflow-y-auto">
                        {suggestions.slice(0, 20).map((item) => (
                            <button
                                key={item.id}
                                onMouseDown={() => {
                                    toggleTag({ id: item.id });
                                    setSearch("");
                                }}
                                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                    item.special ? "italic" : ""
                                } ${
                                    activeTags.has(item.id)
                                        ? "text-white bg-neutral-700"
                                        : "text-neutral-300 hover:bg-neutral-800"
                                }`}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// Compare's own options, shown in the sidebar only while in Compare.
function CompareOptionsSection(): JSX.Element {
    const [open, setOpen] = useState(true);
    const {
        compareBothAudio,
        toggleCompareBothAudio,
        placementEnabled,
        togglePlacement,
        placementMatches,
        setPlacementMatches,
    } = useSettings();
    const { laneFolderPrefixes } = useFolders();
    const { activeTags, tagMode } = useTags();
    const { version } = usePlacement();
    // Typed freely, applied (and clamped) on Enter or leaving the field.
    const [matchesDraft, setMatchesDraft] = useState(String(placementMatches));
    useEffect(() => setMatchesDraft(String(placementMatches)), [placementMatches]);
    const applyMatches = () => {
        const n = Number(matchesDraft);
        if (matchesDraft.trim() && Number.isFinite(n)) setPlacementMatches(n);
        setMatchesDraft(String(placementMatches));
    };

    // Files on either side with fewer comparisons than placement asks for.
    const [toPlace, setToPlace] = useState<number | null>(null);
    const laneKey = JSON.stringify(laneFolderPrefixes);
    const tagKey = [...activeTags].sort().join(",");
    useEffect(() => {
        const tagList = activeTags.size > 0 ? [...activeTags] : null;
        const lane = (side: "a" | "b") => ({
            folderPrefixes: laneFolderPrefixes[side],
            tagList,
            tagMode,
        });
        window.api
            .countPlacementCandidates(lane("a"), lane("b"), placementMatches)
            .then(setToPlace)
            .catch(() => setToPlace(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [laneKey, tagKey, tagMode, placementMatches, version]);

    const toggleButton = (on: boolean, onClick: () => void) => (
        <button
            onClick={onClick}
            className={`text-[10px] rounded px-2 py-0.5 transition-colors font-medium ${
                on
                    ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            }`}
        >
            {on ? "on" : "off"}
        </button>
    );

    return (
        <div className="px-3 mb-2">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-1 px-1 text-xs font-semibold uppercase tracking-widest text-neutral-500 hover:text-neutral-300 transition-colors"
            >
                <span className="w-3 text-[10px]">{open ? "▾" : "▸"}</span>
                Compare options
            </button>
            {open && (
                <div className="mt-1 flex flex-col gap-1.5 px-1">
                    <div
                        className="flex items-center justify-between"
                        title="Files with few comparisons stay on screen until they've had their placement matches, against opponents picked to find their rank quickly"
                    >
                        <span className="text-xs text-neutral-400">Placement matches</span>
                        {toggleButton(placementEnabled, togglePlacement)}
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-400">Matches per file</span>
                        <input
                            type="number"
                            min={PLACEMENT_MIN}
                            max={PLACEMENT_MAX}
                            value={matchesDraft}
                            onChange={(e) => setMatchesDraft(e.target.value)}
                            onBlur={applyMatches}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                            }}
                            className="w-12 rounded bg-neutral-800 px-1.5 py-0.5 text-right text-xs text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-600"
                        />
                    </div>
                    {toPlace != null && (
                        <p className="text-[11px] text-neutral-600">
                            {toPlace === 0
                                ? "Every file here is placed"
                                : `${toPlace} file${toPlace === 1 ? "" : "s"} to place`}
                        </p>
                    )}
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-400">Both sides' audio (X)</span>
                        {toggleButton(compareBothAudio, toggleCompareBothAudio)}
                    </div>
                </div>
            )}
        </div>
    );
}

function SettingsSection(): JSX.Element {
    const {
        hoverPreviewEnabled,
        toggleHoverPreview,
        volume,
        handleVolumeChange,
        scrollTime,
        handleScrollTimeChange,
        tileSize,
        handleTileSizeChange,
        showTagCategoryNames,
        toggleShowTagCategoryNames,
        pauseWhenUnfocused,
        togglePauseWhenUnfocused,
        alwaysShowUnsorted,
        toggleAlwaysShowUnsorted,
    } = useSettings();
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

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
                        <p className="text-xs text-neutral-500">
                            Toggle Hover Preview (Z)
                        </p>
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

                    <div className="flex items-center justify-between py-2 border-b border-neutral-800">
                        <p className="text-xs text-neutral-500">
                            Show Tag Category Names
                        </p>
                        <button
                            onClick={toggleShowTagCategoryNames}
                            className={`text-[10px] rounded px-2 py-0.5 transition-colors font-medium ${
                                showTagCategoryNames
                                    ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                            }`}
                        >
                            {showTagCategoryNames ? "on" : "off"}
                        </button>
                    </div>

                    <div className="flex items-center justify-between py-2 border-b border-neutral-800">
                        <p className="text-xs text-neutral-500">
                            Pause Videos When App Not Focused
                        </p>
                        <button
                            onClick={togglePauseWhenUnfocused}
                            className={`text-[10px] rounded px-2 py-0.5 transition-colors font-medium ${
                                pauseWhenUnfocused
                                    ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                            }`}
                        >
                            {pauseWhenUnfocused ? "on" : "off"}
                        </button>
                    </div>

                    <div className="flex items-center justify-between py-2 border-b border-neutral-800">
                        <p className="text-xs text-neutral-500">
                            Show Unsorted When Empty
                        </p>
                        <button
                            onClick={toggleAlwaysShowUnsorted}
                            className={`text-[10px] rounded px-2 py-0.5 transition-colors font-medium ${
                                alwaysShowUnsorted
                                    ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                                    : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                            }`}
                        >
                            {alwaysShowUnsorted ? "on" : "off"}
                        </button>
                    </div>

                    <SliderInput
                        name="volume"
                        min={0}
                        max={100}
                        value={volume}
                        onChange={handleVolumeChange}
                    />
                    <SliderInput
                        name="scroll time"
                        min={0}
                        max={2000}
                        value={scrollTime}
                        onChange={handleScrollTimeChange}
                    />
                    <SliderInput
                        name="tile size"
                        min={100}
                        max={300}
                        value={tileSize}
                        onChange={handleTileSizeChange}
                    />
                </div>
            )}
        </div>
    );
}

function SliderInput({
    name, min, max, value, unit, onChange,
}: {
    name: string;
    min: number;
    max: number;
    value: number;
    unit?: string;
    onChange: (newValue: number) => void;
}): JSX.Element {
    const factor = 100 / (max - min);

    return (
        <div className="flex items-center justify-between py-2">
            <p className="text-xs text-neutral-500">{name}</p>
            <div className="flex items-center gap-2">
                <div
                    className="relative w-24 h-1 bg-neutral-700 rounded cursor-pointer"
                    onMouseDown={(e) => {
                        e.preventDefault();
                        const el = e.currentTarget;
                        const calc = (clientX: number) => {
                            const rect = el.getBoundingClientRect();
                            const val = Math.min(
                                max,
                                Math.max(
                                    min,
                                    Math.round(
                                        ((clientX - rect.left) / rect.width) * (max - min) + min
                                    ),
                                ),
                            );
                            onChange(val);
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
                        style={{ width: `${(value - min) * factor}%` }}
                    />
                </div>
                <span className="text-xs text-neutral-500 w-7 text-right tabular-nums">
                    {value}{unit ?? ""}
                </span>
            </div>
        </div>
    );
}

export default function Sidebar({
    view,
    setView,
    onChangeLibrary,
    onRescanLibrary,
    isFullscreen,
}: {
    view: View;
    setView: (v: View) => void;
    onChangeLibrary: () => void;
    onRescanLibrary: () => void;
    isFullscreen: boolean;
}): JSX.Element {
    const [search, setSearch] = useState("");
    const { status, setStatus, resetStatus } = useStatus();

    const handleDropOnFolder = async (folder: string, absPaths: string[]) => {
        const { moved, errors } = await window.api.moveIntoFolder(absPaths, folder);
        if (errors.length > 0) {
            setStatus(errors.join(" · "));
        } else if (moved > 0) {
            setStatus(
                `Moved ${moved} file${moved === 1 ? "" : "s"} to ${folder || "the library folder"}`,
            );
            setTimeout(resetStatus, 2500);
        }
    };
    const { rootPath, folders, checkedFolders, checkAll, toggleFolder, activeFolder, setActiveFolder, folderMetaVersion, refreshFolders, setAllChecked } = useFolders();
    const { showUnsorted, setShowUnsorted } = useFolders();
    const { laneChecked, toggleLaneFolder, toggleLaneAll } = useFolders();
    const { alwaysShowUnsorted } = useSettings();

    // Count of files sitting directly in the library folder; refreshed when
    // files are added, removed, or moved.
    const [unsortedCount, setUnsortedCount] = useState(0);
    useEffect(() => {
        if (!rootPath) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const refresh = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                window.api.countRootFiles().then(setUnsortedCount).catch(() => {});
            }, 150);
        };
        refresh();
        const unsubs = [
            window.api.onMediaAdded(refresh),
            window.api.onMediaRemoved(refresh),
            window.api.onMediaRenamed(refresh),
            window.api.onLibraryScanned(refresh),
        ];
        return () => {
            if (timer) clearTimeout(timer);
            unsubs.forEach((u) => u());
        };
    }, [rootPath]);

    // Last unsorted file got filed away while viewing Unsorted: go back to All.
    useEffect(() => {
        if (showUnsorted && unsortedCount === 0 && !alwaysShowUnsorted) {
            setShowUnsorted(false);
        }
    }, [showUnsorted, unsortedCount, alwaysShowUnsorted, setShowUnsorted]);

    // New folder
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [createFolderError, setCreateFolderError] = useState<string | null>(null);

    const cancelCreateFolder = () => {
        setCreatingFolder(false);
        setNewFolderName("");
        setCreateFolderError(null);
    };

    const submitCreateFolder = async () => {
        if (!newFolderName.trim()) {
            cancelCreateFolder();
            return;
        }
        // If every folder was checked, keep it that way so the new folder
        // isn't silently filtered out of Compare etc.
        const paths = folders.map((n) => n.relativePath);
        const wasAllChecked = paths.every((p) => checkedFolders.has(p));

        const result = await window.api.createFolder(newFolderName);
        if ("error" in result) {
            setCreateFolderError(result.error);
            return;
        }
        await refreshFolders();
        if (wasAllChecked) setAllChecked([...paths, result.relativePath]);
        cancelCreateFolder();
    };

    const isFilterable = !view.startsWith("browse") && view!=="tag-manager";
    const isSearching = search.trim().length > 0;

    const sortedFolders = folders.sort((f1, f2) => f1.name.toLowerCase() < f2.name.toLowerCase() ? -1 : 1);

    const visibleFolders = isSearching
        ? folders.filter((n) =>
              n.name.toLowerCase().includes(search.trim().toLowerCase()),
          )
        : sortedFolders;

    const allPaths = folders.map((n) => n.relativePath);
    const allChecked = allPaths.every((p) => checkedFolders.has(p));
    const someChecked = allPaths.some((p) => checkedFolders.has(p));
    const isIndeterminate = someChecked && !allChecked;

    // Compare picks each side's folders separately.
    const laneMode = view === "compare";
    const laneAll = {
        a: allPaths.every((p) => laneChecked.a.has(p)),
        b: allPaths.every((p) => laneChecked.b.has(p)),
    };
    const laneSome = {
        a: allPaths.some((p) => laneChecked.a.has(p)),
        b: allPaths.some((p) => laneChecked.b.has(p)),
    };

    const handleShowInFolder = (e: React.MouseEvent) => {
        e.stopPropagation();
        // file.path is relative, so reconstruct the absolute path
        window.api.showInFolder(`${rootPath}`);
    };

    return (
        <aside className={`flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900 h-full ${isFullscreen ? "pt-3" : ""}`}>
            {sortedFolders.length > 0 && (
                <div className="flex flex-col flex-1 pb-3 min-h-0">
                    <h1
                        className="cursor-pointer text-lg px-3 font-semibold tracking-wide text-neutral-300"
                        onClick={handleShowInFolder}
                        title={"Show in Finder"}
                    >
                        {rootPath!.split("/").pop()}
                    </h1>

                    <div className="px-2 my-2 flex items-center gap-1.5">
                        {creatingFolder ? (
                            <input
                                type="text"
                                autoFocus
                                value={newFolderName}
                                onChange={(e) => {
                                    setNewFolderName(e.target.value);
                                    setCreateFolderError(null);
                                }}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter") submitCreateFolder();
                                    if (e.key === "Escape") cancelCreateFolder();
                                }}
                                onBlur={cancelCreateFolder}
                                placeholder="New folder name…"
                                className="flex-1 min-w-0 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none ring-1 ring-neutral-600 transition-colors"
                            />
                        ) : (
                            <>
                                <input
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder={`Search ${sortedFolders.length} folders…`}
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
                                <button
                                    onClick={() => setCreatingFolder(true)}
                                    title="New folder"
                                    className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 transition-colors text-base leading-none"
                                >
                                    +
                                </button>
                            </>
                        )}
                    </div>
                    {createFolderError && (
                        <p className="px-3 -mt-1 mb-2 text-[11px] text-red-400">
                            {createFolderError}
                        </p>
                    )}

                    {laneMode && (
                        <div
                            className="flex items-center text-[10px] font-medium uppercase text-neutral-500"
                            title="Which folders each side of Compare draws from"
                        >
                            <span className="mr-1 w-4" />
                            <span className="flex gap-1.5">
                                <span className="w-[13px] text-center">L</span>
                                <span className="w-[13px] text-center">R</span>
                            </span>
                        </div>
                    )}

                    {!isSearching && (
                        <FileDropRow onDropFiles={(paths) => handleDropOnFolder("", paths)}>
                            <span className="mr-1 w-4" />
                            {laneMode ? (
                                <LaneCheckboxes
                                    checked={laneAll}
                                    indeterminate={{
                                        a: laneSome.a && !laneAll.a,
                                        b: laneSome.b && !laneAll.b,
                                    }}
                                    onToggle={toggleLaneAll}
                                />
                            ) : isFilterable && (
                                <input
                                    type="checkbox"
                                    checked={allChecked}
                                    ref={(el) => {
                                        if (el)
                                            el.indeterminate = isIndeterminate;
                                    }}
                                    onChange={checkAll}
                                    className="mr-2 shrink-0 accent-white cursor-pointer"
                                />
                            )}
                            <button
                                onClick={() => {
                                    if (laneMode) {
                                        const both = laneAll.a && laneAll.b;
                                        if (laneAll.a === both) toggleLaneAll("a");
                                        if (laneAll.b === both) toggleLaneAll("b");
                                        return;
                                    }
                                    if (isFilterable) {
                                        checkAll();
                                        return;
                                    }
                                    if (view==="tag-manager") setView("browse");
                                    setShowUnsorted(false);
                                    setActiveFolder(null);
                                }}
                                className={`flex-1 truncate rounded-md py-1.5 pr-2 pl-8 text-left text-sm transition-colors ${
                                    !isFilterable && activeFolder === null && !showUnsorted
                                        ? "text-white font-medium"
                                        : laneMode
                                          ? laneAll.a && laneAll.b
                                              ? "text-white"
                                              : "text-neutral-300"
                                          : isFilterable && allChecked
                                          ? "text-white"
                                          : isFilterable && someChecked
                                            ? "text-neutral-300"
                                            : "text-neutral-400 hover:text-white"
                                }`}
                            >
                                All Collections
                            </button>
                        </FileDropRow>
                    )}

                    {!isSearching &&
                        !isFilterable &&
                        (unsortedCount > 0 || alwaysShowUnsorted) && (
                        <UnsortedItem
                            active={showUnsorted}
                            count={unsortedCount}
                            onSelect={() => {
                                if (view === "tag-manager") setView("browse");
                                setActiveFolder(null);
                                setShowUnsorted(true);
                            }}
                            onDropFiles={(paths) => handleDropOnFolder("", paths)}
                        />
                    )}

                    <div className="overflow-y-auto flex-1 min-h-0">
                        {visibleFolders.length > 0 ? (
                            visibleFolders.map((node) => (
                                <FolderItem
                                    key={node.relativePath}
                                    node={node}
                                    activeFolder={activeFolder}
                                    isFilterable={isFilterable}
                                    checkedFolders={checkedFolders}
                                    onSelectFolder={() => {
                                        if (view==="tag-manager") setView("browse")
                                        setActiveFolder(node.name)
                                    }}
                                    onToggleFolder={toggleFolder}
                                    folderMetaVersion={folderMetaVersion}
                                    onDropFiles={(paths) =>
                                        handleDropOnFolder(node.relativePath, paths)
                                    }
                                    lanes={
                                        laneMode
                                            ? {
                                                  checked: {
                                                      a: laneChecked.a.has(node.relativePath),
                                                      b: laneChecked.b.has(node.relativePath),
                                                  },
                                                  onToggle: (lane) =>
                                                      toggleLaneFolder(lane, node.relativePath),
                                              }
                                            : undefined
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

            

            {view === "compare" && <CompareOptionsSection />}

            <TagFilterSection
            />
            <div className="flex gap-1 p-3 shrink-0 bg-neutral-950/40 rounded-2xl">
                <NavItem
                    title={"Browse"}
                    icon={<FolderIcon className="w-5"/>}
                    active={view === "browse"}
                    onClick={() => setView("browse")}
                />
                <NavItem
                    title={"Compare and Rate"}
                    icon={<CompareIcon className="w-5"/>}
                    active={view === "compare"}
                    onClick={() => setView("compare")}
                />
                <NavItem
                    title={"Infinite Scroll"}
                    icon={<ScrollIcon className="w-5"/>}
                    active={view === "scroll"}
                    onClick={() => setView("scroll")}
                />
                <NavItem
                    title={"Tag Manager"}
                    icon={<TagIcon className="w-5"/>}
                    active={view === "tag-manager"}
                    onClick={() => setView("tag-manager")}
                />
            </div>

            <div className="shrink-0 p-3 border-t border-neutral-800">
                <div className="flex gap-1 p-3 pb-0 shrink-0">
                    <p className="w-full rounded-md px-3 py-2 text-left text-xs text-neutral-500">
                        Status: {status}
                    </p>
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
