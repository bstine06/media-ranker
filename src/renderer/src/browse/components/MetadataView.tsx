// ─── MetadataView ─────────────────────────────────────────────────────────────

import { DbFile } from "@renderer/shared/types/types";
import { FolderMetadata, URL_RE } from "../types/browserTypes";
import { useEffect, useState } from "react";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";

export default function MetadataView({
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
    allTags,
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
    allTags: string[];
}): JSX.Element {
    const [draftFields, setDraftFields] = useState<FolderMetadata["fields"]>(
        [],
    );

    // folder tags
    const [folderMetadata, setFolderMetadata] =
        useState<FolderMetadata | null>(null);
    const [folderTagInput, setFolderTagInput] = useState("");

    useEffect(() => {
        setFolderMetadata(metadata);
    }, [metadata])

    useEffect(() => {
        if (editing) setDraftFields(metadata.fields);
    }, [editing]);

    const handleSave = () => {
        onSave(
            {
                profileImage: draftProfileImage,
                fields: draftFields
                    ? draftFields.filter((f) => f.key.trim() || f.value.trim())
                    : [],
            },
            draftName,
        );
    };

    const addField = () =>
        setDraftFields((f) => [...(f ?? []), { key: "", value: "" }]);

    const updateField = (i: number, part: "key" | "value", val: string) =>
        setDraftFields((fields) => {
            const next = [...(fields ?? [])];
            next[i] = { ...next[i], [part]: val };
            return next;
        });

    const removeField = (i: number) =>
        setDraftFields((fields) => (fields ?? []).filter((_, j) => j !== i));

    const activeHash = editing ? draftProfileImage : metadata.profileImage;
    const profileFile = activeHash
        ? files.find((f) => f.content_hash === activeHash)
        : null;
    const activeFields = editing
        ? draftFields
        : (metadata.fields ?? []).filter((f) => f.key || f.value);


    const handleAddFolderTag = async (tag: string) => {
        if (!folderName || !tag.trim()) return;
        const existing = folderMetadata ?? {};
        const currentTags = existing.tags ?? [];
        if (currentTags.includes(tag)) return;
        const updatedTags = [...currentTags, tag];
        // Merge write — never clobbers other fields that may exist
        const onDisk =
            (await window.api.readFolderMetadata(folderName)) ?? {};
        await window.api.writeFolderMetadata(folderName, {
            ...onDisk,
            tags: updatedTags,
        });
        await window.api.addTagToFolder(folderName, tag.trim().toLowerCase());
        setFolderMetadata({ ...existing, tags: updatedTags });
        setFolderTagInput("");
    };

    const handleRemoveFolderTag = async (tag: string) => {
        if (!folderName) return;
        const existing = folderMetadata ?? {};
        const updatedTags = (existing.tags ?? []).filter((t) => t !== tag);
        const onDisk =
            (await window.api.readFolderMetadata(folderName)) ?? {};
        await window.api.writeFolderMetadata(folderName, {
            ...onDisk,
            tags: updatedTags,
        });
        setFolderMetadata({ ...existing, tags: updatedTags });
    };

    const folderTags = folderMetadata?.tags ?? [];
    const filteredTagSuggestions = allTags.filter(
        (t) =>
            !folderTags.includes(t) &&
            t.toLowerCase().includes(folderTagInput.toLowerCase()),
    );

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

                {/* Center column */}
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
                    {activeFields &&
                        activeFields.map((field, i) =>
                            editing ? (
                                <div
                                    key={i}
                                    className="flex items-center gap-2"
                                >
                                    <input
                                        type="text"
                                        placeholder="key"
                                        value={field.key}
                                        onChange={(e) =>
                                            updateField(
                                                i,
                                                "key",
                                                e.target.value,
                                            )
                                        }
                                        className="w-24 shrink-0 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-400 placeholder-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-600"
                                    />
                                    <input
                                        type="text"
                                        placeholder="value"
                                        value={field.value}
                                        onChange={(e) =>
                                            updateField(
                                                i,
                                                "value",
                                                e.target.value,
                                            )
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
                                <div
                                    key={i}
                                    className="flex items-baseline gap-3"
                                >
                                    <span className="text-xs text-neutral-500 text-right w-24 shrink-0 truncate">
                                        {field.key}
                                    </span>
                                    {URL_RE.test(field.value) ? (
                                        <button
                                            className="text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors truncate"
                                            onClick={() =>
                                                window.api.openExternal(
                                                    field.value,
                                                )
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
                <div className="mt-2 flex flex-col gap-2">
                    {/* Current tags as chips */}
                    {folderTags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {folderTags.map((tag) => (
                                <span
                                    key={tag}
                                    className="flex items-center gap-1 text-xs bg-neutral-800 text-neutral-300 rounded px-2 py-0.5"
                                >
                                    {tag}
                                    <button
                                        onClick={() =>
                                            handleRemoveFolderTag(tag)
                                        }
                                        className="text-neutral-500 hover:text-neutral-300 transition-colors"
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Input + autocomplete suggestions */}
                    <div className="relative">
                        <input
                            type="text"
                            value={folderTagInput}
                            onChange={(e) => setFolderTagInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    handleAddFolderTag(folderTagInput.trim());
                                }
                            }}
                            placeholder="Add tag..."
                            className="w-full bg-neutral-800 text-neutral-300 text-xs rounded px-2.5 py-1.5 outline-none placeholder:text-neutral-600 focus:ring-1 focus:ring-neutral-600"
                        />
                        {folderTagInput &&
                            filteredTagSuggestions.length > 0 && (
                                <div className="absolute top-full mt-1 left-0 right-0 bg-neutral-800 border border-neutral-700 rounded shadow-lg z-10 max-h-40 overflow-y-auto">
                                    {filteredTagSuggestions.map((tag) => (
                                        <button
                                            key={tag}
                                            onClick={() =>
                                                handleAddFolderTag(tag)
                                            }
                                            className="w-full text-left text-xs text-neutral-300 px-2.5 py-1.5 hover:bg-neutral-700 transition-colors"
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                            )}
                    </div>
                </div>
            </div>
        </div>
    );
}
