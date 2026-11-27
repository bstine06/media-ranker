import { useEffect, useRef, useState } from "react";
import { useHistoryVersion } from "@renderer/hooks/useHistoryVersion";
import { createPortal } from "react-dom";
import type { DbFile, DbTag, FolderNode, View } from "../shared/types/types";
import NavItem from "./NavItem";
import { SweepIcon } from "./icons/SweepIcon";
import ConfirmDialog from "./ConfirmDialog";
import { useSettings } from "../contexts/SettingsContext";
import { useStatus } from "../contexts/StatusContext";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { FolderIcon } from "./icons/FolderIcon";
import { UNSORTED, useFolders } from "@renderer/contexts/FolderContext";
import { usePass } from "@renderer/contexts/PassContext";
import { PassIcon } from "./icons/PassIcon";
import { useTags } from "@renderer/contexts/TagsContext";
import { CompareIcon } from "./icons/CompareIcon";
import { TagIcon } from "./icons/TagIcon";
import { filterKey } from "@renderer/lib/tagFilters";
import FilterBuilder from "./FilterBuilder";
import { useGuardedMove } from "@renderer/hooks/useGuardedMove";
import { useEdgeResize } from "@renderer/hooks/useEdgeResize";
import { usePendingChange } from "@renderer/contexts/PendingChangeContext";

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

/**
 * The sidebar's checkbox (in place of the browser's own): a rounded square,
 * filled with a dark check when checked. The click area is the whole
 * gutter around it, not just the box.
 */
function SideCheck({
    checked,
    onToggle,
    label,
}: {
    checked: boolean;
    onToggle: () => void;
    label: string;
}): JSX.Element {
    return (
        <button
            role="checkbox"
            aria-checked={checked}
            aria-label={label}
            onClick={(e) => {
                e.stopPropagation();
                onToggle();
            }}
            className="group/check flex shrink-0 items-center self-stretch pl-3 pr-2"
        >
            <span
                className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border transition-colors ${
                    checked
                        ? "border-neutral-100 bg-neutral-100 group-hover/check:border-white group-hover/check:bg-white"
                        : "border-neutral-500 group-hover/check:border-neutral-300 group-hover/check:bg-neutral-800"
                }`}
            >
                {checked && (
                    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-neutral-900" fill="none">
                        <path
                            d="M2.5 6.2 5 8.6 9.5 3.6"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                )}
            </span>
        </button>
    );
}

/** A word-link in the selection row (select all, show only, clear). */
function SelectionLink({
    onClick,
    title,
    children,
}: {
    onClick: () => void;
    title: string;
    children: React.ReactNode;
}): JSX.Element {
    return (
        <button
            onClick={onClick}
            title={title}
            className="shrink-0 rounded px-0.5 text-neutral-400 underline-offset-2 transition-colors hover:text-neutral-100 hover:underline"
        >
            {children}
        </button>
    );
}

/** The space a row without a checkbox leaves, so names line up. */
const CHECK_GUTTER = <span className="w-[2.125rem] shrink-0" />;

function FolderItem({
    node,
    isActive,
    isChecked,
    onOpen,
    onToggle,
    folderMetaVersion,
    onDropFiles,
}: {
    node: FolderNode;
    /** Open in Browse right now. */
    isActive: boolean;
    isChecked: boolean;
    onOpen: () => void;
    onToggle: () => void;
    folderMetaVersion: number;
    onDropFiles: (absPaths: string[]) => void;
}): JSX.Element {
    const { isDropTarget, dropHandlers } = useFileDropTarget(onDropFiles);

    const [profileImageHash, setProfileImageHash] = useState<string | null>();
    const historyVersion = useHistoryVersion();

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
    }, [node, folderMetaVersion, historyVersion]);

    return (
        <div
            data-folder={node.relativePath}
            className={`flex items-center pr-2 transition-colors ${
                isDropTarget
                    ? "bg-neutral-700 ring-1 ring-inset ring-neutral-400"
                    : "hover:bg-neutral-800"
            }`}
            {...dropHandlers}
        >
            <SideCheck
                checked={isChecked}
                onToggle={onToggle}
                label={`Select ${node.name}`}
            />
            <button
                onClick={onOpen}
                title={`Open ${node.name} in Browse`}
                className={`flex min-w-0 flex-1 items-center rounded-md py-1 pr-1 text-left text-sm transition-colors ${
                    isActive ? "font-medium text-white" : "text-neutral-300 hover:text-white"
                }`}
            >
                {profileImageHash ? (
                    <ThumbnailImage
                        contentHash={profileImageHash}
                        className="mr-2 h-6 w-6 shrink-0 rounded-full"
                    />
                ) : (
                    <div className="mr-2 shrink-0 rounded-full bg-neutral-700">
                        <FolderIcon className="m-1 h-4 w-4 text-neutral-500" />
                    </div>
                )}
                <span className="truncate">{node.name}</span>
            </button>
        </div>
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
    checked,
    onToggle,
    onSelect,
    onDropFiles,
}: {
    active: boolean;
    count: number;
    /** Selected, like a collection. */
    checked: boolean;
    onToggle: () => void;
    onSelect: () => void;
    onDropFiles: (absPaths: string[]) => void;
}): JSX.Element {
    const { isDropTarget, dropHandlers } = useFileDropTarget(onDropFiles);
    return (
        <div
            className={`flex items-center pr-2 transition-colors ${
                isDropTarget
                    ? "bg-neutral-700 ring-1 ring-inset ring-neutral-400"
                    : "hover:bg-neutral-800"
            }`}
            {...dropHandlers}
        >
            <SideCheck checked={checked} onToggle={onToggle} label="Select Unsorted" />
            <button
                onClick={onSelect}
                title="Files sitting directly in the library folder"
                className={`flex min-w-0 flex-1 items-center justify-between rounded-md py-1.5 pr-1 text-left text-sm transition-colors ${
                    active
                        ? "text-white font-medium"
                        : "text-neutral-400 hover:text-white"
                }`}
            >
                <span className="truncate">Unsorted</span>
                <span className="text-xs tabular-nums text-neutral-500">
                    {count}
                </span>
            </button>
        </div>
    );
}

// The tag filter: a button opening the filter builder (FilterBuilder.tsx),
// which is where the filter is made and changed. Here only whether one is
// on (and the saved feed's name, if it came from one), and a way to clear it.
function TagFilterSection(): JSX.Element {
    const { filter, filterBroken, loadedFeed, clearFilter } = useTags();
    const [open, setOpen] = useState(false);
    const edited = loadedFeed != null && filterKey(loadedFeed.tree) !== filterKey(filter);

    return (
        <div className="px-2 mb-3 mt-1">
            <p className="text-xs px-1 mb-1.5 font-semibold uppercase tracking-widest text-neutral-500">
                Tags
            </p>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => setOpen(true)}
                    title="Build or change the tag filter"
                    className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                        filter
                            ? filterBroken
                                ? "bg-red-950 text-red-300"
                                : "bg-neutral-200 text-neutral-900"
                            : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                    }`}
                >
                    <span className="truncate">
                        {!filter
                            ? "Filter…"
                            : filterBroken
                              ? "Filter needs fixing"
                              : loadedFeed
                                ? loadedFeed.name + (edited ? " (edited)" : "")
                                : "Filter on"}
                    </span>
                </button>
                {filter && (
                    <button
                        onClick={clearFilter}
                        title="Turn the filter off"
                        className="rounded px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                    >
                        ×
                    </button>
                )}
            </div>
            {open && <FilterBuilder onClose={() => setOpen(false)} />}
        </div>
    );
}

// A choice in the filing panel's list.
function FilingRow({
    selected,
    onClick,
    children,
}: {
    selected: boolean;
    onClick: () => void;
    children: React.ReactNode;
}): JSX.Element {
    return (
        <button
            onClick={onClick}
            className={`flex w-full items-center gap-1 truncate rounded px-2 py-1.5 text-left text-xs transition-colors ${
                selected ? "bg-neutral-200 text-neutral-900" : "text-neutral-300 hover:bg-neutral-800"
            }`}
        >
            {children}
        </button>
    );
}

function SettingsModal({
    onClose,
    onRescanLibrary,
    onChangeLibrary,
}: {
    onClose: () => void;
    onRescanLibrary: () => void;
    onChangeLibrary: () => void;
}): JSX.Element {
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
        showHistory,
        toggleShowHistory,
        compareBothAudio,
        toggleCompareBothAudio,
        showLibraryRank,
        toggleShowLibraryRank,
        sweepVarispeed,
        toggleSweepVarispeed,
        sweepScrubHold,
        toggleSweepScrubHold,
        sweepAllLanes,
        toggleSweepAllLanes,
        passFfFactor,
        setPassFfFactor,
    } = useSettings();
    // A confirm opened from inside handles its own Escape.
    const confirmOpen = useRef(false);

    // While open, keys belong to the modal: Escape closes it, and nothing
    // reaches Browse/Compare shortcuts behind it (picks, Z, arrows).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Escape" && !confirmOpen.current) onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);

    return createPortal(
        <div
            data-modal
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="w-[26rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-neutral-200">Settings</h2>
                    <button
                        onClick={onClose}
                        title="Close (Esc)"
                        className="rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                    >
                        ✕
                    </button>
                </div>

                <SettingsGroup title="Display">
                    <ToggleRow
                        label="Hover preview"
                        on={hoverPreviewEnabled}
                        onToggle={toggleHoverPreview}
                    />
                    <ToggleRow
                        label="Show library rank on files"
                        on={showLibraryRank}
                        onToggle={toggleShowLibraryRank}
                    />
                    <ToggleRow
                        label="Show tag category names"
                        on={showTagCategoryNames}
                        onToggle={toggleShowTagCategoryNames}
                    />
                    <ToggleRow
                        label="Show Unsorted when empty"
                        on={alwaysShowUnsorted}
                        onToggle={toggleAlwaysShowUnsorted}
                    />
                    <ToggleRow
                        label="Show undo history"
                        on={showHistory}
                        onToggle={toggleShowHistory}
                    />
                    <ToggleRow
                        label="Sweep: extra lanes vary in speed"
                        on={sweepVarispeed}
                        onToggle={toggleSweepVarispeed}
                    />
                    <ToggleRow
                        label="Sweep: 1 / 3 move all lanes"
                        on={sweepAllLanes}
                        onToggle={toggleSweepAllLanes}
                    />
                    <ToggleRow
                        label="Sweep: scrubbing stops lanes until 3"
                        on={sweepScrubHold}
                        onToggle={toggleSweepScrubHold}
                    />
                    <SliderInput
                        name="Pass: hold 4 to fast-forward at"
                        min={2}
                        max={10}
                        value={passFfFactor}
                        unit="×"
                        onChange={setPassFfFactor}
                    />
                    <SliderInput
                        name="tile size"
                        min={100}
                        max={300}
                        value={tileSize}
                        onChange={handleTileSizeChange}
                    />
                </SettingsGroup>

                <SettingsGroup title="Playback">
                    <ToggleRow
                        label="Pause videos when app not focused"
                        on={pauseWhenUnfocused}
                        onToggle={togglePauseWhenUnfocused}
                    />
                    <ToggleRow
                        label="Compare: play both sides' audio"
                        on={compareBothAudio}
                        onToggle={toggleCompareBothAudio}
                    />
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
                </SettingsGroup>

                <SettingsGroup title="Library">
                    <ActionRow
                        label="Look for files added, moved or removed outside the app"
                        button="Rescan"
                        onClick={() => {
                            onClose();
                            onRescanLibrary();
                        }}
                    />
                    <ActionRow
                        label="Open a different library folder"
                        button="Change library…"
                        onClick={() => {
                            onClose();
                            onChangeLibrary();
                        }}
                    />
                    <MissingRecordsRow
                        onConfirmingChange={(c) => {
                            confirmOpen.current = c;
                        }}
                    />
                </SettingsGroup>
            </div>
        </div>,
        document.body,
    );
}

function SettingsGroup({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}): JSX.Element {
    return (
        <section className="mt-4 first-of-type:mt-0">
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                {title}
            </h3>
            <div className="divide-y divide-neutral-800">{children}</div>
        </section>
    );
}

function ActionRow({
    label,
    button,
    onClick,
}: {
    label: string;
    button: string;
    onClick: () => void;
}): JSX.Element {
    return (
        <div className="flex items-center justify-between gap-3 py-2">
            <p className="text-xs text-neutral-400">{label}</p>
            <button
                onClick={onClick}
                className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-[10px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
            >
                {button}
            </button>
        </div>
    );
}

function ToggleRow({
    label,
    on,
    onToggle,
}: {
    label: string;
    on: boolean;
    onToggle: () => void;
}): JSX.Element {
    return (
        <div className="flex items-center justify-between py-2">
            <p className="text-xs text-neutral-400">{label}</p>
            <button
                onClick={onToggle}
                className={`w-9 shrink-0 text-center text-[10px] rounded py-0.5 transition-colors font-medium ${
                    on
                        ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                        : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                }`}
            >
                {on ? "on" : "off"}
            </button>
        </div>
    );
}

/**
 * Deleted or moved-out files keep their record (rank, tags, history) so
 * they're restored if they come back. This forgets them for good.
 */
function MissingRecordsRow({
    onConfirmingChange,
}: {
    onConfirmingChange: (confirming: boolean) => void;
}): JSX.Element {
    const { setStatus } = useStatus();
    const [count, setCount] = useState<number | null>(null);
    const [confirming, setConfirming] = useState(false);

    useEffect(() => {
        onConfirmingChange(confirming);
    }, [confirming, onConfirmingChange]);

    const historyVersion = useHistoryVersion();
    useEffect(() => {
        window.api.countMissingFiles().then(setCount);
    }, [historyVersion]);

    const clear = async () => {
        setConfirming(false);
        const n = await window.api.deleteMissingFiles();
        setCount(0);
        setStatus(`Cleared ${n} missing file record${n === 1 ? "" : "s"}`);
    };

    const files = (n: number) => `${n} missing file${n === 1 ? "" : "s"}`;

    return (
        <div className="flex items-center justify-between py-2">
            <p
                className="text-xs text-neutral-400"
                title="Files deleted or moved out of the library keep their rank and tags, so they come back if the file is returned."
            >
                Missing file records
                {count !== null && (
                    <span className="ml-1 tabular-nums text-neutral-400">{count}</span>
                )}
            </p>
            <button
                onClick={() => setConfirming(true)}
                disabled={!count}
                className="text-[10px] rounded px-2 py-0.5 transition-colors font-medium bg-neutral-800 text-neutral-400 hover:bg-red-950 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-neutral-800 disabled:hover:text-neutral-400"
            >
                clear
            </button>
            {confirming && count !== null && (
                <ConfirmDialog
                    title="Clear Missing File Records"
                    message={`Delete the records for ${files(count)}? Their ranks, tags and comparison history will be erased. If any of them are put back in the library, they'll come back as new, unranked files. Files still in the library keep their scores, but their matches against these files are removed from their history.`}
                    confirmText="Clear"
                    onConfirm={clear}
                    onCancel={() => setConfirming(false)}
                />
            )}
        </div>
    );
}

export function SliderInput({
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
            <p className="text-xs text-neutral-400">{name}</p>
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

    const { guardedMove, moveDialog } = useGuardedMove();
    const handleDropOnFolder = async (folder: string, absPaths: string[]) => {
        const result = await guardedMove(absPaths, folder);
        if (!result) return;
        const { moved, errors } = result;
        if (errors.length > 0) {
            setStatus(errors.join(" · "));
        } else if (moved > 0) {
            setStatus(
                `Moved ${moved} file${moved === 1 ? "" : "s"} to ${folder || "the library folder"}`,
            );
            setTimeout(resetStatus, 2500);
        }
    };
    const { rootPath, folders, checkedFolders, toggleFolder, activeFolder, setActiveFolder, folderMetaVersion, refreshFolders, setAllChecked } = useFolders();
    const { openLobby } = usePass();
    const { showUnsorted, setShowUnsorted } = useFolders();
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
            window.api.onHistoryApplied(refresh),
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

    const newFolderInputRef = useRef<HTMLInputElement>(null);

    const cancelCreateFolder = () => {
        setCreatingFolder(false);
        setNewFolderName("");
        setCreateFolderError(null);
    };

    // Opening it puts the cursor in the name box (after the click that
    // opened it has finished, so nothing takes focus back), and Esc leaves
    // it from anywhere, not only from inside the box.
    useEffect(() => {
        if (!creatingFolder) return;
        const raf = requestAnimationFrame(() => newFolderInputRef.current?.focus());
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            cancelCreateFolder();
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("keydown", onKey, true);
        };
    }, [creatingFolder]);

    // Makes a folder (the + box, the search's "Create folder" row, filing
    // dropped files). Returns its path, or the error.
    const makeFolder = async (name: string): Promise<{ relativePath: string } | { error: string }> => {
        // (A new folder joins the selection if everything was selected:
        // FolderContext.)
        const result = await window.api.createFolder(name);
        if ("error" in result) return result;
        await refreshFolders();
        return result;
    };
    // The same, with a failure shown under the search box.
    const createFolderNamed = async (name: string): Promise<boolean> => {
        const result = await makeFolder(name);
        if ("error" in result) {
            setCreateFolderError(result.error);
            return false;
        }
        revealNewFolder(result.relativePath);
        return true;
    };

    // A folder just made in the app: open it in Browse and scroll the list
    // to it, with nothing (a search, "show only") hiding it.
    const [scrollTo, setScrollTo] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const revealNewFolder = (path: string) => {
        setSearch("");
        setShowOnly(null);
        openInBrowse(path);
        setScrollTo(path);
    };
    useEffect(() => {
        if (!scrollTo) return;
        const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-folder]") ?? [])].find(
            (el) => el.dataset.folder === scrollTo,
        );
        if (!row) return; // not listed yet: tries again when folders update
        row.scrollIntoView({ block: "center" });
        setScrollTo(null);
    }, [scrollTo, folders, search]);

    // ── Filing dropped files ─────────────────────────────────────────────
    // Files dropped on the folder search start filing them: the rest of the
    // app is covered (unusable) while you search for a folder, pick one (or
    // Unsorted, or "Create folder" with the typed name) and confirm. Nothing
    // moves, and no folder is made, until Confirm; Undo (or Esc) leaves the
    // files where they were.
    type FilingTarget =
        | { kind: "folder"; path: string }
        | { kind: "unsorted" }
        | { kind: "new"; name: string };
    const [filing, setFiling] = useState<string[] | null>(null);
    const [filingQuery, setFilingQuery] = useState("");
    const [filingTarget, setFilingTarget] = useState<FilingTarget | null>(null);
    const [filingError, setFilingError] = useState<string | null>(null);
    const [filingBusy, setFilingBusy] = useState(false);
    const searchDrop = useFileDropTarget((paths) => {
        setFiling(paths);
        setFilingQuery(search);
        setFilingTarget(null);
        setFilingError(null);
    });
    const endFiling = () => {
        setFiling(null);
        setFilingQuery("");
        setFilingTarget(null);
        setFilingError(null);
        setFilingBusy(false);
    };

    const filingQ = filingQuery.trim();
    const filingFolders = folders
        .filter((n) => n.name.toLowerCase().includes(filingQ.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name));
    const filingOfferUnsorted = !filingQ || "unsorted".includes(filingQ.toLowerCase());
    const filingOfferCreate =
        filingQ !== "" && !folders.some((n) => n.name.toLowerCase() === filingQ.toLowerCase());
    // Picking a different name (typing on after choosing "Create folder")
    // keeps the choice in step with what's typed.
    useEffect(() => {
        setFilingTarget((t) => (t?.kind === "new" ? (filingOfferCreate ? { kind: "new", name: filingQ } : null) : t));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filingQ]);

    const filingTargetLabel = (t: FilingTarget) =>
        t.kind === "unsorted" ? "Unsorted" : t.kind === "new" ? `new folder "${t.name}"` : t.path;

    const confirmFiling = async () => {
        if (!filing || !filingTarget || filingBusy) return;
        setFilingBusy(true);
        setFilingError(null);
        let target = "";
        if (filingTarget.kind === "folder") target = filingTarget.path;
        let result: { moved: number; errors: string[] } | null;
        if (filingTarget.kind === "new") {
            // A new folder has no noes, so no confirm; made and filled in
            // one step, so one undo takes back both.
            const made = await window.api.moveIntoNewFolder(filing, filingTarget.name);
            if ("error" in made) {
                setFilingError(made.error);
                setFilingBusy(false);
                return;
            }
            await refreshFolders();
            target = made.relativePath;
            result = made;
        } else {
            result = await guardedMove(filing, target);
        }
        if (!result) {
            setFilingBusy(false);
            return;
        }
        const { moved, errors } = result;
        const where = target || "Unsorted";
        const madeNew = filingTarget.kind === "new";
        endFiling();
        setSearch("");
        if (madeNew) revealNewFolder(target);
        if (errors.length > 0) {
            setStatus(`Moved ${moved} of ${filing.length} to ${where} · ${errors.join(" · ")}`);
        } else {
            setStatus(`Moved ${moved} file${moved === 1 ? "" : "s"} to ${where}`);
            setTimeout(resetStatus, 2500);
        }
    };

    // While filing, keys belong to it: Esc undoes, Enter confirms (or picks
    // the first result), and nothing reaches the views behind the cover.
    // Typing still goes into the search box (only the event's travel is
    // stopped, not the typing).
    const filingKeys = useRef({ confirmFiling, endFiling, filingTarget, filingFolders, filingOfferUnsorted, filingOfferCreate, filingQ });
    filingKeys.current = { confirmFiling, endFiling, filingTarget, filingFolders, filingOfferUnsorted, filingOfferCreate, filingQ };
    useEffect(() => {
        if (!filing) return;
        const onKey = (e: KeyboardEvent) => {
            // The move confirm (folder noes) has the keys while it's open.
            if (document.querySelector("[data-modal]")) return;
            e.stopPropagation();
            const k = filingKeys.current;
            if (e.key === "Escape") {
                e.preventDefault();
                k.endFiling();
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (k.filingTarget) k.confirmFiling();
                else if (k.filingFolders[0]) setFilingTarget({ kind: "folder", path: k.filingFolders[0].relativePath });
                else if (k.filingOfferCreate) setFilingTarget({ kind: "new", name: k.filingQ });
                else if (k.filingOfferUnsorted) setFilingTarget({ kind: "unsorted" });
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [filing]);

    const submitCreateFolder = async () => {
        if (!newFolderName.trim()) {
            cancelCreateFolder();
            return;
        }
        if (await createFolderNamed(newFolderName)) cancelCreateFolder();
    };

    const isSearching = search.trim().length > 0;

    // The collections in name order, always (selecting one doesn't move it).
    const byName = [...folders].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    // Unsorted is selected like a collection; it counts while its row shows.
    const unsortedShown = unsortedCount > 0 || alwaysShowUnsorted;
    const unsortedChecked = checkedFolders.has(UNSORTED);
    const selectedCount =
        folders.filter((n) => checkedFolders.has(n.relativePath)).length +
        (unsortedShown && unsortedChecked ? 1 : 0);
    // Everything selected = all collections (Unsorted too); none = no files.
    const allSelected =
        folders.every((n) => checkedFolders.has(n.relativePath)) && (unsortedChecked || !unsortedShown);
    const selectAll = () => setAllChecked([UNSORTED, ...folders.map((n) => n.relativePath)]);

    // "show only": the list cut down to the selected collections. Ones
    // unselected meanwhile stay until "show all", so a slip is easy to undo.
    const [showOnly, setShowOnly] = useState<Set<string> | null>(null);
    // It's for a few: selecting all or none ends it.
    useEffect(() => {
        if (showOnly && (selectedCount === 0 || allSelected)) setShowOnly(null);
    }, [showOnly, selectedCount, allSelected]);
    useEffect(() => setShowOnly(null), [rootPath]);

    // Searching looks through every collection, shown only or not.
    const visibleFolders = isSearching
        ? byName.filter((n) => n.name.toLowerCase().includes(search.trim().toLowerCase()))
        : showOnly
          ? byName.filter((n) => showOnly.has(n.relativePath) || checkedFolders.has(n.relativePath))
          : byName;

    // Searching for a name no folder has exactly (ignoring case): offer to
    // make it, at the end of the results.
    const searchName = search.trim();
    const offerCreate =
        isSearching && !folders.some((n) => n.name.toLowerCase() === searchName.toLowerCase());

    // A collection's name (or All files, Unsorted) opens it in Browse, from
    // any view; the checkbox is what selects.
    const { setOpenFile } = usePendingChange();
    const openInBrowse = (folder: string | null, unsorted = false) => {
        setOpenFile(null);
        if (view !== "browse") setView("browse");
        setActiveFolder(folder);
        setShowUnsorted(unsorted);
    };
    const inBrowse = view === "browse";

    // Settings, the sidebar's width (drag its right edge; remembered).
    const [settingsOpen, setSettingsOpen] = useState(false);
    const { sidebarWidth, setSidebarWidth } = useSettings();
    const resize = useEdgeResize({
        width: sidebarWidth,
        save: setSidebarWidth,
        min: 208,
        max: 400,
        edge: "right",
    });

    const handleShowInFolder = (e: React.MouseEvent) => {
        e.stopPropagation();
        // file.path is relative, so reconstruct the absolute path
        window.api.showInFolder(`${rootPath}`);
    };

    return (
        <aside
            style={{ width: resize.width }}
            className={`relative flex shrink-0 flex-col border-r border-neutral-800 bg-neutral-900 h-full ${isFullscreen ? "pt-3" : ""}`}
        >
            {/* Drag to resize. */}
            <div
                onMouseDown={resize.onMouseDown}
                title="Drag to resize"
                className={`absolute inset-y-0 -right-1 z-30 w-2 cursor-ew-resize transition-colors ${
                    resize.dragging ? "bg-neutral-600" : "hover:bg-neutral-600/70"
                }`}
            />
            {/* Shown as soon as a library is open, folders or not: a new
                library with only loose files still needs its name, Unsorted
                and a way to make the first folder. */}
            {rootPath && (
                <div className="flex flex-col flex-1 pb-3 min-h-0">
                    <h1
                        className="cursor-pointer text-lg px-3 font-semibold tracking-wide text-neutral-300"
                        onClick={handleShowInFolder}
                        title={"Show in Finder"}
                    >
                        {rootPath!.split("/").pop()}
                    </h1>

                    {filing && (
                        <>
                            {/* Covers the whole app while filing. */}
                            {createPortal(
                                <div data-modal className="fixed inset-0 z-40 bg-black/60" />,
                                document.body,
                            )}
                            {/* The filing panel, above the cover. */}
                            <div className="relative z-50 mx-2 my-2 flex flex-col gap-2 rounded-lg border border-neutral-600 bg-neutral-900 p-2 shadow-2xl">
                                <p className="px-1 text-[11px] text-neutral-400">
                                    Add{" "}
                                    <span className="text-neutral-200">
                                        {filing.length === 1
                                            ? filing[0].split("/").pop()
                                            : `${filing.length} files`}
                                    </span>{" "}
                                    to…
                                </p>
                                <input
                                    type="text"
                                    autoFocus
                                    value={filingQuery}
                                    onChange={(e) => {
                                        setFilingQuery(e.target.value);
                                        setFilingError(null);
                                    }}
                                    placeholder="Search folders, or type a new name…"
                                    className="w-full rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none ring-1 ring-neutral-600"
                                />
                                <div className="max-h-64 overflow-y-auto">
                                    {filingOfferUnsorted && (
                                        <FilingRow
                                            selected={filingTarget?.kind === "unsorted"}
                                            onClick={() => setFilingTarget({ kind: "unsorted" })}
                                        >
                                            <span className="italic">Unsorted</span>
                                        </FilingRow>
                                    )}
                                    {filingFolders.map((n) => (
                                        <FilingRow
                                            key={n.relativePath}
                                            selected={filingTarget?.kind === "folder" && filingTarget.path === n.relativePath}
                                            onClick={() => setFilingTarget({ kind: "folder", path: n.relativePath })}
                                        >
                                            {n.name}
                                        </FilingRow>
                                    ))}
                                    {filingOfferCreate && (
                                        <FilingRow
                                            selected={filingTarget?.kind === "new"}
                                            onClick={() => setFilingTarget({ kind: "new", name: filingQ })}
                                        >
                                            <span className="text-sm leading-none">+</span> Create folder "
                                            <span className="text-neutral-200">{filingQ}</span>"
                                        </FilingRow>
                                    )}
                                    {!filingOfferUnsorted && filingFolders.length === 0 && !filingOfferCreate && (
                                        <p className="px-2 py-1.5 text-xs text-neutral-600">No folders match</p>
                                    )}
                                </div>
                                {filingError && <p className="px-1 text-[11px] text-red-400">{filingError}</p>}
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={endFiling}
                                        title="Leave the files where they were (Esc)"
                                        className="rounded px-2.5 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                                    >
                                        Undo
                                    </button>
                                    <button
                                        onClick={confirmFiling}
                                        disabled={!filingTarget || filingBusy}
                                        title="Enter"
                                        className="ml-auto truncate rounded bg-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        {filingBusy
                                            ? "Moving…"
                                            : filingTarget
                                              ? `Confirm: ${filingTargetLabel(filingTarget)}`
                                              : "Pick a folder"}
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                    <div className={`px-2 my-2 flex items-center gap-1.5 ${filing ? "hidden" : ""}`}>
                        {creatingFolder ? (
                            <>
                            <input
                                ref={newFolderInputRef}
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
                            <button
                                // mousedown, before the box loses focus.
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    cancelCreateFolder();
                                }}
                                title="Cancel (Esc)"
                                className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                            >
                                Cancel
                            </button>
                            </>
                        ) : (
                            <>
                                <input
                                    type="text"
                                    // Drop files here to file them into a folder.
                                    {...searchDrop.dropHandlers}
                                    title="Search folders, or drop files here to add them to one"
                                    value={search}
                                    onChange={(e) => {
                                        setSearch(e.target.value);
                                        setCreateFolderError(null);
                                    }}
                                    placeholder={
                                        searchDrop.isDropTarget
                                            ? "Drop to add to a folder…"
                                            : `Search ${folders.length} folders…`
                                    }
                                    className={`flex-1 min-w-0 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:ring-1 focus:ring-neutral-600 transition-colors ${
                                        searchDrop.isDropTarget ? "ring-2 ring-neutral-300" : ""
                                    }`}
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
                                    // Keep focus off the button, so the name
                                    // box gets it.
                                    onMouseDown={(e) => e.preventDefault()}
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

                    {!isSearching && (
                        <FileDropRow onDropFiles={(paths) => handleDropOnFolder("", paths)}>
                            {CHECK_GUTTER}
                            <button
                                onClick={() => openInBrowse(null)}
                                title="Every file in the library, in Browse"
                                className={`flex-1 truncate rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
                                    inBrowse && activeFolder === null && !showUnsorted
                                        ? "text-white font-medium"
                                        : "text-neutral-400 hover:text-white"
                                }`}
                            >
                                All files
                            </button>
                        </FileDropRow>
                    )}

                    {!isSearching && unsortedShown && (
                        <UnsortedItem
                            active={inBrowse && showUnsorted}
                            count={unsortedCount}
                            checked={unsortedChecked}
                            onToggle={() => toggleFolder(UNSORTED, [UNSORTED])}
                            onSelect={() => openInBrowse(null, true)}
                            onDropFiles={(paths) => handleDropOnFolder("", paths)}
                        />
                    )}

                    {/* The selection (Sweep, Pass, Compare, Coverage use it).
                        Nothing to select yet: no line. */}
                    {(folders.length > 0 || unsortedShown) && (
                    <div className="mt-1 flex items-center gap-1 border-y border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
                        {allSelected ? (
                            <>
                                <span className="truncate">All collections</span>
                                <span>·</span>
                                <SelectionLink onClick={() => setAllChecked([])} title="Unselect every collection, then check the ones you want">
                                    clear
                                </SelectionLink>
                            </>
                        ) : selectedCount === 0 ? (
                            <>
                                <span className="truncate text-amber-300/80">None selected</span>
                                <span>·</span>
                                <SelectionLink onClick={selectAll} title="Select every collection">
                                    select all
                                </SelectionLink>
                            </>
                        ) : (
                            <>
                                <span className="truncate tabular-nums text-neutral-400">
                                    {selectedCount.toLocaleString()} selected
                                </span>
                                <span>·</span>
                                <SelectionLink
                                    onClick={() =>
                                        setShowOnly((cur) => (cur ? null : new Set(checkedFolders)))
                                    }
                                    title={showOnly ? "Show every collection" : "List only the selected collections"}
                                >
                                    {showOnly ? "show all" : "show only"}
                                </SelectionLink>
                                <span>·</span>
                                <SelectionLink onClick={selectAll} title="Select every collection again">
                                    reset
                                </SelectionLink>
                            </>
                        )}
                    </div>
                    )}

                    <div ref={listRef} className="overflow-y-auto flex-1 min-h-0">
                        {visibleFolders.length > 0 ? (
                            visibleFolders.map((node) => (
                                <FolderItem
                                    key={node.relativePath}
                                    node={node}
                                    isActive={inBrowse && !showUnsorted && activeFolder === node.relativePath}
                                    isChecked={checkedFolders.has(node.relativePath)}
                                    onOpen={() => openInBrowse(node.relativePath)}
                                    onToggle={() => toggleFolder(node.relativePath, [node.relativePath])}
                                    folderMetaVersion={folderMetaVersion}
                                    onDropFiles={(paths) =>
                                        handleDropOnFolder(node.relativePath, paths)
                                    }
                                />
                            ))
                        ) : (
                            !offerCreate && (
                                <p className="px-5 py-2 text-xs text-neutral-600">
                                    {folders.length === 0 ? "No folders yet" : "No folders match"}
                                </p>
                            )
                        )}
                        {offerCreate && (
                            <button
                                onClick={async () => {
                                    if (await createFolderNamed(searchName)) setSearch("");
                                }}
                                title={`Create a folder named "${searchName}"`}
                                className="flex w-full items-center gap-2 px-5 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                            >
                                <span className="text-sm leading-none">+</span>
                                <span className="truncate">
                                    Create folder "<span className="text-neutral-200">{searchName}</span>"
                                </span>
                            </button>
                        )}
                    </div>
                </div>
            )}

            


            <TagFilterSection />
            <div className="relative shrink-0">
            {/* The status, floating just above the buttons while there's a
                message; it never moves anything. */}
            {status !== "Ready" && (
                <div className="pointer-events-none absolute inset-x-2 bottom-full z-20 mb-1 flex justify-center">
                    <p
                        title={`${status}\n(click to hide)`}
                        onClick={resetStatus}
                        className="pointer-events-auto cursor-default line-clamp-3 rounded-lg border border-neutral-700 bg-neutral-800/95 px-3 py-1.5 text-center text-[11px] text-neutral-300 shadow-lg"
                    >
                        {status}
                    </p>
                </div>
            )}
            <div className="flex gap-1 p-3 bg-neutral-950/40 rounded-2xl">
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
                    title={"Sweep (tag one tag at a time)"}
                    icon={<SweepIcon className="w-5" />}
                    active={view === "sweep"}
                    onClick={() => setView("sweep")}
                />
                <NavItem
                    title={"Pass (go through a set of files, one tag at a time)"}
                    icon={<PassIcon className="w-5" />}
                    active={view === "pass"}
                    onClick={() => {
                        setView("pass");
                        openLobby();
                    }}
                />
                <NavItem
                    title={"Tag Manager"}
                    icon={<TagIcon className="w-5"/>}
                    active={view === "tag-manager"}
                    onClick={() => setView("tag-manager")}
                />
                <NavItem
                    title={"Settings"}
                    icon={<span className="text-base leading-5">⚙</span>}
                    active={settingsOpen}
                    onClick={() => setSettingsOpen(true)}
                />
            </div>
            </div>
            {settingsOpen && (
                <SettingsModal
                    onClose={() => setSettingsOpen(false)}
                    onRescanLibrary={onRescanLibrary}
                    onChangeLibrary={onChangeLibrary}
                />
            )}
            {moveDialog}
        </aside>
    );
}
