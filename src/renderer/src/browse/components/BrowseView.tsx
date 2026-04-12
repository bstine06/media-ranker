import { useEffect, useState } from "react";
import type { DbFile } from "../../shared/types/types";
import MediaTile from "./MediaTile";
import { useStatus } from "../../contexts/StatusContext";
import { FolderMetadata, SortMode, ViewMode } from "../types/browserTypes";
import BrowseRow from "./BrowseRow";
import MetadataView from "./MetadataView";

// ─── BrowseView ───────────────────────────────────────────────────────────────

export default function BrowseView({
    files,
    rootPath,
    activeFolder,
    onFolderRenamed,
    onInspectFile,
    allTags,
    onTagsChanged,
}: {
    files: DbFile[];
    rootPath: string;
    activeFolder: string | null;
    onFolderRenamed: (oldRelPath: string, newRelPath: string) => void;
    onInspectFile: (file: DbFile) => void;
    allTags: string[];
    onTagsChanged: () => void;
}): JSX.Element {
    const [metadata, setMetadata] = useState<FolderMetadata | null>(null);
    const [editingMetadata, setEditingMetadata] = useState(false);
    const [draftProfileImage, setDraftProfileImage] = useState<
        string | undefined
    >();
    const [draftName, setDraftName] = useState<string>("");
    const [renameError, setRenameError] = useState<string | null>(null);

    const [viewMode, setViewMode] = useState<ViewMode>("grid");
    const [sortMode, setSortMode] = useState<SortMode>("default");

    const { setStatus, resetStatus } = useStatus();

    useEffect(() => {
        if (!activeFolder) {
            setMetadata(null);
            setEditingMetadata(false);
            setRenameError(null);
            return;
        }

        const load = async () => {
            try {
                const raw = await window.api.readFolderMetadata(activeFolder);
                setMetadata(raw ?? { fields: [] });
            } catch {
                setMetadata({ fields: [] });
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

    const handleEditStart = (current: FolderMetadata) => {
        setDraftProfileImage(current.profileImage);
        setDraftName(activeFolder ?? "");
        setRenameError(null);
        setEditingMetadata(true);
    };

    const handleMetadataSave = async (
        updated: FolderMetadata,
        newName: string,
    ) => {
        if (!activeFolder) return;

        if (newName.trim() === "") {
            setRenameError("Folder name cannot be empty");
            return;
        }

        if (newName !== activeFolder) {
            const result = await window.api.renameFolder(activeFolder, newName);
            if (!result.ok) {
                setRenameError(result.error);
                return;
            }
            await window.api.writeFolderMetadata(result.newRelPath, updated);
            setMetadata(updated);
            setRenameError(null);
            setEditingMetadata(false);
            onFolderRenamed(activeFolder, result.newRelPath);
        } else {
            await window.api.writeFolderMetadata(activeFolder, updated);
            setMetadata(updated);
            setRenameError(null);
            setEditingMetadata(false);
        }

        setDraftProfileImage(undefined);
    };

    const handleTileClick = (file: DbFile) => {
        editingMetadata
            ? setDraftProfileImage((prev) =>
                  prev === file.content_hash ? undefined : file.content_hash,
              )
            : onInspectFile(file);
    };

    const sortedFiles = [...files].sort((a, b) =>
        sortMode === "rank"
            ? b.elo_score - a.elo_score
            : a.filename.localeCompare(b.filename),
    );

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
                    <button
                        onClick={() =>
                            setSortMode((m) =>
                                m === "default" ? "rank" : "default",
                            )
                        }
                        title={
                            sortMode === "rank"
                                ? "Sorted by rank — click to reset"
                                : "Sort by rank"
                        }
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
                        {sortMode === "rank" ? "Ranked" : "Rank"}
                    </button>

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
                        metadata={metadata ?? { fields: [] }}
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
                        allTags={allTags}
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
                        <div className="grid-media p-4">
                            {sortedFiles.map((file) => (
                                <div
                                    key={file.id}
                                    className={`relative cursor-pointer rounded-lg overflow-hidden transition-all ${
                                        draftProfileImage === file.content_hash
                                            ? "ring-2 ring-blue-500 bg-blue-500/10"
                                            : "ring-1 ring-transparent"
                                    }`}
                                    onClick={() => handleTileClick(file)}
                                >
                                    <MediaTile
                                        file={file}
                                        rootPath={rootPath}
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
                                rootPath={rootPath}
                                onClick={() =>
                                    editingMetadata
                                        ? setDraftProfileImage((prev) =>
                                              prev === file.content_hash
                                                  ? undefined
                                                  : file.content_hash,
                                          )
                                        : onInspectFile(file)
                                }
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
