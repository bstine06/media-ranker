import { useSettings } from "@renderer/contexts/SettingsContext";
import { toMediaUrl } from "@renderer/lib/media";
import { DbFile } from "@renderer/shared/types/types";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { TagPanel } from "../../components/FileView";
import { MediaPlayer } from "../../components/MediaPlayer";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { FolderIcon } from "../../components/icons/FolderIcon";
import { formatFileSize } from "@renderer/lib/media";
import { MediaSlide } from "../../components/ScrollView";
import { showInFolder } from "@renderer/lib/filesystem";

// reuse MediaSlide directly from ScrollView or copy it here

export default function BrowseScrollView({
    files,
    startIndex,
    rootPath,
    onClose,
    active,
    onGoToFolder,
    folderMetaVersion
}: {
    files: DbFile[];
    startIndex: number;
    rootPath: string;
    onClose: () => void;
    active: boolean;
    onGoToFolder: (folderPath: string) => void;
    folderMetaVersion: number;
}): JSX.Element {
    const [cursor, setCursor] = useState(startIndex);
    const { scrollTime } = useSettings();
    const scrollTimeRef = useRef(scrollTime);
    useEffect(() => { scrollTimeRef.current = scrollTime; console.log("browseScroll") }, [scrollTime]);

    const lockedRef = useRef(false);
    const [frontSlot, setFrontSlot] = useState<0 | 1>(0);
    const [slotFiles, setSlotFiles] = useState<[DbFile | null, DbFile | null]>(
        [files[startIndex] ?? null, null]
    );
    const [slotTransforms, setSlotTransforms] = useState<[string, string]>(
        ["translateY(0)", "translateY(100%)"]
    );
    const [slotTransitions, setSlotTransitions] = useState<[string, string]>(
        ["none", "none"]
    );

    const videoRef0 = useRef<HTMLVideoElement>(null);
    const videoRef1 = useRef<HTMLVideoElement>(null);
    const videoRefs = [videoRef0, videoRef1];

    const [folderProfileHash, setFolderProfileHash] = useState<string | null>(null);
    const currentFile = files[cursor] ?? null;
    const currentFolder = currentFile?.path.split("/")[0] ?? null;

    useEffect(() => {
        if (!currentFolder) return;
        window.api.getFolder(currentFolder)
            .then((f) => setFolderProfileHash(f?.profile_image_hash ?? null))
            .catch(() => setFolderProfileHash(null));
    }, [currentFolder, folderMetaVersion]);

    const navigate = useCallback((dir: "up" | "down") => {
        if (lockedRef.current) return;
        if (dir === "up" && cursor === 0) return;
        if (dir === "down" && cursor === files.length - 1) return; // stop at end

        lockedRef.current = true;
        videoRefs[frontSlot].current?.pause();

        const nextCursor = dir === "down" ? cursor + 1 : cursor - 1;
        const backSlot = frontSlot === 0 ? 1 : 0;
        const incoming = files[nextCursor];
        const offScreenY = dir === "down" ? "translateY(100%)" : "translateY(-100%)";
        const exitY = dir === "down" ? "translateY(-100%)" : "translateY(100%)";

        setSlotFiles((prev) => {
            const next = [...prev] as [DbFile | null, DbFile | null];
            next[backSlot] = incoming;
            return next;
        });
        setSlotTransitions(["none", "none"]);
        setSlotTransforms((prev) => {
            const next = [...prev] as [string, string];
            next[backSlot] = offScreenY;
            return next;
        });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setSlotTransitions([
                    `transform ${scrollTimeRef.current}ms cubic-bezier(0.4,0,0.2,1)`,
                    `transform ${scrollTimeRef.current}ms cubic-bezier(0.4,0,0.2,1)`,
                ]);
                setSlotTransforms((prev) => {
                    const next = [...prev] as [string, string];
                    next[frontSlot] = exitY;
                    next[backSlot] = "translateY(0)";
                    return next;
                });
                setTimeout(() => {
                    setFrontSlot(backSlot as 0 | 1);
                    setSlotTransitions(["none", "none"]);
                    videoRefs[backSlot].current?.play();
                    lockedRef.current = false;
                    setCursor(nextCursor);
                }, scrollTimeRef.current + 20);
            });
        });
    }, [cursor, files, frontSlot]);

    // keyboard
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") navigate("down");
            if (e.key === "ArrowUp") navigate("up");
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, navigate, onClose]);

    // wheel — reuse same inertia logic
    const wheelLatchRef = useRef(false);
    const wheelCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wheelHistoryRef = useRef<{ delta: number; time: number }[]>([]);

    function computeSlope(history: { delta: number; time: number }[]): number {
        const n = history.length;
        if (n < 2) return 0;
        const meanX = history.reduce((s, p) => s + p.time, 0) / n;
        const meanY = history.reduce((s, p) => s + p.delta, 0) / n;
        const num = history.reduce((s, p) => s + (p.time - meanX) * (p.delta - meanY), 0);
        const den = history.reduce((s, p) => s + (p.time - meanX) ** 2, 0);
        return den === 0 ? 0 : num / den;
    }

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (lockedRef.current) return;
        const absDelta = Math.abs(e.deltaY);
        if (absDelta < 10) return;
        const now = performance.now();
        wheelHistoryRef.current.push({ delta: absDelta, time: now });
        wheelHistoryRef.current = wheelHistoryRef.current.filter((p) => now - p.time < 120);
        const slope = computeSlope(wheelHistoryRef.current);
        if (wheelCooldownRef.current) clearTimeout(wheelCooldownRef.current);
        wheelCooldownRef.current = setTimeout(() => {
            wheelLatchRef.current = false;
            wheelHistoryRef.current = [];
        }, 60);
        if (wheelLatchRef.current) return;
        if (slope < 0.5) return;
        wheelLatchRef.current = true;
        navigate(e.deltaY > 0 ? "down" : "up");
    }, [navigate]);

    // play/pause on active
    useEffect(() => {
        if (active) videoRefs.forEach((r) => r.current?.play());
        else videoRefs.forEach((r) => r.current?.pause());
    }, [active]);

    if (!currentFile) return (
        <div className="flex flex-1 items-center justify-center text-neutral-500">
            No files
        </div>
    );

    return (
        <div className="relative flex min-h-0 flex-1" onWheel={handleWheel}>
            <div className="relative flex min-h-0 flex-1 flex-col flex-[4]">
                {/* Back button */}
                <button
                    onClick={onClose}
                    className="absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 text-xs text-neutral-300 hover:bg-black/70 transition-colors"
                >
                    ← Back
                </button>

                {/* Position indicator */}
                <div className="absolute top-3 right-3 z-20 rounded-full bg-black/50 px-3 py-1.5 text-xs text-neutral-400">
                    {cursor + 1} / {files.length}
                </div>

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
                            disabled={cursor === 0}
                            className="rounded-full bg-neutral-800 p-2 text-white disabled:opacity-20 hover:bg-black/80"
                        >▲</button>
                        <button
                            onClick={() => navigate("down")}
                            disabled={cursor === files.length - 1}
                            className="rounded-full bg-neutral-800 p-2 text-white disabled:opacity-20 hover:bg-black/80"
                        >▼</button>
                    </div>
                </div>
            </div>

            <div className="w-56">
                <div className="flex flex-col gap-1 px-3 py-2 border-b border-neutral-800 text-sm">
                    <div
                        className="cursor-pointer flex items-center gap-2 px-3 py-2 border-b border-neutral-800"
                        onClick={() => onGoToFolder(currentFile.path.split("/")[0])}
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
                        title={currentFile?.filename}
                        style={{ overflowWrap: "break-word", hyphens: "none" }}
                        onClick={() => showInFolder(rootPath, currentFile.path)}
                    >
                        {currentFile?.filename ?? "—"}
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