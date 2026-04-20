import { useCallback, useEffect, useMemo, useState } from "react";
import type {
    DbFile,
    DbFolderMetadata,
    DbTag,
    View,
} from "../../shared/types/types";
import MediaTile from "./MediaTile";
import { useStatus } from "../../contexts/StatusContext";
import { SortMode, ViewMode } from "../types/browserTypes";
import BrowseRow from "./BrowseRow";
import MetadataView from "./MetadataView";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { SlotResolver } from "@renderer/hooks/useScrollSlots";
import ScrollView from "@renderer/components/ScrollView";
import { showInFolder } from "@renderer/lib/filesystem";

// ─── BrowseView ───────────────────────────────────────────────────────────────

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
    const [metadataFields, setMetadataFields] = useState<string[]>([]); // for autocomplete
    const [metadata, setMetadata] = useState<DbFolderMetadata | null>(null);
    const [editingMetadata, setEditingMetadata] = useState(false);
    const [draftProfileImage, setDraftProfileImage] = useState<
        string | undefined
    >();
    const [draftName, setDraftName] = useState<string>("");
    const [renameError, setRenameError] = useState<string | null>(null);

    const [viewMode, setViewMode] = useState<ViewMode>("grid");
    const [sortMode, setSortMode] = useState<SortMode>("alphabetical");
    const [sortDirection, setSortDirection] = useState<"up" | "down">("down");
    const [folderTags, setFolderTags] = useState<DbTag[]>([]);

    const [files, setFiles] = useState<DbFile[]>([]);
    const [browseScrollIndex, setBrowseScrollIndex] = useState<number | null>(
        null,
    );

    const { setStatus, resetStatus } = useStatus();
    const {
        rootPath,
        activeFolder,
        setActiveFolder,
        handleFolderMetadataChanged,
    } = useFolders();
    const { refreshTags, activeTags, tagMode } = useTags();
    const { tileSize } = useSettings();

    //get files on mount, clear browseScroll
    useEffect(() => {
        getFilesForFolder(activeFolder, activeTags, tagMode);
        setBrowseScrollIndex(null);
    }, [rootPath, activeFolder, activeTags, tagMode]);

    const getFilesForFolder = useCallback(
        async (
            folder: string | null,
            tags: Set<number>,
            tagMode: "and" | "or",
        ) => {
            setActiveFolder(folder);
            const result: DbFile[] = folder
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
                console.log(dbFolder?.profile_image_hash);
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
        const paths = Array.from(e.dataTransfer.files).map(
            (f) => (f as unknown as { path: string }).path,
        );
        await window.api.moveFilesTo(paths, [rootPath, activeFolder].join("/"));
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

        // Save each field to DB
        await Promise.all(
            updatedFields.map((f) =>
                window.api.setFolderMetadataField(
                    activeFolder,
                    f.key,
                    f.value,
                    f.type,
                ),
            ),
        );

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

    const handleTileClick = (file: DbFile, index: number) => {
        console.log("handle tile click", index)
        editingMetadata
            ? setDraftProfileImage((prev) =>
                  prev === file.content_hash ? undefined : file.content_hash,
              )
            : setBrowseScrollIndex(index);
    };

    const sortedFiles = useMemo(() => {
        return [...files].sort((a, b) => {
            let d = 0;
            switch (sortMode) {
                case "rank": d = b.elo_score - a.elo_score; break;
                case "fileSize": d = b.size - a.size; break;
                case "alphabetical": default: d = a.filename.localeCompare(b.filename);
            }
            return sortDirection === "down" ? d : d*(-1);
        });
    }, [files, sortMode, sortDirection]);

    useEffect(() => {
        const handleAdded = window.api.onMediaAdded(
            ({ relativePath, hash, mediaType }) => {
                // only matters if it belongs to the active folder (or we're in all-files view)
                const folderPath = relativePath
                    .split("/")
                    .slice(0, -1)
                    .join("/");
                if (activeFolder && folderPath !== activeFolder) return;
                if (rootPath)
                    getFilesForFolder(activeFolder, activeTags, tagMode); // still reload for adds — need full DbFile
            },
        );

        const handleRemoved = window.api.onMediaRemoved(({ relativePath }) => {
            // always remove from state regardless of which folder is active
            setFiles((prev) => prev.filter((f) => f.path !== relativePath));
        });

        const handleRenamed = window.api.onMediaRenamed(
            ({ oldRelativePath, relativePath }) => {
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

        return () => {
            handleAdded();
            handleRemoved();
            handleRenamed();
        };
    }, [rootPath, activeFolder, setActiveFolder]);

    const resolver: SlotResolver = useCallback(
        async (dir, cursor) => {
            console.log(browseScrollIndex);
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
        return (
            <ScrollView
                initialFile={sortedFiles[browseScrollIndex]}
                resolver={resolver}
                active={active}
                rootPath={rootPath!}
                folderProfileHash={folderProfileHash}
                onFolderClick={(folderName) => {
                    setActiveFolder(folderName);
                    setView("browse");
                }}
                onFileClick={(file) => showInFolder(rootPath!, file.path)}
                onClose={() => setBrowseScrollIndex(null)}
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
                <h2 className="text-sm font-medium text-neutral-300">
                    {activeFolder ?? "All Files"}
                </h2>
                <div className="flex items-center gap-3">
                    <div className="flex gap-2">
                        <button
                            onClick={() => setSortMode("alphabetical")}
                            title="Sort alphabetically"
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortMode === "alphabetical"
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
                                    d="M3 4.5h14.25M3 9h9.75M3 13.5h9.75M3 18h9.75"
                                />
                            </svg>
                            A-Z
                        </button>

                        <button
                            onClick={() => setSortMode("rank")}
                            title="Sort by rank"
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortMode === "rank"
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
                                    d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12"
                                />
                            </svg>
                            Rank
                        </button>

                        <button
                            onClick={() => setSortMode("fileSize")}
                            title="Sort by file size"
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortMode === "fileSize"
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
                                    d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5"
                                />
                            </svg>
                            Size
                        </button>
                    </div>

                    <div className="flex gap-2">
                        <button
                            onClick={() => setSortDirection("up")}
                            title="Sort ascending"
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortDirection === "up"
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
                                    d="M4.5 15.75l7.5-7.5 7.5 7.5"
                                />
                            </svg>
                        </button>

                        <button
                            onClick={() => setSortDirection("down")}
                            title="Sort descending"
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                                sortDirection === "down"
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
                                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                />
                            </svg>
                        </button>
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

                    <span className="text-xs text-neutral-600">
                        {files.length} files
                    </span>
                </div>
            </div>

            {/* Body */}
            <div className="flex flex-1 flex-col overflow-hidden">
                {activeFolder && (
                    <MetadataView
                        folderName={activeFolder}
                        fields={fields}
                        profileImage={folderProfileHash}
                        metadataFields={metadataFields}
                        folderTags={folderTags}
                        onAddFolderTag={handleAddFolderTag}
                        onRemoveFolderTag={handleRemoveFolderTag}
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
                        className="flex-1 overflow-y-auto overflow-x-hidden"
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
                                        draftProfileImage === file.content_hash
                                            ? "ring-2 ring-blue-500 bg-blue-500/10"
                                            : "ring-1 ring-transparent"
                                    }`}
                                    onClick={() => handleTileClick(file, i)}
                                >
                                    <MediaTile
                                        file={file}
                                        rootPath={rootPath!}
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
                    <div className="overflow-y-auto flex-1">
                        {sortedFiles.map((file, index) => (
                            <BrowseRow
                                key={file.id}
                                file={file}
                                rank={sortMode === "rank" ? index + 1 : null}
                                rootPath={rootPath!}
                                onClick={() => handleTileClick(file, index)}
                                isSelected={
                                    draftProfileImage === file.content_hash
                                }
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
