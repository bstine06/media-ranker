import { useEffect, useState } from "react";
import type { DbFile } from "../../shared/types/types";
import { toMediaUrl, toThumbnailUrl } from "../../lib/media";
import HoverPreview from "./HoverPreview";
import { useHoverPreview } from "../hooks/useHoverPreview";
import { FolderIcon } from "@renderer/components/icons/FolderIcon";
import { TrashIcon } from "@renderer/components/icons/TrashIcon";
import { CrownIcon } from "@renderer/components/icons/CrownIcon";

export default function MediaTile({
    file,
    rootPath,
    onClickTrash,
    onClickCrown,
    onDragOut,
}: {
    file: DbFile;
    rootPath: string;
    onClickTrash: () => void;
    onClickCrown?: () => void;
    /** Start the native drag; defaults to dragging just this file. */
    onDragOut?: () => void;
}): JSX.Element {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);

    const {
        elementRef,
        layout,
        preview,
        handleMouseEnter,
        handleMouseLeave,
        handleNaturalSize,
    } = useHoverPreview();

    const isVideo = file.media_type === "video";
    const fullUrl = toMediaUrl(rootPath, file.path);

    useEffect(() => {
        window.api.getThumbnailPath(file.content_hash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [file.content_hash]);

    const handleShowInFolder = (e: React.MouseEvent) => {
        e.stopPropagation();
        // file.path is relative, so reconstruct the absolute path
        window.api.showInFolder(`${rootPath}/${file.path}`);
    };

    return (
        <>
            <div
                ref={elementRef as React.RefObject<HTMLDivElement>}
                className="group relative overflow-hidden bg-neutral-800 cursor-pointer h-full"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                draggable
                onDragStart={(e) => {
                    e.preventDefault();
                    window.getSelection()?.removeAllRanges();
                    handleMouseLeave();
                    if (onDragOut) onDragOut();
                    else window.api.dragFileOut(file);
                }}
            >
                {thumbUrl ? (
                    <img
                        src={thumbUrl}
                        alt={file.filename}
                        className="h-full w-full object-cover"
                        loading="lazy"
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center text-neutral-600 text-xs">
                        {isVideo ? "▶" : "?"}
                    </div>
                )}

                <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <p className="truncate text-xs font-medium text-white">
                        {file.filename}
                    </p>
                    <p className="text-xs text-neutral-400">
                        {Math.round(file.elo_score)} pts
                    </p>
                    <div className="flex justify-between">
                        <button
                            onClick={handleShowInFolder}
                            className="mt-1 self-start rounded bg-white/10 px-1.5 py-0.5 text-xs text-white hover:bg-white/25 transition-colors"
                        >
                            <FolderIcon className="h-4 w-4" />
                        </button>
                        {onClickCrown && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClickCrown();
                                }}
                                title="Keep on screen in Compare"
                                className="mt-1 self-start rounded bg-white/10 px-1.5 py-0.5 text-xs text-white hover:bg-white/25 transition-colors"
                            >
                                <CrownIcon className="h-4 w-4" />
                            </button>
                        )}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onClickTrash();
                            }}
                            className="mt-1 self-start rounded bg-white/10 px-1.5 py-0.5 text-xs text-white hover:bg-white/25 transition-colors"
                        >
                            <TrashIcon className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {isVideo && (
                    <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                        ▶
                    </div>
                )}
                {file.media_type === "gif" && (
                    <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                        GIF
                    </div>
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
