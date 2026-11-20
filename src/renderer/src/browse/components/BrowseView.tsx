import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHistoryVersion } from "@renderer/hooks/useHistoryVersion";
import type {
    DbFile,
    FilterNode,
    DbFolderMetadata,
    DbTag,
    View,
} from "../../shared/types/types";
import MediaTile from "./MediaTile";
import { useStatus } from "../../contexts/StatusContext";
import { SortMode } from "../types/browserTypes";
import { SORTS, sortFiles } from "@renderer/lib/sorts";
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
import { useGuardedMove } from "@renderer/hooks/useGuardedMove";
import ConfirmDialog from "@renderer/components/ConfirmDialog";
import { useKingOfHill } from "@renderer/contexts/KingOfHillContext";
import { usePlacement, PLACEMENT_MATCHES } from "@renderer/contexts/PlacementContext";

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
    // Deleting the open folder: first what to do with its files, then a
    // confirm listing everything it affects.
    const [folderDelete, setFolderDelete] = useState<
        | { step: "choose"; folder: string; files: number }
        | {
              step: "confirm";
              folder: string;
              mode: "trash" | "unsort";
              preview: NonNullable<Awaited<ReturnType<typeof window.api.folderDeletePreview>>>;
          }
        | null
    >(null);
    const [draftProfileImage, setDraftProfileImage] = useState<
        string | undefined
    >();
    // However editing ends (Save, Cancel, another folder, an undo), the
    // picked picture goes with it, or its tile stays highlighted.
    useEffect(() => {
        if (!editingMetadata) setDraftProfileImage(undefined);
    }, [editingMetadata]);
    const [draftName, setDraftName] = useState<string>("");
    const [renameError, setRenameError] = useState<string | null>(null);

    const [folderTags, setFolderTags] = useState<DbTag[]>([]);

    const [files, setFiles] = useState<DbFile[]>([]);
    // The grid unmounts while a file is open; coming back puts it where it
    // was. A different folder starts at the top.
    const listScroll = useRef(0);
    const saveScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        listScroll.current = e.currentTarget.scrollTop;
    }, []);
    const restoreScroll = useCallback((el: HTMLDivElement | null) => {
        if (el) el.scrollTop = listScroll.current;
    }, []);
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
    const { guardedMove, moveDialog } = useGuardedMove();
    const {
        rootPath,
        activeFolder,
        setActiveFolder,
        handleFolderMetadataChanged,
        showUnsorted,
        setShowUnsorted,
    } = useFolders();
    useEffect(() => {
        listScroll.current = 0;
    }, [activeFolder, showUnsorted]);
    const { refreshTags, activeFilter } = useTags();
    const {
        tileSize,
        browseSortMode: sortMode,
        setBrowseSortMode: setSortMode,
        browseSortDirection: sortDirection,
        setBrowseSortDirection: setSortDirection,
        browseViewMode: viewMode,
        setBrowseViewMode: setViewMode,
    } = useSettings();

    // Files in this collection that still need placement matches.
    const [toPlace, setToPlace] = useState(0);
    useEffect(() => {
        if (!activeFolder) {
            setToPlace(0);
            return;
        }
        const pool = { folderPrefixes: [activeFolder], filter: null };
        window.api
            .countPlacementCandidates(pool, pool, PLACEMENT_MATCHES)
            .then(setToPlace)
            .catch(() => setToPlace(0));
    }, [activeFolder, files, placementVersion]);

    const placeNewFiles = () => {
        if (!activeFolder || toPlace === 0) return;
        startSession({ kind: "folder", folder: activeFolder, total: toPlace, returnTo: "browse" });
        setView("compare");
    };

    //get files on mount, clear browseScroll
    useEffect(() => {
        getFilesForFolder(activeFolder, activeFilter, showUnsorted);
        setBrowseScrollIndex(null);
    }, [rootPath, activeFolder, activeFilter, showUnsorted]);

    // The launch-time catch-up scan can add, move or drop files in bulk
    // without per-file events: reload the list once it's done.
    useEffect(() => {
        return window.api.onLibraryScanned((result) => {
            if (result)
                getFilesForFolder(activeFolder, activeFilter, showUnsorted);
        });
    }, [activeFolder, activeFilter, showUnsorted]);

    // An undo/redo can change which files match the tag filter.
    const historyVersion = useHistoryVersion();
    useEffect(() => {
        if (historyVersion > 0) getFilesForFolder(activeFolder, activeFilter, showUnsorted);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyVersion]);

    const handleDelete = async () => {
        if (!deleting) return;
        const files = deleting;
        setDeleting(null);
        // All in one call: one undo entry.
        let failed: string[] = [];
        try {
            failed = await window.api.deleteFiles(files.map((f) => f.id));
        } catch (error) {
            console.error("Failed to delete files:", error);
            failed = files.map((f) => f.filename);
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
            filter: FilterNode | null,
            unsorted = false,
        ) => {
            setActiveFolder(folder);
            const result: DbFile[] = unsorted
                ? await window.api.getRootFiles()
                : folder
                  ? await window.api.getFilesInFolder(folder)
                  : await window.api.getAllActiveFiles();

            //filter on tags
            if (filter) {
                const tagMatchFileIds = await window.api.getFileIdsByFilter(filter);
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
        // historyVersion: an undo/redo may have changed the folder's tags,
        // metadata or picture.
    }, [rootPath, activeFolder, historyVersion]);

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
        const result = await guardedMove(toMove, activeFolder ?? "");
        if (!result) {
            resetStatus();
            return;
        }
        const { errors } = result;
        if (errors.length > 0) {
            setStatus(errors.join(" · "));
            return;
        }
        await new Promise((r) => setTimeout(r, 1000));
        resetStatus();
    };

    // Step two: what deleting will do, from a fresh look at the folder.
    const chooseFolderDelete = async (mode: "trash" | "unsort") => {
        if (!folderDelete) return;
        const preview = await window.api.folderDeletePreview(folderDelete.folder);
        if (!preview) {
            setFolderDelete(null);
            return;
        }
        setFolderDelete({ step: "confirm", folder: folderDelete.folder, mode, preview });
    };

    const confirmFolderDelete = async () => {
        if (folderDelete?.step !== "confirm") return;
        const { folder, mode } = folderDelete;
        setFolderDelete(null);
        setStatus(mode === "unsort" ? "Moving files to Unsorted…" : "Deleting folder…");
        const result = await window.api.deleteFolder(folder, mode);
        if ("error" in result) {
            setStatus(result.error);
            return;
        }
        // The folder's gone from the sidebar and Browse moves off it (the
        // folder:removed event); the moved files show up in Unsorted.
        resetStatus();
    };

    const handleEditStart = () => {
        setDraftProfileImage(folderProfileHash ?? undefined);
        setDraftName(activeFolder ?? "");
        setRenameError(null);
        setEditingMetadata(true);
    };

    const handleAddFolderTag = async (tag: string) => {
        if (!activeFolder) return { ok: true as const };
        const res = await window.api.addTagToFolder(activeFolder, tag);
        const tags = await window.api.getFolderTags(activeFolder);
        setFolderTags(tags);
        refreshTags();
        return res;
    };

    const reloadFolderTags = async () => {
        if (!activeFolder) return;
        setFolderTags(await window.api.getFolderTags(activeFolder));
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
            // All in one call: one undo entry.
            await window.api.batchAddTags(files.map((f) => f.id), tagNames);
        } catch (error) {
            console.error("Batch tag failed:", error);
        }
        refreshTags();
        // Keep the selection so the same files can be dragged/moved next.
    };

    const sortedFiles = useMemo(
        () => sortFiles(files, sortMode, sortDirection),
        [files, sortMode, sortDirection],
    );

    const selectedFiles = useMemo(
        () => sortedFiles.filter((f) => selectedIds.has(f.id)),
        [sortedFiles, selectedIds],
    );

    // New folder / filters: start with nothing selected.
    useEffect(() => {
        clearSelection();
    }, [rootPath, activeFolder, activeFilter, showUnsorted, clearSelection]);

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
                getFilesForFolder(activeFolder, activeFilter, showUnsorted);
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
                    (activeFilter != null || !inView(oldRelativePath)) &&
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
    }, [rootPath, activeFolder, showUnsorted, activeFilter, getFilesForFolder]);

    // The file view's place follows the list: when files come and go, the
    // index moves with the file on screen (or the next step would skip or
    // repeat one). And an undone delete brings its file back on screen,
    // but only if it lands right next to where the view is now (one file).
    const shownIdRef = useRef<number | null>(null);
    const restoreIds = useRef<number[] | null>(null);
    const [jumpTo, setJumpTo] = useState<{ file: DbFile; dir: "up" | "down"; n: number } | null>(null);
    useEffect(
        () =>
            window.api.onHistoryApplied((a) => {
                if (a.direction === "undo" && !a.error && a.meta?.kind === "delete") {
                    restoreIds.current = a.meta.fileIds;
                }
            }),
        [],
    );
    useEffect(() => {
        if (browseScrollIndex === null) {
            restoreIds.current = null;
            return;
        }
        const shown = shownIdRef.current;
        let at = shown != null ? sortedFiles.findIndex((f) => f.id === shown) : -1;
        if (at >= 0 && at !== browseScrollIndex) setBrowseScrollIndex(at);
        if (at < 0) at = browseScrollIndex;
        const ids = restoreIds.current;
        if (!ids) return;
        const found = ids
            .map((id) => sortedFiles.findIndex((f) => f.id === id))
            .filter((i) => i >= 0);
        if (found.length === 0) return; // the list hasn't caught up yet
        restoreIds.current = null;
        const near = found.filter((i) => i !== at && Math.abs(i - at) <= 1);
        if (near.length === 0) return;
        const to = near[0];
        setBrowseScrollIndex(to);
        setJumpTo((j) => ({ file: sortedFiles[to], dir: to < at ? "up" : "down", n: (j?.n ?? 0) + 1 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sortedFiles]);

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
                    if (folderName === null) setShowUnsorted(true);
                    setView("browse");
                }}
                onFileClick={(file) => showInFolder(rootPath!, file.path)}
                onClose={() => setBrowseScrollIndex(null)}
                onFileChange={(f) => {
                    shownIdRef.current = f.id;
                }}
                jumpTo={jumpTo}
                onCrown={crownAndCompare}
                onPlace={(file) => {
                    startSession({ kind: "file", file, returnTo: "browse" });
                    setView("compare");
                }}
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
                        title={`Give the ${toPlace} file${toPlace === 1 ? "" : "s"} here with fewer than ${PLACEMENT_MATCHES} comparisons their placement matches in Compare, then come back`}
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
                        onDelete={async () => {
                            const preview = await window.api.folderDeletePreview(activeFolder);
                            setFolderDelete({
                                step: "choose",
                                folder: activeFolder,
                                files: preview?.files ?? files.length,
                            });
                        }}
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
                        ref={restoreScroll}
                        onScroll={saveScroll}
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
                    <div
                        ref={restoreScroll}
                        onScroll={saveScroll}
                        className="overflow-y-auto flex-1 select-none"
                    >
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
                        onFolderTagsChanged={reloadFolderTags}
                        selectedFiles={selectedFiles}
                        onExecuteBatchTag={handleExecuteBatchTag}
                    />
                </div>
            )}
            {moveDialog}
            {folderDelete?.step === "choose" && (
                <ConfirmDialog
                    title={`Delete the folder "${folderDelete.folder}"?`}
                    message={
                        folderDelete.files === 0
                            ? "It has no media files in it."
                            : `What should happen to the ${plural(folderDelete.files, "media file")} in it?`
                    }
                    confirmText={folderDelete.files === 0 ? "Delete folder" : "Delete the files"}
                    secondary={
                        folderDelete.files === 0
                            ? undefined
                            : { text: "Move them to Unsorted", onClick: () => chooseFolderDelete("unsort") }
                    }
                    onConfirm={() => chooseFolderDelete("trash")}
                    onCancel={() => setFolderDelete(null)}
                />
            )}
            {folderDelete?.step === "confirm" && (
                <ConfirmDialog
                    title={
                        folderDelete.mode === "unsort"
                            ? `Move the files to Unsorted and delete "${folderDelete.folder}"?`
                            : `Delete "${folderDelete.folder}" and its files?`
                    }
                    message={<FolderDeleteEffects mode={folderDelete.mode} preview={folderDelete.preview} />}
                    confirmText={
                        folderDelete.mode === "unsort"
                            ? "Move files and delete folder"
                            : "Delete folder and files"
                    }
                    onConfirm={confirmFolderDelete}
                    onCancel={() => setFolderDelete(null)}
                />
            )}
            {deleting && (
                <ConfirmDialog
                    title={deleting.length === 1 ? "Delete File" : `Delete ${deleting.length} Files`}
                    message={
                        deleting.length === 1
                            ? `Delete "${deleting[0].filename}"? ⌘Z brings it back until the app quits; then it goes to the Trash.`
                            : `Delete these ${deleting.length} files? ⌘Z brings them back until the app quits; then they go to the Trash.`
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

// "1 file", "3 files"
function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Everything deleting a folder will do, for its confirm.
function FolderDeleteEffects({
    mode,
    preview,
}: {
    mode: "trash" | "unsort";
    preview: {
        files: number;
        otherFiles: number;
        subfolders: number;
        tags: string[];
        metadata: number;
        profileImage: boolean;
    };
}): JSX.Element {
    const lines: string[] = [];
    if (preview.files > 0) {
        lines.push(
            mode === "unsort"
                ? `${plural(preview.files, "media file")} will move to Unsorted. They keep their scores, tags and comparison history.`
                : `${plural(preview.files, "media file")} will be deleted with the folder, scores and tags included.`,
        );
    }
    if (preview.tags.length > 0) {
        lines.push(
            `The folder's ${preview.tags.length === 1 ? "tag" : "tags"} (${preview.tags.join(", ")}) will be removed` +
                (mode === "unsort" && preview.files > 0
                    ? ": the moved files only had them through the folder, so they lose them."
                    : "."),
        );
    }
    if (preview.metadata > 0) {
        lines.push(`Its ${plural(preview.metadata, "metadata field")} will be deleted.`);
    }
    if (preview.profileImage) lines.push("Its profile image will be removed.");
    if (preview.otherFiles > 0 || preview.subfolders > 0) {
        const parts = [
            preview.otherFiles > 0 ? `${plural(preview.otherFiles, "other file")} (not media)` : null,
            preview.subfolders > 0 ? plural(preview.subfolders, "subfolder") : null,
        ].filter(Boolean);
        lines.push(`${parts.join(" and ")} in it will be deleted with the folder.`);
    }
    lines.push("⌘Z brings it all back until the app quits; then it goes to the Trash.");
    return (
        <>
            <ul className="list-disc space-y-1 pl-4">
                {lines.map((l) => (
                    <li key={l}>{l}</li>
                ))}
            </ul>
            {(preview.tags.length > 0 || preview.metadata > 0 || preview.profileImage) && (
                <p className="mt-2 text-neutral-500">
                    The folder's tags, metadata and profile image can't be brought back.
                </p>
            )}
        </>
    );
}
