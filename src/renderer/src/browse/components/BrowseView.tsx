import { useCallback, useEffect, useMemo, useState } from "react";
import type {
    DbFile,
    DbFolderMetadata,
    DbTag,
    View,
} from "../../shared/types/types";
import MediaTile from "./MediaTile";
import { useStatus } from "../../contexts/StatusContext";
import { SortMode } from "../types/browserTypes";
import BrowseRow from "./BrowseRow";
import MetadataView from "./MetadataView";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { SlotResolver } from "@renderer/hooks/useScrollSlots";
import ScrollView from "@renderer/components/ScrollView";
import { showInFolder } from "@renderer/lib/filesystem";
import { TagIcon } from "@renderer/components/icons/TagIcon";
import FolderTagPanel from "./FolderTagPanel";
import ConfirmDialog from "@renderer/components/ConfirmDialog";
import { useKingOfHill } from "@renderer/contexts/KingOfHillContext";
import { usePlacement } from "@renderer/contexts/PlacementContext";

// ─── Sorting ──────────────────────────────────────────────────────────────────

// Each sort's natural order ("down"); the up arrow reverses it.
const SORTS: Record<
    SortMode,
    {
        label: string;
        title: string;
        icon: string; // heroicons path
        compare: (a: DbFile, b: DbFile) => number;
        order: { down: string; up: string };
    }
> = {
    alphabetical: {
        label: "A-Z",
        title: "Sort by name",
        icon: "M3 4.5h14.25M3 9h9.75M3 13.5h9.75M3 18h9.75",
        compare: (a, b) => a.filename.localeCompare(b.filename),
        order: { down: "A to Z", up: "Z to A" },
    },
    rank: {
        label: "Rank",
        title: "Sort by rank",
        icon: "M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12",
        compare: (a, b) => b.elo_score - a.elo_score,
        order: { down: "Best first", up: "Worst first" },
    },
    compared: {
        label: "Compared",
        title: "Sort by how often each file has been compared (the least compared need ranking most)",
        icon: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
        compare: (a, b) => a.comparison_count - b.comparison_count,
        order: { down: "Fewest comparisons first", up: "Most comparisons first" },
    },
    added: {
        label: "Added",
        title: "Sort by when each file was added to the library",
        icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
        // "YYYY-MM-DD HH:MM:SS" strings sort chronologically.
        compare: (a, b) => b.date_indexed.localeCompare(a.date_indexed),
        order: { down: "Newest first", up: "Oldest first" },
    },
    fileSize: {
        label: "Size",
        title: "Sort by file size",
        icon: "M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5",
        compare: (a, b) => b.size - a.size,
        order: { down: "Largest first", up: "Smallest first" },
    },
};

// ─── BrowseView ───────────────────────────────────────────────────────────────

const getDisplayFolder = (path: string): string | null => {
    const [top] = path.split("/").filter(Boolean);
    return top ?? null;
};

export default function BrowseView({
    active,
    setView,
}: {
    active: boolean;
    setView: (view: View) => void;
}): JSX.Element {
    const [fields, setFields] = useState<
        { key: string; value: string; type: string }[]
    >([]);
    const [folderProfileHash, setFolderProfileHash] = useState<string | null>(
        null,
    );
    const [folderProfileMap, setFolderProfileMap] = useState<
        Record<string, string | null>
    >({});
    const [metadataFields, setMetadataFields] = useState<string[]>([]); // for autocomplete
    const [metadata, setMetadata] = useState<DbFolderMetadata | null>(null);
    const [editingMetadata, setEditingMetadata] = useState(false);
    const [draftProfileImage, setDraftProfileImage] = useState<
        string | undefined
    >();
    const [draftName, setDraftName] = useState<string>("");
    const [renameError, setRenameError] = useState<string | null>(null);

    const [folderTags, setFolderTags] = useState<DbTag[]>([]);

    const [files, setFiles] = useState<DbFile[]>([]);
    const [browseScrollIndex, setBrowseScrollIndex] = useState<number | null>(
        null,
    );

    // ── Selection ───────────────────────────────────────────────────────────
    // ⌘-click toggles a file; "Select" mode makes plain clicks toggle too.
    // The selection can be batch tagged, or dragged (to a folder / out).
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [selectMode, setSelectMode] = useState(false);

    const [showTagPanel, setShowTagPanel] = useState<boolean>(false);
    // Files waiting on the delete confirm: one from a tile's trash button,
    // or the whole selection.
    const [deleting, setDeleting] = useState<DbFile[] | null>(null);

    const { crown } = useKingOfHill();
    const { startSession, version: placementVersion } = usePlacement();
    const crownAndCompare = (file: DbFile) => {
        crown(file);
        setView("compare");
    };

    const { setStatus, resetStatus } = useStatus();
    const {
        rootPath,
        activeFolder,
        setActiveFolder,
        handleFolderMetadataChanged,
        showUnsorted,
    } = useFolders();
    const { refreshTags, activeTags, tagMode } = useTags();
    const {
        tileSize,
        browseSortMode: sortMode,
        setBrowseSortMode: setSortMode,
        browseSortDirection: sortDirection,
        setBrowseSortDirection: setSortDirection,
        browseViewMode: viewMode,
        setBrowseViewMode: setViewMode,
        placementMatches,
    } = useSettings();

    // Files in this collection that still need placement matches.
    const [toPlace, setToPlace] = useState(0);
    useEffect(() => {
        if (!activeFolder) {
            setToPlace(0);
            return;
        }
        const pool = { folderPrefixes: [activeFolder], tagList: null, tagMode: "or" as const };
        window.api
            .countPlacementCandidates(pool, pool, placementMatches)
            .then(setToPlace)
            .catch(() => setToPlace(0));
    }, [activeFolder, files, placementMatches, placementVersion]);

    const placeNewFiles = () => {
        if (!activeFolder || toPlace === 0) return;
        startSession({ folder: activeFolder, total: toPlace });
        setView("compare");
    };

    //get files on mount, clear browseScroll
    useEffect(() => {
        getFilesForFolder(activeFolder, activeTags, tagMode, showUnsorted);
        setBrowseScrollIndex(null);
    }, [rootPath, activeFolder, activeTags, tagMode, showUnsorted]);

    // The launch-time catch-up scan can add, move or drop files in bulk
    // without per-file events: reload the list once it's done.
    useEffect(() => {
        return window.api.onLibraryScanned((result) => {
            if (result)
                getFilesForFolder(activeFolder, activeTags, tagMode, showUnsorted);
        });
    }, [activeFolder, activeTags, tagMode, showUnsorted]);

    const handleDelete = async () => {
        if (!deleting) return;
        const files = deleting;
        setDeleting(null);
        const failed: string[] = [];
        for (const file of files) {
            try {
                await window.api.deleteFile(file.id);
            } catch (error) {
                console.error("Failed to delete file:", error);
                failed.push(file.filename);
            }
        }
        if (failed.length > 0) {
            setStatus(
                `Couldn't move to trash: ${failed.slice(0, 3).join(", ")}${
                    failed.length > 3 ? ` and ${failed.length - 3} more` : ""
                }`,
            );
        }
    };

    useEffect(() => {
        const loadProfiles = async () => {
            const folders = Array.from(
                new Set(
                    files.map((f) => getDisplayFolder(f.path)).filter(Boolean),
                ),
            );

            const entries = await Promise.all(
                folders.map(async (folder) => {
                    const data = folder
                        ? await window.api.getFolder(folder)
                        : null;
                    return [folder, data?.profile_image_hash ?? null];
                }),
            );

            setFolderProfileMap(Object.fromEntries(entries));
        };

        if (!activeFolder && files.length > 0) {
            loadProfiles();
        }
    }, [files, activeFolder]);

    const getFilesForFolder = useCallback(
        async (
            folder: string | null,
            tags: Set<number>,
            tagMode: "and" | "or",
            unsorted = false,
        ) => {
            setActiveFolder(folder);
            const result: DbFile[] = unsorted
                ? await window.api.getRootFiles()
                : folder
                  ? await window.api.getFilesInFolder(folder)
                  : await window.api.getAllActiveFiles();

            //filter on tags
            if (tags.size > 0) {
                const tagMatchFileIds = await window.api.getFileIdsByTags(
                    Array.from(tags),
                    tagMode,
                );
                const tagMatchSet = new Set(tagMatchFileIds);
                const filteredResult = result.filter((f) => {
                    return tagMatchSet.has(f.id);
                });
                setFiles(filteredResult);
            } else {
                setFiles(result);
            }
        },
        [],
    );

    //load folder metadata on folder change
    useEffect(() => {
        if (!activeFolder) {
            setFields([]);
            setFolderProfileHash(null);
            setFolderTags([]);
            setMetadataFields([]);
            setEditingMetadata(false);
            setRenameError(null);
            return;
        }

        const load = async () => {
            try {
                const [dbFields, dbFolder, tags, fieldNames] =
                    await Promise.all([
                        window.api.getFolderMetadata(activeFolder),
                        window.api.getFolder(activeFolder),
                        window.api.getFolderTags(activeFolder),
                        window.api.getMetadataFields(),
                    ]);
                setFields(dbFields);
                setFolderTags(tags);
                setMetadataFields(fieldNames);
                setFolderProfileHash(dbFolder?.profile_image_hash ?? null);
            } catch {
                setFields([]);
                setFolderProfileHash(null);
                setFolderTags([]);
            }
        };

        load();
        setEditingMetadata(false);
        setRenameError(null);
    }, [rootPath, activeFolder]);

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setStatus("Adding files...");
        const paths = Array.from(e.dataTransfer.files).map((f) =>
            window.api.getPathForFile(f),
        );
        // "All Files" has no target folder: new files land in the library
        // root (Unsorted). Files already in the library (e.g. a tile dropped
        // back onto the grid) are left where they are.
        const toMove = activeFolder
            ? paths
            : paths.filter((p) => !(rootPath && p.startsWith(rootPath + "/")));
        if (toMove.length === 0) {
            resetStatus();
            return;
        }
        const { errors } = await window.api.moveIntoFolder(
            toMove,
            activeFolder ?? "",
        );
        if (errors.length > 0) {
            setStatus(errors.join(" · "));
            return;
        }
        await new Promise((r) => setTimeout(r, 1000));
        resetStatus();
    };

    const handleEditStart = () => {
        setDraftProfileImage(folderProfileHash ?? undefined);
        setDraftName(activeFolder ?? "");
        setRenameError(null);
        setEditingMetadata(true);
    };

    const handleAddFolderTag = async (tag: string) => {
        if (!activeFolder) return;
        await window.api.addTagToFolder(activeFolder, tag);
        const tags = await window.api.getFolderTags(activeFolder);
        setFolderTags(tags);
        refreshTags();
    };

    const handleRemoveFolderTag = async (tag: string) => {
        if (!activeFolder) return;
        await window.api.removeTagFromFolder(activeFolder, tag);
        const tags = await window.api.getFolderTags(activeFolder);
        setFolderTags(tags);
        refreshTags();
    };

    const handleMetadataSave = async (
        updatedFields: { key: string; value: string; type: string }[],
        newName: string,
    ) => {
        if (!activeFolder) return;
        if (newName.trim() === "") {
            setRenameError("Folder name cannot be empty");
            return;
        }

        // A field needs a name to be stored.
        updatedFields = updatedFields
            .map((f) => ({ ...f, key: f.key.trim() }))
            .filter((f) => f.key);

        // Fields removed (or renamed) while editing are deleted, or they'd
        // come back on the next load.
        const keptKeys = new Set(updatedFields.map((f) => f.key));
        await Promise.all([
            ...fields
                .filter((f) => !keptKeys.has(f.key))
                .map((f) =>
                    window.api.deleteFolderMetadataField(activeFolder, f.key),
                ),
            ...updatedFields.map((f) =>
                window.api.setFolderMetadataField(
                    activeFolder,
                    f.key,
                    f.value,
                    f.type,
                ),
            ),
        ]);

        // Save profile image
        await window.api.setFolderProfileImage(
            activeFolder,
            draftProfileImage ?? null,
        );
        setFolderProfileHash(draftProfileImage ?? null);
        handleFolderMetadataChanged();

        if (newName !== activeFolder) {
            const result = await window.api.renameFolder(activeFolder, newName);
            if (!result.ok) {
                setRenameError(result.error);
                return;
            }
        }

        setFields(updatedFields);
        setRenameError(null);
        setEditingMetadata(false);
        setDraftProfileImage(undefined);
    };

    const isSelected = (file: DbFile) => selectedIds.has(file.id);

    const toggleSelected = (file: DbFile) =>
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(file.id)) next.delete(file.id);
            else next.add(file.id);
            return next;
        });

    const clearSelection = useCallback(() => {
        setSelectedIds(new Set());
        setSelectMode(false);
    }, []);

    const handleTileClick = (
        file: DbFile,
        index: number,
        e?: React.MouseEvent,
    ) => {
        if (editingMetadata) {
            setDraftProfileImage((prev) =>
                prev === file.content_hash ? undefined : file.content_hash,
            );
        } else if (selectMode || e?.metaKey || e?.ctrlKey) {
            toggleSelected(file);
        } else {
            setBrowseScrollIndex(index);
        }
    };

    const handleExecuteBatchTag = async (tagNames: string[], files: DbFile[]) => {
        try {
            for (const f of files) {
                for (const tagName of tagNames) {
                    await window.api.addTag(f.id, tagName);
                }
            }
        } catch (error) {
            console.error("Batch tag failed:", error);
        }
        refreshTags();
        // Keep the selection so the same files can be dragged/moved next.
    };

    const sortedFiles = useMemo(() => {
        const sort = SORTS[sortMode] ?? SORTS.alphabetical;
        return [...files].sort((a, b) => {
            // "down" is each sort's natural order; "up" reverses it. Ties
            // fall back to the filename so the order is stable.
            const d = sort.compare(a, b) || a.filename.localeCompare(b.filename);
            return sortDirection === "down" ? d : -d;
        });
    }, [files, sortMode, sortDirection]);

    const selectedFiles = useMemo(
        () => sortedFiles.filter((f) => selectedIds.has(f.id)),
        [sortedFiles, selectedIds],
    );

    // New folder / filters: start with nothing selected.
    useEffect(() => {
        clearSelection();
    }, [rootPath, activeFolder, activeTags, tagMode, showUnsorted, clearSelection]);

    // Files that leave the view (moved, deleted) drop out of the selection.
    useEffect(() => {
        setSelectedIds((prev) => {
            if (prev.size === 0) return prev;
            const present = new Set(files.map((f) => f.id));
            const next = new Set([...prev].filter((id) => present.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [files]);

    // ⌘A selects everything visible; Esc clears. Only on the grid/list (not
    // the scroll view), and never while typing in a field.
    useEffect(() => {
        if (!active || browseScrollIndex !== null) return;
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (
                t &&
                (t.tagName === "INPUT" ||
                    t.tagName === "TEXTAREA" ||
                    t.isContentEditable)
            ) {
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
                e.preventDefault();
                setSelectedIds(new Set(sortedFiles.map((f) => f.id)));
            } else if (
                (e.metaKey || e.ctrlKey) &&
                e.key === "Backspace" &&
                selectedFiles.length > 0
            ) {
                // Finder's shortcut for Move to Trash.
                e.preventDefault();
                setDeleting(selectedFiles);
            } else if (
                e.key === "Escape" &&
                (selectedIds.size > 0 || selectMode)
            ) {
                clearSelection();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, browseScrollIndex, sortedFiles, selectedIds, selectedFiles, selectMode, clearSelection]);

    // Dragging a selected file drags the whole selection; dragging any other
    // file drags just that one (like Finder).
    const handleDragOut = (file: DbFile) => {
        if (selectedIds.has(file.id) && selectedFiles.length > 1) {
            window.api.dragFilesOut(selectedFiles);
        } else {
            window.api.dragFileOut(file);
        }
    };

    useEffect(() => {
        // Whether a file at this path belongs in the current view (by
        // location; tag filters are applied by reloading). A folder includes
        // its subfolders.
        const inView = (path: string): boolean =>
            activeFolder
                ? path.startsWith(activeFolder + "/")
                : showUnsorted
                  ? !path.includes("/")
                  : true;
        // Coalesced: a folder rename sends one event per file.
        let reloadTimer: ReturnType<typeof setTimeout> | null = null;
        const reload = () => {
            if (!rootPath) return;
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
                reloadTimer = null;
                getFilesForFolder(activeFolder, activeTags, tagMode, showUnsorted);
            }, 100);
        };

        const handleAdded = window.api.onMediaAdded(({ relativePath }) => {
            // Reload rather than insert: we need the full DbFile.
            if (inView(relativePath)) reload();
        });

        const handleRemoved = window.api.onMediaRemoved(({ relativePath }) => {
            // always remove from state regardless of which folder is active
            setFiles((prev) => prev.filter((f) => f.path !== relativePath));
        });

        const handleRenamed = window.api.onMediaRenamed(
            ({ oldRelativePath, relativePath }) => {
                // A move can change a file's inherited folder tags, so with a
                // tag filter on, just reload. Same for a file moving into view
                // from elsewhere (it isn't in the list to update).
                if (
                    (activeTags.size > 0 || !inView(oldRelativePath)) &&
                    inView(relativePath)
                ) {
                    reload();
                    return;
                }
                // Moved out of the view: drop it from the grid.
                if (!inView(relativePath)) {
                    setFiles((prev) =>
                        prev.filter((f) => f.path !== oldRelativePath),
                    );
                    return;
                }
                setFiles((prev) =>
                    prev.map((f) =>
                        f.path === oldRelativePath
                            ? {
                                  ...f,
                                  path: relativePath,
                                  filename:
                                      relativePath.split("/").pop() ??
                                      f.filename,
                              }
                            : f,
                    ),
                );
            },
        );

        // Edited in place (e.g. rotated): swap in the fresh record so the
        // tile shows the new thumbnail.
        const handleUpdated = window.api.onMediaUpdated(({ file }) => {
            if (!file) return;
            setFiles((prev) => prev.map((f) => (f.id === file.id ? file : f)));
        });

        return () => {
            handleAdded();
            handleRemoved();
            handleRenamed();
            handleUpdated();
            if (reloadTimer) clearTimeout(reloadTimer);
        };
    }, [rootPath, activeFolder, showUnsorted, activeTags, tagMode, getFilesForFolder]);

    const resolver: SlotResolver = useCallback(
        async (dir, cursor) => {
            if (browseScrollIndex === null) return null;
            const newIndexUnbounded =
                dir === "down" ? browseScrollIndex + 1 : browseScrollIndex - 1;
            const newIndex =
                newIndexUnbounded < 0
                    ? 0
                    : newIndexUnbounded > sortedFiles.length - 1
                      ? sortedFiles.length - 1
                      : newIndexUnbounded;
            if (browseScrollIndex === newIndex) return null;
            setBrowseScrollIndex(newIndex);
            cursor = newIndex;
            return sortedFiles[newIndex] ?? null;
        },
        [sortedFiles, browseScrollIndex],
    );

    if (rootPath && browseScrollIndex !== null) {
        const currentFile = sortedFiles[browseScrollIndex];

        const currentFolder = currentFile
            ? getDisplayFolder(currentFile.path)
            : null;

        return (
            <ScrollView
                initialFile={currentFile}
                resolver={resolver}
                active={active}
                rootPath={rootPath!}
                folderProfileHash={
                    activeFolder
                        ? folderProfileHash
                        : ((currentFolder
                              ? folderProfileMap[currentFolder]
                              : null) ?? null)
                }
                onFolderClick={(folderName) => {
                    setActiveFolder(folderName);
                    setView("browse");
                }}
                onFileClick={(file) => showInFolder(rootPath!, file.path)}
                onClose={() => setBrowseScrollIndex(null)}
                onCrown={crownAndCompare}
                allowRotate
                progress={{
                    index: browseScrollIndex + 1,
                    total: sortedFiles.length,
                }}
            />
        );
    }

    return (
    <div
        className="flex flex-1 flex-col overflow-hidden"
        onDragOver={(e) => e.preventDefault()}
        onDragEnter={(e) => e.preventDefault()}
        onDrop={handleDrop}
    >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
            <div className="flex items-center gap-3 min-w-0">
                <h2 className="truncate text-sm font-medium text-neutral-300">
                    {showUnsorted ? "Unsorted" : (activeFolder ?? "All Files")}
                </h2>
                <button
                    onClick={() =>
                        selectMode ? clearSelection() : setSelectMode(true)
                    }
                    title="Select files (or ⌘-click any file · ⌘A selects all · Esc clears)"
                    className={`shrink-0 text-xs rounded px-2 py-1 transition-colors ${
                        selectMode
                            ? "bg-neutral-700 text-neutral-200"
                            : "text-neutral-600 hover:text-neutral-400"
                    }`}
                >
                    Select
                </button>
                {activeFolder && toPlace > 0 && (
                    <button
                        onClick={placeNewFiles}
                        title={`Give the ${toPlace} file${toPlace === 1 ? "" : "s"} here with fewer than ${placementMatches} comparisons their placement matches in Compare, then come back`}
                        className="shrink-0 whitespace-nowrap rounded px-2 py-1 text-xs text-amber-300/80 hover:bg-neutral-800 hover:text-amber-200 transition-colors"
                    >
                        Place {toPlace} new
                    </button>
                )}
                {(selectMode || selectedIds.size > 0) && (
                    <div className="flex shrink-0 items-center gap-1 text-xs">
                        <span className="tabular-nums text-neutral-400 mr-1">
                            {selectedFiles.length} selected
                        </span>
                        <button
                            onClick={() =>
                                setSelectedIds(new Set(sortedFiles.map((f) => f.id)))
                            }
                            className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                        >
                            All
                        </button>
                        <button
                            onClick={() => setShowTagPanel(true)}
                            disabled={selectedFiles.length === 0}
                            title="Batch tag the selection"
                            className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500 transition-colors"
                        >
                            Tag
                        </button>
                        <button
                            onClick={() => setDeleting(selectedFiles)}
                            disabled={selectedFiles.length === 0}
                            title="Move the selection to the trash (⌘⌫)"
                            className="rounded px-2 py-1 text-neutral-500 hover:bg-red-950 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500 transition-colors"
                        >
                            Delete
                        </button>
                        <button
                            onClick={clearSelection}
                            className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                        >
                            Clear
                        </button>
                    </div>
                )}
            </div>
            <div className="flex items-center gap-3">
                <div className="flex gap-1">
                    {(Object.keys(SORTS) as SortMode[]).map((mode) => (
                        <button
                            key={mode}
                            onClick={() => setSortMode(mode)}
                            title={SORTS[mode].title}
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortMode === mode
                                    ? "bg-neutral-700 text-neutral-200"
                                    : "text-neutral-600 hover:text-neutral-400"
                            }`}
                        >
                            <svg
                                className="w-3 h-3"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d={SORTS[mode].icon}
                                />
                            </svg>
                            {/* Icons only in narrow windows; the title names it. */}
                            <span className="hidden lg:inline">
                                {SORTS[mode].label}
                            </span>
                        </button>
                    ))}
                </div>

                <div className="flex gap-2">
                    {(["down", "up"] as const).map((direction) => (
                        <button
                            key={direction}
                            onClick={() => setSortDirection(direction)}
                            title={(SORTS[sortMode] ?? SORTS.alphabetical).order[direction]}
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortDirection === direction
                                    ? "bg-neutral-700 text-neutral-200"
                                    : "text-neutral-600 hover:text-neutral-400"
                            }`}
                        >
                            <svg
                                className="w-3 h-3"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d={
                                        direction === "down"
                                            ? "M19.5 8.25l-7.5 7.5-7.5-7.5"
                                            : "M4.5 15.75l7.5-7.5 7.5 7.5"
                                    }
                                />
                            </svg>
                        </button>
                    ))}
                </div>

                <div className="flex items-center rounded bg-neutral-800 p-0.5">
                    <button
                        onClick={() => setViewMode("grid")}
                        title="Grid view"
                        className={`rounded p-1 transition-colors ${
                            viewMode === "grid"
                                ? "bg-neutral-600 text-neutral-200"
                                : "text-neutral-600 hover:text-neutral-400"
                        }`}
                    >
                        <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
                            />
                        </svg>
                    </button>
                    <button
                        onClick={() => setViewMode("rows")}
                        title="Row view"
                        className={`rounded p-1 transition-colors ${
                            viewMode === "rows"
                                ? "bg-neutral-600 text-neutral-200"
                                : "text-neutral-600 hover:text-neutral-400"
                        }`}
                    >
                        <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                            />
                        </svg>
                    </button>
                </div>

                
                    <button
                        onClick={() => setShowTagPanel(!showTagPanel)}
                        title="Folder tags"
                        className={`rounded p-1.5 transition-colors ${
                            showTagPanel
                                ? "bg-neutral-700 text-neutral-200"
                                : "text-neutral-600 hover:text-neutral-400"
                        }`}
                    >
                        <TagIcon className="w-4 h-4" />
                    </button>

                {/* Hidden in narrow windows to leave room for the folder name. */}
                <span className="hidden lg:inline whitespace-nowrap text-xs text-neutral-600">
                    {files.length} files
                </span>
            </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-1 flex-col overflow-hidden">
                {activeFolder && (
                    <MetadataView
                        folderName={activeFolder}
                        fields={fields}
                        profileImage={folderProfileHash}
                        metadataFields={metadataFields}
                        files={files}
                        editing={editingMetadata}
                        draftProfileImage={draftProfileImage}
                        draftName={draftName}
                        renameError={renameError}
                        onDraftNameChange={setDraftName}
                        onEditStart={handleEditStart}
                        onSave={handleMetadataSave}
                        onCancel={() => {
                            setEditingMetadata(false);
                            setRenameError(null);
                        }}
                    />
                )}

                {files.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                        No media found in this folder.
                    </div>
                ) : viewMode === "grid" ? (
                    <div
                        className="flex-1 overflow-y-auto overflow-x-hidden select-none"
                        style={{ scrollbarGutter: "stable" }}
                    >
                        <div
                            className="grid-media p-4"
                            style={
                                {
                                    "--grid-tile-size": `${tileSize}px`,
                                } as React.CSSProperties
                            }
                        >
                            {sortedFiles.map((file, i) => (
                                <div
                                    key={file.id}
                                    className={`relative cursor-pointer overflow-hidden transition-all ${
                                        draftProfileImage === file.content_hash || isSelected(file)
                                            ? "ring-2 ring-blue-500 bg-blue-500/10"
                                            : "ring-1 ring-transparent"
                                    }`}
                                    onClick={(e) => handleTileClick(file, i, e)}
                                >
                                    <MediaTile
                                        file={file}
                                        rootPath={rootPath!}
                                        onClickTrash={() => setDeleting([file])}
                                        onClickCrown={() => crownAndCompare(file)}
                                        onDragOut={() => handleDragOut(file)}
                                    />
                                    {draftProfileImage ===
                                        file.content_hash && (
                                        <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                                            <svg
                                                className="w-3 h-3 text-white"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={3}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M4.5 12.75l6 6 9-13.5"
                                                />
                                            </svg>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="overflow-y-auto flex-1 select-none">
                        {sortedFiles.map((file, index) => (
                            <BrowseRow
                                key={file.id}
                                file={file}
                                rank={sortMode === "rank" ? index + 1 : null}
                                rootPath={rootPath!}
                                onClick={(e) => handleTileClick(file, index, e)}
                                onDragOut={() => handleDragOut(file)}
                                isSelected={
                                    draftProfileImage === file.content_hash || isSelected(file)
                                }
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Tag Panel */}
            {showTagPanel && (
                <div className="w-72 border-l border-neutral-800 flex-shrink-0">
                    <FolderTagPanel
                        folderTags={folderTags}
                        onAddFolderTag={handleAddFolderTag}
                        onRemoveFolderTag={handleRemoveFolderTag}
                        selectedFiles={selectedFiles}
                        onExecuteBatchTag={handleExecuteBatchTag}
                    />
                </div>
            )}
            {deleting && (
                <ConfirmDialog
                    title={deleting.length === 1 ? "Delete File" : `Delete ${deleting.length} Files`}
                    message={
                        deleting.length === 1
                            ? `Are you sure you want to delete "${deleting[0].filename}"? It will be moved to trash.`
                            : `Are you sure you want to delete these ${deleting.length} files? They will be moved to trash.`
                    }
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleting(null)}
                />
            )}
        </div>
    </div>
);
}
