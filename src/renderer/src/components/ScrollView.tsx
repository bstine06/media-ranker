import React, { useEffect, useState } from "react";
import { DbFile } from "@renderer/shared/types/types";
import { SlotResolver, useScrollSlots } from "@renderer/hooks/useScrollSlots";
import { TagPanel } from "./TagPanel";
import { isTyping } from "@renderer/lib/keys";
import { FolderIcon } from "./icons/FolderIcon";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { formatFileSize } from "@renderer/lib/media";
import { showInFolder } from "@renderer/lib/filesystem";
import { MediaSlide } from "./MediaSlide";
import ConfirmDialog from "./ConfirmDialog";
import { CrownIcon } from "./icons/CrownIcon";
import { TrashIcon } from "./icons/TrashIcon";
import { RotateIcon } from "./icons/RotateIcon";
import { useRotation } from "@renderer/hooks/useRotation";
import { PLACEMENT_MATCHES } from "@renderer/contexts/PlacementContext";
import { useLibraryRank, useRankedTotal } from "@renderer/contexts/RankContext";
import { usePointerTarget, useTagPointerSurface } from "@renderer/contexts/TagPointerContext";
import { MediaFlash } from "./TagPointer";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useEdgeResize } from "@renderer/hooks/useEdgeResize";

/** How close to the top of the media the mouse must be to show Rotate. */
const NEAR_TOP_PX = 96;

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
    onCrown,
    onPlace,
    allowRotate = false,
    jumpTo = null,
}: {
    initialFile: DbFile | null;
    resolver: SlotResolver;
    active: boolean;
    rootPath: string;
    folderProfileHash: string | null;
    /** A collection by name, or null for Unsorted (the file sits directly
     *  in the library folder). */
    onFolderClick: (folderName: string | null) => void;
    onFileClick: (file: DbFile) => void;
    onClose?: () => void;
    progress?: { index: number; total: number };
    onFileChange?: (file: DbFile) => void;
    /** Send the current file to Compare and keep it on screen there. */
    onCrown?: (file: DbFile) => void;
    /** Give the current file its placement matches in Compare. */
    onPlace?: (file: DbFile) => void;
    /** Show the rotate-left button (single file view). */
    allowRotate?: boolean;
    /** Slide this file in (each new `n` once), e.g. a file an undo just
     *  brought back. */
    jumpTo?: { file: DbFile; dir: "up" | "down"; n: number } | null;
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
        replaceFile,
    } = useScrollSlots({ initialFile, resolver, active });

    const { turns: rotationOf, rotateLeft } = useRotation(
        currentFile,
        rootPath,
        replaceFile,
    );

    // The tag pointer works over the file on screen.
    useTagPointerSurface(active);
    const pointer = usePointerTarget(currentFile, active);

    const libraryRank = useLibraryRank(currentFile?.id ?? -1);
    const rankedTotal = useRankedTotal();

    // The rotate button shows only while the mouse is near the top of the
    // media, so it stays out of the way of the picture.
    const [nearTop, setNearTop] = useState(false);

    const videoRefs = [videoRef0, videoRef1];

    // The tag panel's width: drag its left edge; remembered (settings).
    const { tagPanelWidth, setTagPanelWidth } = useSettings();
    const panelResize = useEdgeResize({
        width: tagPanelWidth,
        save: setTagPanelWidth,
        min: 200,
        max: 600,
        edge: "left",
    });
    const sidebarWidth = panelResize.width;
    const [showConfirm, setShowConfirm] = useState(false);

    useEffect(() => {
        if (currentFile) onFileChange?.(currentFile);
    }, [currentFile]);

    useEffect(() => {
        if (jumpTo) navigate(jumpTo.dir, jumpTo.file);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jumpTo?.n]);

    // R: rotate the file on screen left. K: send it to Compare as king.
    // (The rest of the keys: lib/keys.ts.)
    useEffect(() => {
        if (!active || !currentFile) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
            if (e.code === "KeyR") {
                e.preventDefault();
                rotateLeft();
            } else if (e.code === "KeyK" && onCrown) {
                e.preventDefault();
                onCrown(currentFile);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, onCrown, currentFile, rotateLeft]);

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

    // The copy button shows a check for a moment after copying.
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1200);
        return () => clearTimeout(t);
    }, [copied]);
    useEffect(() => {
        setCopied(false);
    }, [currentFile?.id]);

    const handleCopyFileToClipboard = async () =>{
        if (!currentFile) return;
        try {
            await window.api.copyFileToClipboard(`${rootPath}/${currentFile.path}`);
            setCopied(true);
        } catch (error) {
            console.error("Failed to copy file:", error);
        }
    };

    // Directly in the library folder: it belongs to Unsorted, not a folder.
    const unsorted = !!currentFile && !currentFile.path.includes("/");

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
            <div
                className="relative flex min-h-0 flex-1 flex-col"
                onMouseMove={
                    allowRotate
                        ? (e) => {
                              const top = e.currentTarget.getBoundingClientRect().top;
                              const near = e.clientY - top < NEAR_TOP_PX;
                              if (near !== nearTop) setNearTop(near);
                          }
                        : undefined
                }
                onMouseLeave={() => setNearTop(false)}
            >
                {allowRotate && (
                    <button
                        onClick={rotateLeft}
                        title="Rotate left (R)"
                        tabIndex={nearTop ? 0 : -1}
                        className={`absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/50 p-2 text-neutral-300 hover:bg-black/70 hover:text-white transition-opacity duration-200 ${
                            nearTop ? "opacity-100" : "pointer-events-none opacity-0"
                        }`}
                    >
                        <RotateIcon className="h-4 w-4" />
                    </button>
                )}
                <div
                    className={`relative min-h-0 flex-1 overflow-hidden ${pointer.cursorClass}`}
                    onWheel={handleWheel}
                    {...pointer.handlers}
                >
                    <MediaFlash flash={pointer.flash} />
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
                                    rotation={rotationOf(slotFiles[slot]!.id)}
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
                onMouseDown={panelResize.onMouseDown}
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
                            onFolderClick(unsorted ? null : currentFile.path.split("/")[0])
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
                            {unsorted ? "Unsorted" : currentFile.path.split("/")[0]}
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
                            {libraryRank && (
                                <span
                                    className="text-neutral-400 text-xs tabular-nums"
                                    title="Place in the whole library"
                                >
                                    {libraryRank} of {rankedTotal}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-0.5">
                        {onCrown && (
                            <button
                                className="rounded p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
                                title="Keep on screen in Compare (K)"
                                onClick={() => onCrown(currentFile)}
                            >
                                <CrownIcon className="h-4 w-4" />
                            </button>
                        )}
                        {onPlace && (
                            <button
                                className="rounded p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
                                title={`Place: ${PLACEMENT_MATCHES} matches against the library to set its rank`}
                                onClick={() => onPlace(currentFile)}
                            >
                                <svg
                                    viewBox="0 0 20 20"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={1.6}
                                    strokeLinejoin="round"
                                    className="h-4 w-4"
                                >
                                    <path d="M7.5 16.5V5.5h5v11" />
                                    <path d="M2.5 16.5v-6h5M12.5 16.5V8.5h5v8" />
                                    <path d="M1.5 16.5h17" strokeLinecap="round" />
                                </svg>
                            </button>
                        )}
                        <button
                            className="rounded p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
                            title={copied ? "Copied" : "Copy file to clipboard"}
                            onClick={() => handleCopyFileToClipboard()}
                        >
                            {copied ? (
                                <svg
                                    viewBox="0 0 20 20"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={1.8}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="h-4 w-4 text-emerald-400"
                                >
                                    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
                                </svg>
                            ) : (
                                <svg
                                    viewBox="0 0 20 20"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={1.6}
                                    strokeLinejoin="round"
                                    className="h-4 w-4"
                                >
                                    <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
                                    <path d="M13 7V4.75A1.25 1.25 0 0 0 11.75 3.5h-7A1.25 1.25 0 0 0 3.5 4.75v7A1.25 1.25 0 0 0 4.75 13H7" />
                                </svg>
                            )}
                        </button>
                        <button
                            onClick={() => setShowConfirm(true)}
                            title="Delete"
                            className="rounded p-1.5 text-neutral-400 hover:text-red-300 hover:bg-red-950 transition-colors"
                        >
                            <TrashIcon className="h-4 w-4" />
                        </button>
                        </div>
                    </div>
                </div>
                <TagPanel file={currentFile} />
            </div>

            {showConfirm && (
                <ConfirmDialog
                    title="Delete File"
                    message={`Delete "${currentFile.filename}"? ⌘Z brings it back until the app quits; then it goes to the Trash.`}
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setShowConfirm(false)}
                />
            )}
        </div>
    );
}