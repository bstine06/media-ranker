import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DbFile, DbTag } from "@renderer/shared/types/types";
import {
    usePass,
    itemAt,
    nextSpot,
    prevSpot,
    runProgress,
    tagPosition,
    snapCoverage,
    type CoverageSnap,
    type PassItem,
    type PassRun as Run,
} from "@renderer/contexts/PassContext";
import {
    useTagPointer,
    useTagPointerSurface,
    usePointerCursorClass,
    type PointerTarget,
    type FlashKind,
} from "@renderer/contexts/TagPointerContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useFileTags } from "@renderer/hooks/useFileTags";
import { isTyping } from "@renderer/lib/keys";
import { stepVideo, toMediaUrl, toThumbnailUrl, volumeLevel } from "@renderer/lib/media";
import { PointerLabel } from "./TagPointer";
import { TagPill } from "./TagPill";

// A Sweep pass, running: one lane that only moves when you step. The
// current spot (a file, a tag card, or the end card) sits in the middle
// and gets all the room it needs; neighbours fill what's left on either
// side, very slightly dimmed. Below the lane, a thin strip:
// the tag, where you are, key hints, and the whole run's progress.
//
//   Space  toggle the tag on the current file   3  next (untagged: a no)
//   2  skip: next, no answer (clears a no)      1  back
//   Tab    pick another of the job's tags (the current one goes last)
//   Q / E  scrub   R  rotate left   G  file view   K  to Compare   F  full screen

/** Spots drawn on each side of the current one (most are off screen). */
const NEIGHBOURS = 6;
/** The strip under the lane. */
const STRIP_PX = 30;

async function measureAspect(file: DbFile): Promise<number> {
    const fallback = file.media_type === "video" ? 16 / 9 : 1;
    const path = await window.api.getThumbnailPath(file.content_hash);
    if (!path) return fallback;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () =>
            resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : fallback);
        img.onerror = () => resolve(fallback);
        img.src = toThumbnailUrl(path);
    });
}

/** A step glides the whole strip, like Sweep's moving lane: the tiles sit
 *  edge to edge in one row and only the row moves. */
const GLIDE_MS = 280;
const GLIDE_EASE = "cubic-bezier(0.25, 0.8, 0.3, 1)";

/** A tile's key: the same element across steps (and across a reorder of
 *  the job's tags), so it can glide. */
const itemKey = (run: Run, it: PassItem) =>
    it.kind === "end"
        ? "end"
        : it.kind === "card"
          ? `card-${run.tags[it.t].id}`
          : `file-${run.tags[it.t].tagId}-${it.file.id}`;

export default function PassRun({
    active,
    rootPath,
    onInspect,
    onCompare,
}: {
    active: boolean;
    rootPath: string;
    onInspect: (file: DbFile) => void;
    onCompare: (file: DbFile) => void;
}): JSX.Element | null {
    const { run, forward, back, pickTag, replaceFile } = usePass();
    const { tagMap } = useTags();
    const { setTarget, clearTarget, setPassMode, pickingRef, picking } = useTagPointer();
    useTagPointerSurface(active);
    const cursorClass = usePointerCursorClass(active);

    // ── Size ──
    const boxRef = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
        ro.observe(el);
        setBox({ width: el.clientWidth, height: el.clientHeight });
        return () => ro.disconnect();
    }, []);
    const W = box.width;
    const H = box.height;

    // ── The spots around the current one ──
    const current = useMemo(() => (run ? itemAt(run, run.t, run.pos) : null), [run]);
    const { left, right } = useMemo(() => {
        const left: PassItem[] = [];
        const right: PassItem[] = [];
        if (!run) return { left, right };
        let at: [number, number] | null = [run.t, run.pos];
        for (let i = 0; i < NEIGHBOURS && at; i++) {
            at = prevSpot(run, at[0], at[1]);
            const it = at && itemAt(run, at[0], at[1]);
            if (it) left.push(it);
        }
        at = [run.t, run.pos];
        for (let i = 0; i < NEIGHBOURS && at; i++) {
            at = nextSpot(run, at[0], at[1]);
            const it = at && itemAt(run, at[0], at[1]);
            if (it) right.push(it);
        }
        return { left, right };
    }, [run]);

    // ── Shapes (width / height) ──
    const [aspects, setAspects] = useState<Record<number, number>>({});
    useEffect(() => {
        const files = [current, ...left, ...right]
            .filter((it): it is Extract<PassItem, { kind: "file" }> => it?.kind === "file")
            .map((it) => it.file)
            .filter((f) => aspects[f.id] == null);
        if (files.length === 0) return;
        let gone = false;
        Promise.all(files.map(async (f) => [f.id, await measureAspect(f)] as const)).then((rows) => {
            if (!gone) setAspects((a) => ({ ...a, ...Object.fromEntries(rows) }));
        });
        return () => {
            gone = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current, left, right]);
    const onShape = useCallback((id: number, aspect: number) => {
        setAspects((a) => (Math.abs((a[id] ?? 0) - aspect) < 0.01 ? a : { ...a, [id]: aspect }));
    }, []);
    const aspectOf = (it: PassItem) =>
        it.kind === "file" ? (aspects[it.file.id] ?? (it.file.media_type === "video" ? 16 / 9 : 1)) : 1;

    // ── The tag being passed on, and the pointer ──
    const tagId = run && run.t < run.tags.length ? run.tags[run.t].tagId : null;
    const tag = tagId != null ? (tagMap.get(tagId) ?? null) : null;
    // The job's tags still to come, each once, not the current one (its own
    // set-aside rest may be among them).
    const upcomingKey = run
        ? [...new Set(run.tags.slice(run.t + 1).map((x) => x.tagId))]
              .filter((id) => id !== tagId)
              .join(",")
        : "";
    useEffect(() => {
        if (!active) return;
        setPassMode({
            tagId,
            upcoming: upcomingKey ? upcomingKey.split(",").map(Number) : [],
            onPick: (id) => void pickTag(id),
        });
        return () => setPassMode(null);
    }, [active, tagId, upcomingKey, pickTag, setPassMode]);

    // Flashes: on the current tile (Space), and the whole lane (2: skip).
    const [tileFlash, setTileFlash] = useState<{ key: string; kind: FlashKind; n: number } | null>(null);
    const [laneFlash, setLaneFlash] = useState(0);
    const currentFile = current?.kind === "file" ? current.file : null;
    const currentKey = current && run ? itemKey(run, current) : "";
    const pointerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!active || !currentFile) return;
        const key = currentKey;
        const t: PointerTarget = {
            file: currentFile,
            ownPointer: true,
            onFlash: (kind) => setTileFlash((f) => ({ key, kind, n: (f?.n ?? 0) + 1 })),
            anchorY: () => pointerRef.current?.getBoundingClientRect().top ?? null,
        };
        setTarget(t);
        return () => clearTarget(t);
    }, [active, currentFile, currentKey, setTarget, clearTarget]);

    const { tags: fileTags } = useFileTags(currentFile?.id ?? null);
    const onFile = tag ? (fileTags as (DbTag & { inherited?: boolean })[]).find((x) => x.id === tag.id) : undefined;

    // ── "No" markers: files with a firm no for their tag (hard: taken off
    // by hand; pass: stepped past with 3). Shown on the tile so a no is
    // visible as it slides away and when coming back with 1. ──
    const [noes, setNoes] = useState<Record<string, { hard: boolean; pass: boolean }>>({});
    const noKey = (tagId: number, fileId: number) => `${tagId}:${fileId}`;
    const loadNoes = useCallback(async (tagId: number, fileIds: number[]) => {
        if (fileIds.length === 0) return;
        try {
            const rows = await window.api.getFirmNoes(tagId, fileIds);
            const found = new Map(rows.map((r) => [r.fileId, r]));
            setNoes((n) => {
                const next = { ...n };
                for (const id of fileIds) {
                    const r = found.get(id);
                    if (r) next[noKey(tagId, id)] = { hard: r.hard, pass: r.pass };
                    else delete next[noKey(tagId, id)];
                }
                return next;
            });
        } catch {
            // markers are only a display
        }
    }, []);
    // Each tag's list, once built (or rebuilt on coming back to it).
    const loadedLists = useRef(new Set<string>());
    useEffect(() => {
        if (!run) return;
        for (const tr of run.tags) {
            if (!tr.files) continue;
            const sig = `${tr.id}:${tr.files.length}`;
            if (loadedLists.current.has(sig)) continue;
            loadedLists.current.add(sig);
            void loadNoes(tr.tagId, tr.files.map((f) => f.id));
        }
    }, [run, loadNoes]);
    // The current file's tags changed (Space added or took off the tag):
    // its marker follows (taking it off is a hard no; having it, none).
    useEffect(() => {
        if (currentFile && tagId != null) void loadNoes(tagId, [currentFile.id]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fileTags]);

    // ── Layout: the current spot in the middle, all the room it needs ──
    const laneH = Math.max(0, H - STRIP_PX);
    // Every tile's size is fixed wherever it is in the lane: full height,
    // unless that would be wider than the screen; then it's one screen
    // wide, its media fit inside and centred (black above and below). So
    // nothing resizes on a step, the row just slides.
    const slotOf = (it: PassItem) => {
        const a = aspectOf(it);
        const w = Math.min(a * laneH, W);
        const h = a > 0 ? w / a : laneH;
        return { w, h, top: (laneH - h) / 2 };
    };
    const curSlot = current ? slotOf(current) : { w: 0, h: laneH, top: 0 };
    const curW = curSlot.w;
    const curH = curSlot.h;
    const curLeft = (W - curW) / 2;
    const curTop = curSlot.top;
    // One row, edge to edge, the current spot centred. Nearby spots off
    // screen are laid out too, so they slide in.
    const placed: {
        it: PassItem;
        x: number;
        w: number;
        h: number;
        top: number;
        isCurrent: boolean;
    }[] = [];
    if (current) {
        let x = curLeft;
        for (const it of left) {
            const { w, h, top } = slotOf(it);
            x -= w;
            placed.unshift({ it, x, w, h, top, isCurrent: false });
        }
        placed.push({ it: current, x: curLeft, w: curW, h: curH, top: curTop, isCurrent: true });
        x = curLeft + curW;
        for (const it of right) {
            const { w, h, top } = slotOf(it);
            placed.push({ it, x, w, h, top, isCurrent: false });
            x += w;
        }
    }

    // A step: the row is laid out around the new spot at once, then put back
    // where it was on screen (the old spot in the middle, or wherever a
    // glide in progress had it) and slides from there to rest. One moving
    // piece, so no gaps open between tiles.
    const rowRef = useRef<HTMLDivElement>(null);
    const lastKey = useRef<string>("");
    const layoutRef = useRef(new Map<string, { x: number; w: number }>());
    const keyOfCurrent = current && run ? itemKey(run, current) : "";
    useLayoutEffect(() => {
        const row = rowRef.current;
        const prevKey = lastKey.current;
        const layout = new Map(placed.map((p) => [itemKey(run!, p.it), { x: p.x, w: p.w }]));
        layoutRef.current = layout;
        lastKey.current = keyOfCurrent;
        if (!row || !prevKey || prevKey === keyOfCurrent) return;
        const old = layout.get(prevKey);
        if (!old) {
            row.style.transition = "none";
            row.style.transform = "translate3d(0, 0, 0)";
            return;
        }
        // Where the row is on screen right now (mid-glide or at rest).
        const m = new DOMMatrixReadOnly(getComputedStyle(row).transform);
        const from = m.m41 + W / 2 - (old.x + old.w / 2);
        row.style.transition = "none";
        row.style.transform = `translate3d(${from}px, 0, 0)`;
        void row.offsetWidth; // apply it before the glide starts
        row.style.transition = `transform ${GLIDE_MS}ms ${GLIDE_EASE}`;
        row.style.transform = "translate3d(0, 0, 0)";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keyOfCurrent]);

    // ── The pointer label: follows the mouse, kept on the current spot ──
    const mouse = useRef<{ x: number; y: number } | null>(null);
    const rect = useRef({ left: curLeft, top: curTop, right: curLeft + curW, bottom: curTop + curH });
    rect.current = { left: curLeft, top: curTop, right: curLeft + curW, bottom: curTop + curH };
    const [hasMouse, setHasMouse] = useState(false);
    // Glides with the lane on a step; follows the mouse at once.
    const placePointer = useCallback((glide = false) => {
        const el = pointerRef.current;
        if (!el) return;
        el.style.transition = glide
            ? "left 280ms cubic-bezier(0.25, 0.8, 0.3, 1), top 280ms cubic-bezier(0.25, 0.8, 0.3, 1)"
            : "none";
        const r = rect.current;
        const m = mouse.current;
        if (!m) {
            el.style.left = `${Math.min(Math.max(W * 0.4, r.left), r.right)}px`;
            el.style.top = `${r.top}px`;
            el.style.transform = "translate(-50%, 0)";
        } else {
            el.style.left = `${Math.min(Math.max(m.x, r.left), r.right)}px`;
            el.style.top = `${Math.min(Math.max(m.y, r.top + el.offsetHeight), r.bottom)}px`;
            el.style.transform = "translate(-50%, -100%)";
        }
    }, [W]);
    useLayoutEffect(() => placePointer(true));
    const onMouseMove = (e: React.MouseEvent) => {
        const b = boxRef.current?.getBoundingClientRect();
        if (!b) return;
        mouse.current = { x: e.clientX - b.left, y: e.clientY - b.top };
        if (!hasMouse) setHasMouse(true);
        placePointer(false);
    };

    // ── Videos (Q / E scrub the current one) ──
    const currentVideo = useRef<HTMLVideoElement | null>(null);

    // ── Keys ──
    const state = useRef({ current, tagId, tagged: !!onFile });
    state.current = { current, tagId, tagged: !!onFile };
    const rotating = useRef(false);
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping() || pickingRef.current) return;
            if (document.querySelector("[data-modal]")) return;
            const { current, tagId, tagged } = state.current;
            const file = current?.kind === "file" ? current.file : null;
            switch (e.code) {
                case "Digit3":
                    e.preventDefault();
                    if (e.repeat || !current || current.kind === "end") return;
                    // Stepping past an untagged file is a firm no (main
                    // skips it if the file has the tag).
                    if (file && tagId != null) {
                        if (!tagged) {
                            const k = noKey(tagId, file.id);
                            setNoes((n) => ({ ...n, [k]: { hard: n[k]?.hard ?? false, pass: true } }));
                        }
                        const id = file.id;
                        window.api
                            .setPassNo(id, tagId)
                            .then(() => loadNoes(tagId, [id]))
                            .catch(() => {});
                    }
                    void forward();
                    break;
                case "Digit2":
                    e.preventDefault();
                    if (e.repeat || !current || current.kind === "end") return;
                    // Skip: no answer. Clears a no given by mistake.
                    if (file && tagId != null) {
                        const k = noKey(tagId, file.id);
                        setNoes((n) => {
                            if (!n[k]) return n;
                            const next = { ...n };
                            if (n[k].hard) next[k] = { hard: true, pass: false };
                            else delete next[k];
                            return next;
                        });
                        const id = file.id;
                        window.api
                            .clearPassNo(id, tagId)
                            .then(() => loadNoes(tagId, [id]))
                            .catch(() => {});
                        setLaneFlash((n) => n + 1);
                    }
                    void forward();
                    break;
                case "Digit1":
                    e.preventDefault();
                    if (!e.repeat) back();
                    break;
                case "KeyQ":
                case "KeyE":
                case "ArrowLeft":
                case "ArrowRight":
                    e.preventDefault();
                    if (currentVideo.current) {
                        stepVideo(currentVideo.current, e.code === "KeyQ" || e.code === "ArrowLeft" ? -1 : 1);
                    }
                    break;
                case "KeyR":
                    e.preventDefault();
                    if (e.repeat || !file || rotating.current) return;
                    rotating.current = true;
                    window.api
                        .rotateFile(file.path, 1)
                        .then((updated) => {
                            setAspects((a) => {
                                const n = { ...a };
                                delete n[updated.id];
                                return n;
                            });
                            replaceFile(updated);
                        })
                        .catch((err) => console.error("Rotate failed:", err))
                        .finally(() => {
                            rotating.current = false;
                        });
                    break;
                case "KeyG":
                    e.preventDefault();
                    if (!e.repeat && file) onInspect(file);
                    break;
                case "KeyK":
                    e.preventDefault();
                    if (!e.repeat && file) onCompare(file);
                    break;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, forward, back, replaceFile, onInspect, onCompare, pickingRef, loadNoes]);

    if (!run) return null;
    const tr = run.t < run.tags.length ? run.tags[run.t] : null;
    const listLen = tr?.files?.length ?? 0;
    const { done, total } = runProgress(run);
    const tp = tagPosition(run);

    return (
        <div className="flex flex-1 flex-col overflow-hidden bg-neutral-950">
            <div
                ref={boxRef}
                className={`relative flex-1 overflow-hidden ${cursorClass}`}
                onMouseMove={onMouseMove}
            >
                {/* The lane: one row of tiles edge to edge, moving as one */}
                <div
                    ref={rowRef}
                    className="absolute inset-x-0 top-0"
                    style={{ height: laneH, willChange: "transform" }}
                >
                    {/* A flex row (as in free sweep): tiles touch exactly,
                        no hairline gaps at fractional positions. */}
                    <div
                        className="absolute top-0 flex"
                        style={{ left: placed[0]?.x ?? 0, height: laneH }}
                    >
                    {placed.map(({ it, w, h, top, isCurrent }) => {
                        const key = itemKey(run, it);
                        return (
                            <div
                                key={key}
                                className="relative shrink-0 overflow-hidden bg-black"
                                style={{ width: w, height: laneH }}
                            >
                                <div
                                    className="absolute inset-x-0 overflow-hidden"
                                    style={{
                                        top,
                                        height: h,
                                        // Neighbours: very slightly dimmed (no blur:
                                        // it showed as seams between tiles).
                                        filter: isCurrent ? "none" : "brightness(0.85)",
                                        transition: "filter 200ms ease-out",
                                    }}
                                >
                                    <PassTile
                                        item={it}
                                        run={run}
                                        rootPath={rootPath}
                                        current={isCurrent}
                                        onShape={onShape}
                                        videoRef={isCurrent ? currentVideo : undefined}
                                    />
                                    {/* A firm no: a steady red ring round the media (easy
                                        to catch as it slides away), and the badge saying so. */}
                                    {it.kind === "file" &&
                                        noes[noKey(run.tags[it.t].tagId, it.file.id)] && (
                                            <>
                                                <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_3px_rgb(239_68_68)]" />
                                                <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/75 px-2 py-0.5 text-[11px] font-medium text-red-300">
                                                    ✕ no
                                                </span>
                                            </>
                                        )}
                                </div>
                                {isCurrent && tileFlash && tileFlash.key === key && (
                                    <div
                                        className="pointer-events-none absolute inset-x-0"
                                        style={{ top: curTop, height: curH }}
                                    >
                                        <EdgeFlash key={tileFlash.n} kind={tileFlash.kind} />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    </div>
                </div>

                {/* 2 (skip): the whole lane's edges flash blue. */}
                {laneFlash > 0 && (
                    <div
                        key={laneFlash}
                        className="pointer-events-none absolute inset-x-0 top-0 z-10"
                        style={{ height: laneH }}
                    >
                        <EdgeFlash kind="skip" />
                    </div>
                )}

                {/* The pointer, with the tag it applies (not on the end card) */}
                {current && current.kind !== "end" && (
                    <div
                        ref={pointerRef}
                        className={`pointer-events-none absolute z-20 w-max flex-col items-center whitespace-nowrap ${
                            current.kind === "card" && !picking ? "hidden" : "flex"
                        }`}
                    >
                        <PointerLabel onFile={onFile} originTop={!hasMouse} />
                    </div>
                )}

                {/* The strip: tag, place, keys, and the run's progress */}
                <div
                    className="absolute inset-x-0 bottom-0 flex flex-col justify-end border-t border-neutral-800 bg-neutral-950"
                    style={{ height: STRIP_PX }}
                >
                    <div className="flex items-center gap-3 px-3 pb-1 text-[11px] text-neutral-500">
                        {tag ? (
                            <span className="origin-left scale-90">
                                <TagPill tag={tag} applied />
                            </span>
                        ) : (
                            <span className="text-neutral-400">Pass complete</span>
                        )}
                        {tr && (
                            <span className="tabular-nums text-neutral-300">
                                {Math.max(0, run.pos + 1)} / {listLen}
                            </span>
                        )}
                        {tp && (tp.of > 1 || tp.rest) && (
                            <span className="tabular-nums">
                                tag {tp.n} of {tp.of}
                                {tp.rest && " (rest)"}
                            </span>
                        )}
                        <span className="ml-auto truncate">
                            1 back · Space yes · 2 skip · 3 no
                        </span>
                    </div>
                    <div className="h-[3px] bg-neutral-800">
                        <div
                            className="h-full bg-neutral-400 transition-[width] duration-200"
                            style={{ width: `${total > 0 ? Math.min(1, done / total) * 100 : 100}%` }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

/** The thin top and bottom edges flashing: white added, amber already on,
 *  violet can't change here, blue skipped. */
function EdgeFlash({ kind }: { kind: FlashKind | "skip" }): JSX.Element {
    const color =
        kind === "on"
            ? "bg-white/80"
            : kind === "already"
              ? "bg-amber-300/90"
              : kind === "skip"
                ? "bg-sky-400/90"
                : "bg-violet-400/85";
    return (
        <>
            {["top-0", "bottom-0"].map((edge) => (
                <div
                    key={edge}
                    className={`pointer-events-none absolute inset-x-0 z-10 ${edge} h-[3px] ${color}`}
                    style={{
                        animation:
                            kind === "already"
                                ? "sweep-flash-twice 900ms ease-out forwards"
                                : "sweep-flash 900ms ease-out forwards",
                    }}
                />
            ))}
        </>
    );
}

function PassTile({
    item,
    run,
    rootPath,
    current,
    onShape,
    videoRef,
}: {
    item: PassItem;
    run: Run;
    rootPath: string;
    current: boolean;
    onShape: (fileId: number, aspect: number) => void;
    videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
}): JSX.Element {
    if (item.kind === "file") {
        return (
            <PassMedia
                file={item.file}
                rootPath={rootPath}
                current={current}
                onShape={onShape}
                videoRef={videoRef}
            />
        );
    }
    return <PassCard item={item} run={run} current={current} />;
}

function PassMedia({
    file,
    rootPath,
    current,
    onShape,
    videoRef,
}: {
    file: DbFile;
    rootPath: string;
    current: boolean;
    onShape: (fileId: number, aspect: number) => void;
    videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
}): JSX.Element {
    const { volume } = useSettings();
    const ref = useRef<HTMLVideoElement | null>(null);
    const url = toMediaUrl(rootPath, file.path, file.content_hash);
    useEffect(() => {
        if (ref.current) ref.current.volume = volumeLevel(volume);
    }, [volume]);
    useEffect(() => {
        if (!videoRef) return;
        videoRef.current = ref.current;
        return () => {
            if (videoRef.current === ref.current) videoRef.current = null;
        };
    }, [videoRef, url]);
    if (file.media_type === "video") {
        return (
            <video
                ref={ref}
                src={url}
                className="h-full w-full object-cover"
                onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) onShape(file.id, v.videoWidth / v.videoHeight);
                }}
                muted={!current}
                autoPlay
                loop
                playsInline
                preload="metadata"
            />
        );
    }
    return (
        <img
            src={url}
            className="h-full w-full object-cover"
            draggable={false}
            onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight) onShape(file.id, img.naturalWidth / img.naturalHeight);
            }}
        />
    );
}

/** A tag card (or the end card): a stop in the lane, not a file. */
function PassCard({
    item,
    run,
    current,
}: {
    item: Exclude<PassItem, { kind: "file" }>;
    run: Run;
    current: boolean;
}): JSX.Element {
    const { tagMap } = useTags();
    if (item.kind === "end") return <EndCard run={run} current={current} />;
    const tr = run.tags[item.t];
    const tag = tagMap.get(tr.tagId);
    const left = tr.files ? tr.files.length : (run.estimates[tr.tagId] ?? null);
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-900 p-6 text-center">
            {tag && (
                <span className="flex items-center gap-2 rounded-full bg-neutral-200 px-5 py-2 text-3xl font-semibold text-neutral-900">
                    {tag.category && (
                        <span
                            className="rounded-full bg-neutral-900 px-2 py-1 text-xl leading-none"
                            style={{ color: tag.category.color ?? undefined }}
                        >
                            {tag.category.icon}
                        </span>
                    )}
                    {tag.name}
                </span>
            )}
            {left != null && (
                <span className="text-base text-neutral-300 tabular-nums">
                    {left.toLocaleString()} file{left === 1 ? "" : "s"}
                </span>
            )}
            <span className="text-xs text-neutral-500">Space = has it · 3 = doesn&apos;t · 2 = skip</span>
        </div>
    );
}

/** Whole percent, rounded down (never 100% before it is); a little shows
 *  as "<1%". */
function pct(checked: number, files: number): string {
    if (files === 0) return "0%";
    const p = (checked / files) * 100;
    if (p > 0 && p < 1) return "<1%";
    return `${Math.floor(p)}%`;
}

/** The end of the run: each tag's coverage before → after, for the run's
 *  files (big) and the library (small). */
function EndCard({ run, current }: { run: Run; current: boolean }): JSX.Element {
    const { tagMap } = useTags();
    const { coverageSeconds } = useSettings();
    const tagIds = useMemo(() => [...new Set(run.tags.map((x) => x.tagId))], [run.tags]);
    const files = run.tags.reduce((s, x) => s + (x.files?.length ?? 0), 0);
    const [after, setAfter] = useState<Record<number, CoverageSnap> | null>(null);
    // Read once it's reached (as the next tile over, the last answer
    // isn't in yet).
    useEffect(() => {
        if (!current) return;
        let gone = false;
        snapCoverage(run.scope, tagIds, coverageSeconds)
            .then((a) => !gone && setAfter(a))
            .catch(() => {});
        return () => {
            gone = true;
        };
    }, [current, run.scope, tagIds, coverageSeconds]);
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-y-auto bg-neutral-900 p-6 text-center">
            <span className="text-2xl font-semibold text-neutral-100">Pass complete</span>
            <span className="text-sm text-neutral-400 tabular-nums">
                {tagIds.length} tag{tagIds.length === 1 ? "" : "s"} · {files.toLocaleString()} file
                {files === 1 ? "" : "s"}
            </span>
            <div className="flex flex-col gap-2">
                {tagIds.map((id) => {
                    const tag = tagMap.get(id);
                    const b = run.before[id];
                    const a = after?.[id];
                    return (
                        <div key={id} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                            {tag && <TagPill tag={tag} applied />}
                            {b && a ? (
                                <>
                                    <span className="text-base text-neutral-100 tabular-nums">
                                        {pct(b.scope.checked, b.scope.files)} → {pct(a.scope.checked, a.scope.files)}{" "}
                                        <span className="text-xs text-neutral-500">here</span>
                                    </span>
                                    <span className="text-xs text-neutral-500 tabular-nums">
                                        library {pct(b.library.checked, b.library.files)} →{" "}
                                        {pct(a.library.checked, a.library.files)}
                                    </span>
                                </>
                            ) : (
                                <span className="text-xs text-neutral-600">{b ? "…" : ""}</span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
