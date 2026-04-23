import React, { useEffect, useMemo, useState } from "react";
import { DbFile } from "@renderer/shared/types/types";
import { SlotResolver, useScrollSlots } from "@renderer/hooks/useScrollSlots";
import { TagPanel } from "./TagPanel";
import { FolderIcon } from "./icons/FolderIcon";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { formatFileSize } from "@renderer/lib/media";
import { showInFolder } from "@renderer/lib/filesystem";
import { MediaSlide } from "./MediaSlide";
import ConfirmDialog from "./ConfirmDialog";

export default function ScrollView({
    initialFile,
    resolver,
    active,
    rootPath,
    folderProfileHash,
    onFolderClick,
    onFileClick,
    onClose,
    progress,
    onFileChange,
}: {
    initialFile: DbFile | null;
    resolver: SlotResolver;
    active: boolean;
    rootPath: string;
    folderProfileHash: string | null;
    onFolderClick: (folderName: string) => void;
    onFileClick: (file: DbFile) => void;
    onClose?: () => void;
    progress?: { index: number; total: number };
    onFileChange?: (file: DbFile) => void;
}): JSX.Element {
    const {
        slotFiles,
        slotTransforms,
        slotTransitions,
        frontSlot,
        videoRef0,
        videoRef1,
        currentFile,
        cursor,
        handleWheel,
        navigate,
    } = useScrollSlots({ initialFile, resolver, active });

    const videoRefs = [videoRef0, videoRef1];

    const [sidebarWidth, setSidebarWidth] = useState(288); // 288px = w-72
    const [isDragging, setIsDragging] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            // Calculate new width from the right edge of the viewport
            const newWidth = window.innerWidth - e.clientX;

            // Constrain between min and max widths
            const minWidth = 200;
            const maxWidth = 600;
            setSidebarWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "ew-resize";
            document.body.style.userSelect = "none";
        }

        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [isDragging]);

    useEffect(() => {
        if (currentFile) onFileChange?.(currentFile);
    }, [currentFile]);

    const handleDelete = async () => {
        if (!currentFile) return;
        try {
            await window.api.deleteFile(currentFile.id);
            setShowConfirm(false);
            (progress && ((progress.index) >= progress.total))
                ? navigate("up")
                : navigate("down")
        } catch (error) {
            console.error("Failed to delete file:", error);
            // Optionally: show error toast
        }
    };

    if (!currentFile)
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-500">
                No files
            </div>
        );

    return (
        <div className="relative flex min-h-0 flex-1">
            {onClose && (
                <div className="absolute top-3 left-0 right-0 z-20">
                    <button
                        onClick={onClose}
                        className="absolute left-3 flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 text-xs text-neutral-300 hover:bg-black/70 transition-colors"
                    >
                        ← Back
                    </button>

                    {progress && (
                        <div
                            className="absolute gap-1.5 rounded-full mr-3 bg-black/50 px-3 py-1.5 text-xs text-neutral-300"
                            style={{ right: `${sidebarWidth}px` }}
                        >
                            {progress.index} / {progress.total}
                        </div>
                    )}
                </div>
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                    className="relative min-h-0 flex-1 overflow-hidden"
                    onWheel={handleWheel}
                >
                    {([0, 1] as const).map((slot) => (
                        <div
                            key={slot}
                            className="absolute inset-0"
                            style={{
                                transform: slotTransforms[slot],
                                transition: slotTransitions[slot],
                                zIndex: slot === frontSlot ? 2 : 1,
                            }}
                        >
                            {slotFiles[slot] && (
                                <MediaSlide
                                    file={slotFiles[slot]!}
                                    rootPath={rootPath}
                                    ref={videoRefs[slot]}
                                    disabled={!active || slot !== frontSlot}
                                />
                            )}
                        </div>
                    ))}
                </div>

                <div
                    className="absolute inset-0 z-10 flex items-center justify-end pr-4 pointer-events-none group"
                    onKeyDown={(e) => {
                        if (e.key === " ") {
                            e.preventDefault();
                        }
                    }}
                >
                    <div className="flex flex-col gap-2 pointer-events-auto opacity-20 group-hover:opacity-100 duration-500">
                        <button
                            onClick={() => navigate("up")}
                            className="rounded-full bg-neutral-800 p-2 text-white disabled:opacity-20 hover:bg-black/80"
                        >
                            ▲
                        </button>
                        <button
                            onClick={() => navigate("down")}
                            className="rounded-full bg-neutral-800 p-2 text-white hover:bg-black/80"
                        >
                            ▼
                        </button>
                    </div>
                </div>
            </div>

            {/* Draggable divider */}
            <div
                className="relative w-1 bg-neutral-800 hover:bg-neutral-600 cursor-ew-resize group z-30"
                onMouseDown={handleMouseDown}
            >
                <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>

            <div
                className="flex flex-col h-full overflow-hidden"
                style={{ width: `${sidebarWidth}px` }}
            >
                <div className="flex flex-col gap-1 px-3 py-2 border-b border-neutral-800 text-sm">
                    <div
                        className="cursor-pointer flex items-center gap-2 px-3 py-2 border-b border-neutral-800"
                        onClick={() =>
                            onFolderClick(currentFile.path.split("/")[0])
                        }
                    >
                        {folderProfileHash ? (
                            <ThumbnailImage
                                contentHash={folderProfileHash}
                                className="w-6 h-6 rounded-full shrink-0"
                            />
                        ) : (
                            <div className="bg-neutral-700 rounded-full shrink-0">
                                <FolderIcon className="w-4 h-4 m-1 text-neutral-500" />
                            </div>
                        )}
                        <span className="text-neutral-400 text-sm truncate">
                            {currentFile.path.split("/")[0]}
                        </span>
                    </div>
                    <span
                        className="cursor-pointer text-neutral-200 font-medium break-all"
                        title={currentFile.filename}
                        style={{ overflowWrap: "break-word", hyphens: "none" }}
                        onClick={() => onFileClick(currentFile)}
                    >
                        {currentFile.filename ?? "—"}
                    </span>
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <span className="text-neutral-500 capitalize text-xs">
                                {`${
                                    currentFile.size != null
                                        ? formatFileSize(currentFile.size)
                                        : "—"
                                }`}
                            </span>
                            <span className="text-neutral-500 text-xs">
                                {`${Math.round(currentFile.elo_score)} pts`}
                            </span>
                        </div>
                        <button
                            onClick={() => setShowConfirm(true)}
                            className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs"
                        >
                            Delete
                        </button>
                    </div>
                </div>
                <TagPanel file={currentFile} />
            </div>

            {showConfirm && (
                <ConfirmDialog
                    title="Delete File"
                    message={`Are you sure you want to delete "${currentFile.filename}"? It will be moved to trash.`}
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setShowConfirm(false)}
                />
            )}
        </div>
    );
}