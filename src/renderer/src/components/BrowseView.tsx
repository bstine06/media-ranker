import { useEffect, useState } from "react";
import type { DbFile } from "../types";
import { toThumbnailUrl } from "../lib/media";
import MediaTile from "./MediaTile";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FolderMetadata {
    profileImage?: string;
    fields: { key: string; value: string }[];
}

const URL_RE = /^https?:\/\//i;

// ─── BrowseView ───────────────────────────────────────────────────────────────

export default function BrowseView({
    files,
    rootPath,
    activeFolder,
    onFolderRenamed,
}: {
    files: DbFile[];
    rootPath: string;
    activeFolder: string | null;
    onFolderRenamed: (oldRelPath: string, newRelPath: string) => void;
}): JSX.Element {
    const [metadata, setMetadata] = useState<FolderMetadata | null>(null);
    const [editingMetadata, setEditingMetadata] = useState(false);
    const [draftProfileImage, setDraftProfileImage] = useState<string | undefined>();
    const [draftName, setDraftName] = useState<string>("");
    const [renameError, setRenameError] = useState<string | null>(null);

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

    const handleEditStart = (current: FolderMetadata) => {
        setDraftProfileImage(current.profileImage);
        setDraftName(activeFolder ? activeFolder.split("/").pop()! : "");
        setRenameError(null);
        setEditingMetadata(true);
    };

    const handleMetadataSave = async (updated: FolderMetadata, newName: string) => {
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
    };

    const handleTileClick = (file: DbFile) => {
        setDraftProfileImage((prev) =>
            prev === file.content_hash ? undefined : file.content_hash
        );
    };

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
                <h2 className="text-sm font-medium text-neutral-300">
                    {activeFolder ?? "All Files"}
                </h2>
                <span className="text-xs text-neutral-600">{files.length} files</span>
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
            ) : (
                <div className="relative flex-1 overflow-hidden">
                    <div
                        className="grid-media overflow-y-auto overflow-x-hidden p-4 h-full"
                        style={{ scrollbarGutter: "stable" }}
                    >
                        {files.map((file) => (
                            <MediaTile key={file.id} file={file} rootPath={rootPath} />
                        ))}
                    </div>

                    {editingMetadata && (
                        <div
                            className="absolute inset-0 z-10"
                            onClick={(e) => {
                                const grid = e.currentTarget.previousElementSibling as HTMLElement;
                                const children = Array.from(grid.children) as HTMLElement[];

                                for (const child of children) {
                                    const rect = child.getBoundingClientRect();
                                    if (
                                        e.clientX >= rect.left &&
                                        e.clientX <= rect.right &&
                                        e.clientY >= rect.top &&
                                        e.clientY <= rect.bottom
                                    ) {
                                        const index = children.indexOf(child);
                                        if (index >= 0 && index < files.length) {
                                            handleTileClick(files[index]);
                                        }
                                        break;
                                    }
                                }
                                e.stopPropagation();
                            }}
                        >
                            <div
                                className="grid-media p-4 h-full pointer-events-none"
                                style={{ scrollbarGutter: "stable" }}
                            >
                                {files.map((file) => (
                                    <div
                                        key={file.id}
                                        className={`rounded-lg transition-all ${
                                            draftProfileImage === file.content_hash
                                                ? "ring-2 ring-blue-500 bg-blue-500/10"
                                                : "ring-1 ring-transparent"
                                        }`}
                                    >
                                        {draftProfileImage === file.content_hash && (
                                            <div className="relative h-full">
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
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
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
            <div className={`flex items-center justify-center bg-neutral-800 text-neutral-600 text-xs ${className}`}>
                {isVideo ? "▶" : "?"}
            </div>
        );
    }
    return <img src={thumbUrl} alt="" className={`object-cover ${className}`} />;
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