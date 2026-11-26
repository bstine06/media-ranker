import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    INSPECT_EASE,
    INSPECT_MS,
    INSPECT_OUT_MS,
    AT_REST,
    Flight,
    PlayState,
    barRect,
    barUnder,
    flightCss,
    flyBar,
    flyTo,
    pictureRect,
    playStateIn,
} from "@renderer/lib/inspect";
import { DbFile } from "@renderer/shared/types/types";
import { SlotResolver, useScrollSlots } from "@renderer/hooks/useScrollSlots";
import { TagPanel } from "./TagPanel";
import { isTyping } from "@renderer/lib/keys";
import { FolderIcon } from "./icons/FolderIcon";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { formatFileSize } from "@renderer/lib/media";
import { showInFolder } from "@renderer/lib/filesystem";
import { MediaSlide } from "./MediaSlide";
import { MediaSpot } from "@renderer/media/MediaLayer";
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

/** Opened as an inspection: the picture grows from where it was on screen
 *  and, on closing, goes back there (see lib/inspect.ts). */
export interface InspectProps {
    /** The picture's rect where it was opened from; null: just appear. */
    from: DOMRect | null;
    /** Where that view draws a video's playhead strip; null: it draws
     *  none (the strip then starts along the picture's bottom edge). */
    fromBar: DOMRect | null;
    /** A video's play state there, so it carries on here. */
    startAt: PlayState | null;
    /** Set to close: go back to `to` (the strip to `toBar`, or the
     *  picture's bottom edge), or fade out if `to` is null. */
    closing: { to: DOMRect | null; toBar: DOMRect | null } | null;
    /** Done closing, with the video's play state at that moment. */
    onClosed: (state: PlayState | null) => void;
    /** It's showing (starting to grow in): the view underneath can hide
     *  its own copy now, so there's only ever one on screen. */
    onShown?: () => void;
    /** The media is a spot of the media layer (the very player of the view
     *  it came from flies here and back); the rest above is for the older,
     *  two-copy way, until it's gone. */
    asSpot?: boolean;
}

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
    inspect,
}: {
    inspect?: InspectProps;
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
    } = useScrollSlots({ initialFile, resolver, active });

    const { rotateLeft } = useRotation(currentFile);

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

    // ── Inspection: grow in, go back ──
    // The media area itself moves: a transform puts the picture over where
    // it came from and eases to nothing. The media has no black behind it
    // here (see-through), so only the picture shows over the dimmed view.
    // The buttons and panel fade in alongside. Done straight on the
    // element, so React's renders never get in the way mid-move.
    const areaRef = useRef<HTMLDivElement>(null);
    const [chromeShown, setChromeShown] = useState(!inspect);
    const inspectRef = useRef(inspect);
    inspectRef.current = inspect;
    const flewIn = useRef(false);
    const moveArea = (from: Flight, to: Flight, ms: number) => {
        const area = areaRef.current;
        if (!area) return;
        area.style.transformOrigin = "0 0";
        area.style.transition = "none";
        area.style.transform = flightCss(from);
        area.style.opacity = "1";
        void area.offsetWidth; // start from there
        area.style.transition = `transform ${ms}ms ${INSPECT_EASE}`;
        area.style.transform = flightCss(to);
    };
    // A video's playhead strip isn't scaled with the picture: it goes on its
    // own from where the other view draws it to its place here (and back),
    // on the same progress (see flyBar).
    const stopBar = useRef<() => void>(() => {});
    const startBar = (area: HTMLElement, areaRest: DOMRect, fromF: Flight, toF: Flight, from: DOMRect | null, to: DOMRect | null, hold: boolean, ms: number) => {
        stopBar.current();
        stopBar.current = from && to ? flyBar(area, areaRest, fromF, toF, from, to, hold, ms) : () => {};
    };
    useEffect(() => () => stopBar.current(), []);
    const asSpot = !!inspect?.asSpot;
    // As a spot: the player is already there and flies itself; the chrome
    // comes in at once and the view underneath is told it's showing.
    useLayoutEffect(() => {
        if (!asSpot || flewIn.current) return;
        flewIn.current = true;
        setChromeShown(true);
        inspectRef.current?.onShown?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Hidden until there's a picture to measure (it starts where it was).
    // Not once it's grown in: a picture can be ready before this runs a
    // second time (React re-runs effects on mount in development).
    useLayoutEffect(() => {
        if (asSpot) return;
        if (inspect?.from && areaRef.current && !flewIn.current) areaRef.current.style.opacity = "0";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const growIn = useCallback(() => {
        const insp = inspectRef.current;
        if (flewIn.current || !insp) return;
        flewIn.current = true;
        setChromeShown(true);
        insp.onShown?.();
        const area = areaRef.current;
        const pic = pictureRect(area);
        if (!area || !insp.from || !pic) {
            if (area) area.style.opacity = "1";
            return;
        }
        const areaRest = area.getBoundingClientRect();
        const flight = flyTo(areaRest, pic, insp.from);
        const bar = barRect(area);
        if (bar) {
            startBar(area, areaRest, flight, AT_REST, insp.fromBar ?? barUnder(insp.from, bar.height), bar, false, INSPECT_MS);
        }
        moveArea(flight, AT_REST, INSPECT_MS);
        setTimeout(() => {
            if (inspectRef.current?.closing) return;
            area.style.transition = "";
            area.style.transform = "";
        }, INSPECT_MS + 50);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // A slow load doesn't hold it up for long. (A video waits for its jump
    // to the handed-over moment, so it gets longer.)
    useEffect(() => {
        if (!inspect || asSpot) return;
        const t = setTimeout(growIn, inspect.startAt ? 500 : 150);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const closing = !!inspect?.closing;
    useEffect(() => {
        const insp = inspectRef.current;
        if (!insp?.closing) return;
        flewIn.current = true;
        setChromeShown(false);
        if (asSpot) {
            // The spot goes (see the render), so the player flies back by
            // itself; done once it has landed.
            const t = setTimeout(() => insp.onClosed(null), INSPECT_OUT_MS);
            return () => clearTimeout(t);
        }
        const area = areaRef.current;
        const to = insp.closing.to;
        const pic = pictureRect(area);
        if (area && to && pic) {
            stopBar.current();
            const areaRest = area.getBoundingClientRect();
            const flight = flyTo(areaRest, pic, to);
            const bar = barRect(area);
            if (bar) {
                startBar(area, areaRest, AT_REST, flight, bar, insp.closing.toBar ?? barUnder(to, bar.height), true, INSPECT_OUT_MS);
            }
            moveArea(AT_REST, flight, INSPECT_OUT_MS);
        } else if (area) {
            area.style.transition = `opacity ${INSPECT_OUT_MS}ms ease-out`;
            area.style.opacity = "0";
        }
        // The video keeps playing on the way back: hand over where it got to.
        const t = setTimeout(() => insp.onClosed(playStateIn(area)), INSPECT_OUT_MS);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closing]);
    // In and out take different times (going back is quicker).
    const chromeMs = closing ? INSPECT_OUT_MS : INSPECT_MS;
    const chromeStyle: React.CSSProperties | undefined = inspect
        ? { opacity: chromeShown ? 1 : 0, transition: `opacity ${chromeMs}ms ease-out` }
        : undefined;
    // The tag panel (and its divider) slides in from the right edge and out
    // again, on the media's curve.
    const panelStyle: React.CSSProperties | undefined = inspect
        ? {
              transform: chromeShown ? "none" : `translateX(${sidebarWidth + 4}px)`,
              transition: `transform ${chromeMs}ms ${INSPECT_EASE}`,
          }
        : undefined;

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
            // Where to go next isn't decided here: every view that shows the
            // file reacts to it being removed (the same for a redo or a
            // delete in Finder).
            await window.api.deleteFile(currentFile.id);
            setShowConfirm(false);
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

    // The pieces that sit on the media: in place, or (as a spot) the
    // spot's overlay, drawn by the media layer above the player.
    const backBar = onClose && (
        <div className="absolute top-3 left-0 right-0 z-20" style={chromeStyle}>
            <button
                onClick={onClose}
                className="pointer-events-auto absolute left-3 flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 text-xs text-neutral-300 hover:bg-black/70 transition-colors"
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
    );
    const rotateButton = allowRotate && (
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
    );
    const arrows = (
        <div
            // Up / down mean nothing here; on closing they just go
            // (no fade), so they don't hang over the picture.
            style={closing ? { opacity: 0, transition: "none" } : chromeStyle}
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
    );

    return (
        <div className="relative flex min-h-0 flex-1">
            {!asSpot && backBar}
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
                {!asSpot && rotateButton}
                <div
                    ref={areaRef}
                    className={`relative min-h-0 flex-1 overflow-hidden ${pointer.cursorClass}`}
                    onWheel={handleWheel}
                    {...pointer.handlers}
                >
                    {!asSpot && <MediaFlash flash={pointer.flash} />}
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
                            {slotFiles[slot] && asSpot && slot === frontSlot && slotFiles[slot]!.id === initialFile?.id ? (
                                // The same player as the view it came from,
                                // flown here by the media layer; gone while
                                // closing, so it flies back.
                                !closing && (
                                    <MediaSpot
                                        file={slotFiles[slot]!}
                                        className="absolute inset-0"
                                        arriveMs={INSPECT_MS}
                                        player={{
                                            disabled: !active,
                                            muted: false,
                                            seeThrough: true,
                                            rotation: slotFiles[slot]!.rotation,
                                            className: pointer.cursorClass,
                                            onMouseEnter: pointer.handlers.onMouseEnter,
                                            onMouseLeave: () => {
                                                pointer.handlers.onMouseLeave();
                                                setNearTop(false);
                                            },
                                            onMouseMove: allowRotate
                                                ? (e) => {
                                                      const top = e.currentTarget.getBoundingClientRect().top;
                                                      const near = e.clientY - top < NEAR_TOP_PX;
                                                      if (near !== nearTop) setNearTop(near);
                                                  }
                                                : undefined,
                                            onContextMenu: pointer.handlers.onContextMenu,
                                        }}
                                        // On the media, above the player.
                                        overlay={
                                            <>
                                                {backBar}
                                                {rotateButton}
                                                <MediaFlash flash={pointer.flash} />
                                                {arrows}
                                            </>
                                        }
                                    />
                                )
                            ) : slotFiles[slot] && (
                                <MediaSlide
                                    file={slotFiles[slot]!}
                                    rootPath={rootPath}
                                    ref={videoRefs[slot]}
                                    disabled={!active || slot !== frontSlot}
                                    rotation={slotFiles[slot]!.rotation}
                                    seeThrough={!!inspect}
                                    {...(inspect &&
                                    slot === frontSlot &&
                                    slotFiles[slot]!.id === initialFile?.id
                                        ? { startAt: inspect.startAt, onReady: growIn }
                                        : {})}
                                />
                            )}
                        </div>
                    ))}
                </div>

                {!asSpot && arrows}
            </div>

            {/* Draggable divider */}
            <div
                className="pointer-events-auto relative w-1 bg-neutral-800 hover:bg-neutral-600 cursor-ew-resize group z-30"
                style={panelStyle}
                onMouseDown={panelResize.onMouseDown}
            >
                <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>

            <div
                className="pointer-events-auto flex flex-col h-full overflow-hidden"
                style={{ width: `${sidebarWidth}px`, ...panelStyle }}
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
                <div className="pointer-events-auto">
                <ConfirmDialog
                    title="Delete File"
                    message={`Delete "${currentFile.filename}"? ⌘Z brings it back until the app quits; then it goes to the Trash.`}
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setShowConfirm(false)}
                />
                </div>
            )}
        </div>
    );
}