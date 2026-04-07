import { useEffect, useRef, useState } from "react";
import type { DbFile, File } from "../types";
import { toThumbnailUrl, toMediaUrl } from "../lib/media";
import MediaTile from "./MediaTile";
import HoverPreview from "./HoverPreview";
import { useHoverPreview } from "../hooks/useHoverPreview";
import { useStatus } from "../contexts/StatusContext";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FolderMetadata {
    profileImage?: string;
    fields: { key: string; value: string }[];
}

const URL_RE = /^https?:\/\//i;

type ViewMode = "grid" | "rows";
type SortMode = "default" | "rank";

function TagAllButton({
    activeFolder,
    allTags,
    onDone,
}: {
    activeFolder: string;
    allTags: string[];
    onDone: () => void;
}): JSX.Element {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [applying, setApplying] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 0);
    }, [open]);

    const suggestions = search.trim()
        ? allTags.filter((t) => t.toLowerCase().includes(search.toLowerCase()))
        : [];

    const apply = async (tag: string) => {
        if (!tag.trim()) return;
        setApplying(true);
        await window.api.addTagToFolder(activeFolder, tag.trim().toLowerCase());
        setApplying(false);
        setOpen(false);
        setSearch("");
        onDone();
    };

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
                Tag all
            </button>
        );
    }

    return (
        <div className="relative flex items-center gap-1.5">
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") apply(search);
                        if (e.key === "Escape") {
                            setOpen(false);
                            setSearch("");
                        }
                    }}
                    placeholder="Tag name…"
                    disabled={applying}
                    className="w-32 rounded-md bg-neutral-800 border border-neutral-700 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:ring-1 focus:ring-neutral-600"
                />
                {suggestions.length > 0 && (
                    <div className="absolute right-0 top-full mt-1 w-40 bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden z-10 shadow-lg max-h-40 overflow-y-auto">
                        {suggestions.slice(0, 20).map((tag) => (
                            <button
                                key={tag}
                                onMouseDown={() => apply(tag)}
                                className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <button
                onClick={() => apply(search)}
                disabled={applying || !search.trim()}
                className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 text-neutral-200 rounded px-2 py-1 transition-colors"
            >
                {applying ? "…" : "Apply"}
            </button>
            <button
                onClick={() => {
                    setOpen(false);
                    setSearch("");
                }}
                className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
            >
                Cancel
            </button>
        </div>
    );
}

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

    // Persisted across folder changes
    const [viewMode, setViewMode] = useState<ViewMode>("grid");
    const [sortMode, setSortMode] = useState<SortMode>("default");

    const { setStatus, resetStatus } = useStatus();

    useEffect(() => {
        if (!activeFolder) {
            setMetadata(null);
            setEditingMetadata(false);
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
        e.preventDefault()  // also move this to the top
        setStatus("Adding files...")
        const paths = Array.from(e.dataTransfer.files).map(
            (f) => (f as unknown as { path: string }).path,
        )
        await window.api.moveFilesTo(paths, [rootPath, activeFolder].join("/"))
        await new Promise(r => setTimeout(r, 1000))
        resetStatus()
    }

    const handleEditStart = (current: FolderMetadata) => {
        setDraftProfileImage(current.profileImage);
        setDraftName(activeFolder ? activeFolder.split("/").pop()! : "");
        setRenameError(null);
        setEditingMetadata(true);
    };

    const handleMetadataSave = async (
        updated: FolderMetadata,
        newName: string,
    ) => {
        if (!activeFolder) return;

        const currentName = activeFolder.split("/").pop()!;

        if (newName.trim() === "") {
            setRenameError("Folder name cannot be empty");
            return;
        }

        if (newName !== currentName) {
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
            onDragOver={(e) => e.preventDefault()} // must prevent default to allow drop
            onDragEnter={(e) => e.preventDefault()} // optional but good practice
            onDrop={handleDrop}
        >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
                <h2 className="text-sm font-medium text-neutral-300">
                    {activeFolder ?? "All Files"}
                </h2>
                <div className="flex items-center gap-3">
                    {/* Tag all files in folder */}
                    {activeFolder && (
                        <TagAllButton
                            activeFolder={activeFolder}
                            allTags={allTags}
                            onDone={onTagsChanged}
                        />
                    )}
                    {/* Sort toggle */}
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

                    {/* View mode toggle */}
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
                            {/* Grid icon */}
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
                            {/* List icon */}
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

            {activeFolder && (
                <MetadataView
                    folderName={activeFolder.split("/").pop()!}
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
                />
            )}

            {files.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                    No media found in this folder.
                </div>
            ) : viewMode === "grid" ? (
                <div
                    className="flex-1 overflow-y-auto overflow-x-hidden"
                    style={{
                        scrollbarGutter: "stable",
                    }}
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
                                <MediaTile file={file} rootPath={rootPath} />
                                {draftProfileImage === file.content_hash && (
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
                            onClick={() => onInspectFile(file)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── BrowseRow ────────────────────────────────────────────────────────────────

function BrowseRow({
    file,
    rank,
    rootPath,
    onClick,
}: {
    file: DbFile;
    rank: number | null;
    rootPath: string;
    onClick: () => void;
}): JSX.Element {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const fullUrl = toMediaUrl(rootPath, file.path);

    const {
        elementRef,
        layout,
        preview,
        handleMouseEnter,
        handleMouseLeave,
        handleNaturalSize,
    } = useHoverPreview();

    useEffect(() => {
        window.api.getThumbnailPath(file.content_hash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [file.content_hash]);

    const rankColor =
        rank === 1
            ? "text-yellow-400"
            : rank === 2
              ? "text-neutral-300"
              : rank === 3
                ? "text-amber-600"
                : "text-neutral-600";

    return (
        <>
            <div
                ref={elementRef as React.RefObject<HTMLDivElement>}
                className="flex items-center gap-4 border-b border-neutral-800/50 px-5 py-3 transition-colors cursor-default border-l-2 border-l-transparent hover:border-l-neutral-600 hover:bg-neutral-900/50"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onClick={onClick}
            >
                {rank !== null && (
                    <span
                        className={`w-8 shrink-0 text-right text-sm font-bold tabular-nums ${rankColor}`}
                    >
                        {rank}
                    </span>
                )}

                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-neutral-800">
                    {thumbUrl ? (
                        <img
                            src={thumbUrl}
                            alt={file.filename}
                            className="h-full w-full object-cover"
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center text-neutral-600 text-xs">
                            {file.media_type === "video" ? "▶" : "?"}
                        </div>
                    )}
                </div>

                <div className="flex flex-1 flex-col min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                        {file.filename}
                    </p>
                    <p className="text-xs text-neutral-500">
                        {file.path.split("/")[0]}
                    </p>
                </div>

                <div className="flex flex-col items-end shrink-0">
                    <span className="text-sm font-semibold tabular-nums text-white">
                        {Math.round(file.elo_score)}
                    </span>
                    <span className="text-xs text-neutral-600">
                        {file.comparison_count} comparisons
                    </span>
                </div>

                {file.media_type !== "photo" && (
                    <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
                        {file.media_type === "video" ? "▶" : "GIF"}
                    </span>
                )}
            </div>

            {preview && layout && (
                <HoverPreview
                    file={file}
                    fullUrl={fullUrl}
                    x={layout.x}
                    y={layout.y}
                    width={layout.width}
                    height={layout.height}
                    onNaturalSize={handleNaturalSize}
                />
            )}
        </>
    );
}

// ─── ThumbnailImage ───────────────────────────────────────────────────────────

function ThumbnailImage({
    contentHash,
    className,
    isVideo,
}: {
    contentHash: string;
    className?: string;
    isVideo?: boolean;
}) {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);

    useEffect(() => {
        window.api.getThumbnailPath(contentHash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [contentHash]);

    if (!thumbUrl) {
        return (
            <div
                className={`flex items-center justify-center bg-neutral-800 text-neutral-600 text-xs ${className}`}
            >
                {isVideo ? "▶" : "?"}
            </div>
        );
    }
    return (
        <img src={thumbUrl} alt="" className={`object-cover ${className}`} />
    );
}

// ─── MetadataView ─────────────────────────────────────────────────────────────

export function MetadataView({
    folderName,
    metadata,
    files,
    editing,
    draftProfileImage,
    draftName,
    renameError,
    onDraftNameChange,
    onEditStart,
    onSave,
    onCancel,
}: {
    folderName: string;
    metadata: FolderMetadata;
    files: DbFile[];
    editing: boolean;
    draftProfileImage: string | undefined;
    draftName: string;
    renameError: string | null;
    onDraftNameChange: (name: string) => void;
    onEditStart: (draft: FolderMetadata) => void;
    onSave: (updated: FolderMetadata, newName: string) => void;
    onCancel: () => void;
}): JSX.Element {
    const [draftFields, setDraftFields] = useState<FolderMetadata["fields"]>(
        [],
    );

    useEffect(() => {
        if (editing) setDraftFields(metadata.fields);
    }, [editing]);

    const handleSave = () => {
        onSave(
            {
                profileImage: draftProfileImage,
                fields: draftFields.filter(
                    (f) => f.key.trim() || f.value.trim(),
                ),
            },
            draftName,
        );
    };

    const addField = () =>
        setDraftFields((f) => [...f, { key: "", value: "" }]);

    const updateField = (i: number, part: "key" | "value", val: string) =>
        setDraftFields((fields) => {
            const next = [...fields];
            next[i] = { ...next[i], [part]: val };
            return next;
        });

    const removeField = (i: number) =>
        setDraftFields((fields) => fields.filter((_, j) => j !== i));

    const activeHash = editing ? draftProfileImage : metadata.profileImage;
    const profileFile = activeHash
        ? files.find((f) => f.content_hash === activeHash)
        : null;
    const activeFields = editing
        ? draftFields
        : metadata.fields.filter((f) => f.key || f.value);

    return (
        <div className="border-b border-neutral-800 px-5 py-4">
            <div className="flex gap-5">
                {/* Avatar */}
                <div className="shrink-0">
                    <div
                        className={`w-20 h-20 rounded-xl overflow-hidden ring-1 bg-neutral-800 flex items-center justify-center ${
                            editing ? "ring-neutral-600" : "ring-neutral-700"
                        }`}
                        onClick={() => !editing && onEditStart(metadata)}
                    >
                        {profileFile ? (
                            <ThumbnailImage
                                contentHash={profileFile.content_hash}
                                isVideo={profileFile.media_type === "video"}
                                className="w-full h-full"
                            />
                        ) : (
                            <svg
                                className="w-7 h-7 text-neutral-600"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                                />
                            </svg>
                        )}
                    </div>
                    {editing && (
                        <p className="mt-1.5 text-[10px] text-neutral-600 text-center w-20 leading-tight">
                            {draftProfileImage
                                ? "click to clear"
                                : "click a tile"}
                        </p>
                    )}
                </div>

                {/* Right column */}
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    {/* Folder name */}
                    {editing ? (
                        <div className="flex flex-col gap-1 mb-0.5">
                            <input
                                type="text"
                                value={draftName}
                                onChange={(e) =>
                                    onDraftNameChange(e.target.value)
                                }
                                className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm font-semibold text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600 w-full"
                            />
                            {renameError && (
                                <p className="text-[10px] text-red-400">
                                    {renameError}
                                </p>
                            )}
                        </div>
                    ) : (
                        <p className="text-sm font-semibold text-neutral-200 mb-0.5 truncate">
                            {folderName}
                        </p>
                    )}

                    {/* Fields */}
                    {activeFields.map((field, i) =>
                        editing ? (
                            <div key={i} className="flex items-center gap-2">
                                <input
                                    type="text"
                                    placeholder="key"
                                    value={field.key}
                                    onChange={(e) =>
                                        updateField(i, "key", e.target.value)
                                    }
                                    className="w-24 shrink-0 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-400 placeholder-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-600"
                                />
                                <input
                                    type="text"
                                    placeholder="value"
                                    value={field.value}
                                    onChange={(e) =>
                                        updateField(i, "value", e.target.value)
                                    }
                                    className="flex-1 min-w-0 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-300 placeholder-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-600"
                                />
                                <button
                                    onClick={() => removeField(i)}
                                    className="text-neutral-700 hover:text-neutral-400 transition-colors shrink-0"
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
                                            d="M6 18L18 6M6 6l12 12"
                                        />
                                    </svg>
                                </button>
                            </div>
                        ) : (
                            <div key={i} className="flex items-baseline gap-3">
                                <span className="text-xs text-neutral-500 text-right w-24 shrink-0 truncate">
                                    {field.key}
                                </span>
                                {URL_RE.test(field.value) ? (
                                    <button
                                        className="text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors truncate"
                                        onClick={() =>
                                            window.api.openExternal(field.value)
                                        }
                                    >
                                        {field.value}
                                    </button>
                                ) : (
                                    <span className="text-xs text-neutral-400 truncate">
                                        {field.value}
                                    </span>
                                )}
                            </div>
                        ),
                    )}

                    {editing && (
                        <button
                            onClick={addField}
                            className="mt-0.5 self-start text-xs text-neutral-600 hover:text-neutral-400 transition-colors flex items-center gap-1"
                        >
                            <svg
                                className="w-3 h-3"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 4.5v15m7.5-7.5h-15"
                                />
                            </svg>
                            Add field
                        </button>
                    )}

                    <div className="flex items-center gap-2 mt-auto pt-1.5">
                        {editing ? (
                            <>
                                <button
                                    onClick={handleSave}
                                    className="text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-3 py-1 transition-colors"
                                >
                                    Save
                                </button>
                                <button
                                    onClick={onCancel}
                                    className="text-xs text-neutral-600 hover:text-neutral-400 px-2 py-1 transition-colors"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => onEditStart(metadata)}
                                className="text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 rounded px-3 py-1 transition-colors"
                            >
                                Edit
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
