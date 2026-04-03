import { useEffect, useRef, useState, useCallback } from "react";
import type { DbFile } from "../types";
import { toThumbnailUrl, toMediaUrl } from "../lib/media";
import HoverPreview from "./HoverPreview";
import { useHoverPreview } from "../hooks/useHoverPreview";
import { useKeyboardShortcut } from "../hooks/useKeyboard";

export default function RankingsView({
    rootPath,
    folderPrefixes,
}: {
    rootPath: string;
    folderPrefixes: string[] | null;
}): JSX.Element {
    const [files, setFiles] = useState<DbFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [keySelectedIndex, setKeySelectedIndex] = useState<number | null>(
        null,
    );
    const [keyPreviewLayout, setKeyPreviewLayout] = useState<{
        x: number;
        y: number;
        width: number;
        height: number;
    } | null>(null);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
        setLoading(true);
        const fetch = folderPrefixes
            ? Promise.all(
                  folderPrefixes.map((p) => window.api.getFilesInFolder(p)),
              ).then((results) => {
                  const seen = new Set<number>();
                  const merged: DbFile[] = [];
                  for (const batch of results) {
                      for (const f of batch) {
                          if (!seen.has(f.id)) {
                              seen.add(f.id);
                              merged.push(f);
                          }
                      }
                  }
                  return merged.sort((a, b) => b.elo_score - a.elo_score);
              })
            : window.api.getAllFiles();

        fetch.then((result) => {
            setFiles(result);
            setLoading(false);
        });
    }, [folderPrefixes]);

    useEffect(() => {
        rowRefs.current = rowRefs.current.slice(0, files.length)
    }, [files.length])

    // Compute preview layout for keyboard-selected row
    const computeKeyPreview = useCallback((index: number) => {
        const el = rowRefs.current[index];
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const maxW = window.innerWidth * 0.75;
        const maxH = window.innerHeight * 0.75;
        // Default dimensions until natural size is known — will update via onNaturalSize
        const width = Math.min(maxW, 800);
        const height = Math.min(maxH, 600);
        const spaceRight = window.innerWidth - rect.right;
        const x =
            spaceRight > width + 16 ? rect.right + 8 : rect.left - width - 8;
        const y = Math.min(rect.top, window.innerHeight - height - 16);
        setKeyPreviewLayout({
            x: Math.max(8, x),
            y: Math.max(8, y),
            width,
            height,
        });
    }, []);

    const handleDown = useCallback(() => {
        if (files.length === 0) return;
        const base = keySelectedIndex ?? hoveredIndex ?? -1;
        const next = Math.min(base + 1, files.length - 1);
        setKeySelectedIndex(next);
        computeKeyPreview(next);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
    }, [files.length, keySelectedIndex, hoveredIndex, computeKeyPreview]);

    const handleUp = useCallback(() => {
        if (files.length === 0) return;
        const base = keySelectedIndex ?? hoveredIndex ?? 1;
        const prev = Math.max(base - 1, 0);
        setKeySelectedIndex(prev);
        computeKeyPreview(prev);
        rowRefs.current[prev]?.scrollIntoView({ block: "nearest" });
    }, [files.length, keySelectedIndex, hoveredIndex, computeKeyPreview]);

    useKeyboardShortcut({ key: "ArrowDown", onKeyPressed: handleDown });
    useKeyboardShortcut({ key: "ArrowUp", onKeyPressed: handleUp });

    const handleNaturalSize = useCallback(
        (w: number, h: number) => {
            if (keySelectedIndex === null) return;
            const el = rowRefs.current[keySelectedIndex];
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const maxW = window.innerWidth * 0.75;
            const maxH = window.innerHeight * 0.75;
            const scale = Math.min(maxW / w, maxH / h);
            const width = w * scale;
            const height = h * scale;
            const spaceRight = window.innerWidth - rect.right;
            const x =
                spaceRight > width + 16
                    ? rect.right + 8
                    : rect.left - width - 8;
            const y = Math.min(rect.top, window.innerHeight - height - 16);
            setKeyPreviewLayout({
                x: Math.max(8, x),
                y: Math.max(8, y),
                width,
                height,
            });
        },
        [keySelectedIndex],
    );

    if (loading) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Loading…
            </div>
        );
    }

    if (files.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                No files ranked yet.
            </div>
        );
    }

    const activeIndex = keySelectedIndex ?? hoveredIndex;
    const activeFile = activeIndex !== null ? files[activeIndex] : null;

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
                <h2 className="text-sm font-medium text-neutral-300">
                    Rankings
                </h2>
                <span className="text-xs text-neutral-600">
                    {folderPrefixes
                        ? `${folderPrefixes.length} folder${folderPrefixes.length !== 1 ? "s" : ""} · `
                        : "All · "}
                    {files.length} files
                </span>
            </div>

            <div
                className="overflow-y-auto flex-1"
                onMouseMove={() => {
                    // Mouse takes back control
                    if (keySelectedIndex !== null) {
                        setKeySelectedIndex(null);
                        setKeyPreviewLayout(null);
                    }
                }}
            >
                {files.map((file, index) => (
                    <RankRow
                        key={file.id}
                        file={file}
                        rank={index + 1}
                        rootPath={rootPath}
                        isActive={activeIndex === index}
                        isKeySelected={keySelectedIndex === index}
                        isKeyboardActive={keySelectedIndex !== null}
                        rowRef={(el) => {
                            rowRefs.current[index] = el;
                        }}
                        onMouseEnter={() => setHoveredIndex(index)}
                        onMouseLeave={() => setHoveredIndex(null)}
                    />
                ))}
            </div>

            {/* Keyboard-driven preview */}
            {keySelectedIndex !== null && keyPreviewLayout && activeFile && (
                <HoverPreview
    key={activeFile.content_hash}
    file={activeFile}
    fullUrl={toMediaUrl(rootPath, activeFile.path)}
    x={keyPreviewLayout.x}
    y={keyPreviewLayout.y}
    width={keyPreviewLayout.width}
    height={keyPreviewLayout.height}
    onNaturalSize={handleNaturalSize}
  />
            )}
        </div>
    );
}

function RankRow({
    file,
    rank,
    rootPath,
    isActive,
    isKeySelected,
    isKeyboardActive,
    onMouseEnter,
    onMouseLeave,
    rowRef,
}: {
    file: DbFile;
    rank: number;
    rootPath: string;
    isActive: boolean;
    isKeySelected: boolean;
    isKeyboardActive: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    rowRef: (el: HTMLDivElement | null) => void;
}): JSX.Element {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const fullUrl = toMediaUrl(rootPath, file.path);

    const {
        elementRef,
        layout,
        preview,
        handleMouseEnter: hoverEnter,
        handleMouseLeave: hoverLeave,
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
                ref={(el) => {
                    rowRef(el);
                    (
                        elementRef as React.MutableRefObject<HTMLElement | null>
                    ).current = el;
                }}
                className={`flex items-center gap-4 border-b border-neutral-800/50 px-5 py-3 transition-colors cursor-default border-l-2 ${
                    isKeySelected
                        ? "border-l-white bg-neutral-900"
                        : isActive
                          ? "border-l-neutral-600 bg-neutral-900/50"
                          : "border-l-transparent"
                }`}
                onMouseEnter={() => {
                    onMouseEnter();
                    hoverEnter();
                }}
                onMouseLeave={() => {
                    onMouseLeave();
                    hoverLeave();
                }}
            >
                <span
                    className={`w-8 shrink-0 text-right text-sm font-bold tabular-nums ${rankColor}`}
                >
                    {rank}
                </span>

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

            {preview && layout && !isKeyboardActive && (
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
