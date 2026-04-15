import React from "react";
import { DbFile } from "@renderer/shared/types/types";
import { SlotResolver, useScrollSlots } from "@renderer/hooks/useScrollSlots";
import { TagPanel } from "./TagPanel";
import { FolderIcon } from "./icons/FolderIcon";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { formatFileSize } from "@renderer/lib/media";
import { showInFolder } from "@renderer/lib/filesystem";
import { MediaSlide } from "./MediaSlide";

export default function ScrollView({
    initialFile,
    resolver,
    active,
    rootPath,
    folderProfileHash,
    onFolderClick,
    onFileClick,
    onClose,
}: {
    initialFile: DbFile | null;
    resolver: SlotResolver;
    active: boolean;
    rootPath: string;
    folderProfileHash: string | null;
    onFolderClick: (folderName: string) => void;
    onFileClick: (file: DbFile) => void;
    onClose?: () => void;
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
        canGoUp,
        handleWheel,
        navigate,
    } = useScrollSlots({ initialFile, resolver, active });

    const videoRefs = [videoRef0, videoRef1];

    if (!currentFile) return (
        <div className="flex flex-1 items-center justify-center text-neutral-500">
            No files
        </div>
    );

    return (
        <div className="relative flex min-h-0 flex-1" onWheel={handleWheel}>
            {onClose && (
    <button
        onClick={onClose}
        className="absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 text-xs text-neutral-300 hover:bg-black/70 transition-colors"
    >
        ← Back
    </button>
)}
            <div className="relative flex min-h-0 flex-1 flex-col flex-[4]">
                <div className="relative min-h-0 flex-1 overflow-hidden">
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

                <div className="absolute inset-0 z-10 flex items-center justify-end pr-4 pointer-events-none">
                    <div className="flex flex-col gap-2 opacity-0 hover:opacity-100 duration-500 pointer-events-auto">
                        <button
                            onClick={() => navigate("up")}
                            disabled={!canGoUp}
                            className="rounded-full bg-neutral-800 p-2 text-white disabled:opacity-20 hover:bg-black/80"
                        >▲</button>
                        <button
                            onClick={() => navigate("down")}
                            className="rounded-full bg-neutral-800 p-2 text-white hover:bg-black/80"
                        >▼</button>
                    </div>
                </div>
            </div>

            <div className="w-56">
                <div className="flex flex-col gap-1 px-3 py-2 border-b border-neutral-800 text-sm">
                    <div
                        className="cursor-pointer flex items-center gap-2 px-3 py-2 border-b border-neutral-800"
                        onClick={() => onFolderClick(currentFile.path.split("/")[0])}
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
                    <span className="text-neutral-500 text-xs">
                        {currentFile.size != null ? formatFileSize(currentFile.size) : "—"}
                    </span>
                </div>
                <TagPanel file={currentFile} />
            </div>
        </div>
    );
}