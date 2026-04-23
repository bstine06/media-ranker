// ─── MetadataView ─────────────────────────────────────────────────────────────

import { DbFile, DbTag } from "@renderer/shared/types/types";
import { URL_RE } from "../types/browserTypes";
import { useEffect, useMemo, useState } from "react";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { useTags } from "@renderer/contexts/TagsContext";
import { TagPill } from "@renderer/components/TagPill";

type FieldEntry = { key: string; value: string; type: string };

export default function MetadataView({
    folderName,
    files,
    editing,
    draftProfileImage,
    draftName,
    renameError,
    onDraftNameChange,
    onCancel,
    fields,
    profileImage,
    metadataFields,
    onEditStart,
    onSave,
}: {
    folderName: string;
    files: DbFile[];
    editing: boolean;
    draftProfileImage: string | undefined;
    draftName: string;
    renameError: string | null;
    onDraftNameChange: (name: string) => void;
    onCancel: () => void;
    fields: { key: string; value: string; type: string }[];
    profileImage: string | null;
    metadataFields: string[]; // for autocomplete
    onEditStart: () => void;
    onSave: (
        updatedFields: { key: string; value: string; type: string }[],
        newName: string,
    ) => void;
}): JSX.Element {
    const [draftFields, setDraftFields] = useState<FieldEntry[]>([]);

    useEffect(() => {
        if (editing) setDraftFields(fields);
    }, [editing]);

    const handleSave = () => {
        onSave(
            draftFields
                ? draftFields.filter((f) => f.key.trim() || f.value.trim())
                : [],
            draftName,
        );
    };

    const addField = () =>
        setDraftFields((f) => [
            ...(f ?? []),
            { key: "", value: "", type: "string" },
        ]);

    const updateField = (
        i: number,
        part: "key" | "value" | "type",
        val: string,
    ) =>
        setDraftFields((fields) => {
            const next = [...(fields ?? [])];
            next[i] = { ...next[i], [part]: val };
            return next;
        });

    const removeField = (i: number) =>
        setDraftFields((fields) => (fields ?? []).filter((_, j) => j !== i));

    const activeHash = editing ? draftProfileImage : profileImage;

    const activeFields = editing
        ? draftFields
        : fields.filter((f) => f.key || f.value);

    return (
        <div className="border-b border-neutral-800 px-5 py-4">
            <div className="flex gap-5">
                {/* Avatar */}
                <div className="shrink-0">
                    <div
                        className={`cursor-pointer w-20 h-20 rounded-xl overflow-hidden ring-1 bg-neutral-800 flex items-center justify-center ${
                            editing ? "ring-neutral-600" : "ring-neutral-700"
                        }`}
                        onClick={() => !editing && onEditStart()}
                    >
                        {activeHash ? (
                            <ThumbnailImage
                                contentHash={activeHash}
                                className="w-full h-full"
                            />
                        ) : (
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="w-10 h-10 m-1 text-neutral-500"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                            >
                                <path d="M2 4a2 2 0 012-2h3l2 2h7a2 2 0 012 2v1H2V4z" />
                                <path d="M2 7h16v7a2 2 0 01-2 2H4a2 2 0 01-2-2V7z" />
                            </svg>
                        )}
                    </div>
                    {editing && (
                        <p className="mt-1.5 text-[10px] text-neutral-600 text-center w-20 leading-tight">
                            {draftProfileImage
                                ? "click selection to clear"
                                : "click a file to assign"}
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
                                        list="field-keys"
                                        onChange={(e) =>
                                            updateField(
                                                i,
                                                "key",
                                                e.target.value,
                                            )
                                        }
                                        className="w-24 shrink-0 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-400 placeholder-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-600"
                                    />
                                    <datalist id="field-keys">
                                        {metadataFields.map((name) => (
                                            <option key={name} value={name} />
                                        ))}
                                    </datalist>
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
                                    {field.type === "url" ||
                                    URL_RE.test(field.value) ? (
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
                                onClick={() => onEditStart()}
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
