// ─── BrowseRow ────────────────────────────────────────────────────────────────

import HoverPreview from "./HoverPreview";
import { useEffect, useState } from "react";
import { useHoverPreview } from "../hooks/useHoverPreview";
import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import { DbFile } from "@renderer/shared/types/types";

export default function BrowseRow({
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