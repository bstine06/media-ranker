import React, { useEffect, useRef } from "react";
import type { DbTag } from "@renderer/shared/types/types";
import {
    SEARCH_CARD,
    useTagPointer,
    type MediaFlashState,
} from "@renderer/contexts/TagPointerContext";
import { useFileTags } from "@renderer/hooks/useFileTags";

// The tag pointer's drawing: the pill with the tag, the picker's rolodex,
// lists and search results, the countdown, and the triangle whose tip is
// the spot it points at. Sweep places it itself (lanes, a resting spot);
// everywhere else the cursor overlay below carries it on the cursor.

/** A tag on a file as the file's tag list reports it. */
type OnFile = DbTag & { inherited?: boolean; inheritedVia?: string };

/** How many tags show on each side of the one at the history cursor. */
const STACK_SHOWN = 2;
/** Per distance from the cursor: how far a card sits (px), its size and
 *  how visible it is. The last entry is just past what's shown. */
const STACK_RISE = [0, 22, 40, 54];
const STACK_SCALE = [1, 0.82, 0.68, 0.56];
// Fully opaque (cards behind don't show through), just gone past what's shown.
const STACK_OPACITY = [1, 1, 1, 0];
/** How long the history stack takes to slide one step (ms). */
const STACK_MS = 120;

/** Where a history card sits: slot 0 is the main pill's place, older ones
 *  rise above it smaller, newer ones (after Tab) drop below. */
function stackSlotStyle(slot: number): React.CSSProperties {
    const d = Math.min(Math.abs(slot), STACK_RISE.length - 1);
    const dir = Math.sign(slot); // 1 above, -1 below
    return {
        transform: `translateX(-50%) translateY(${-dir * STACK_RISE[d]}px) scale(${STACK_SCALE[d]})`,
        opacity: STACK_OPACITY[d],
        zIndex: 10 - d,
        transition: `transform ${STACK_MS}ms ease-out, opacity ${STACK_MS}ms ease-out, background-color ${STACK_MS}ms`,
    };
}

/**
 * A toggle's feedback over a piece of media, the same as Sweep's tiles: a
 * thin bar along the top and bottom. White: added. Amber, blinking twice:
 * it was already on (press again to take it off). Red: it can't be changed
 * here (inherited).
 */
export function MediaFlash({ flash }: { flash: MediaFlashState }): JSX.Element | null {
    if (!flash) return null;
    return (
        <React.Fragment key={flash.n}>
            {["top-0", "bottom-0"].map((edge) => (
                <div
                    key={edge}
                    className={`pointer-events-none absolute inset-x-0 z-30 ${edge} h-[3px] ${
                        flash.kind === "on"
                            ? "bg-white/80"
                            : flash.kind === "already"
                              ? "bg-amber-300/90"
                              : "bg-red-400/80"
                    }`}
                    style={{
                        animation:
                            flash.kind === "already"
                                ? "sweep-flash-twice 900ms ease-out forwards"
                                : "sweep-flash 900ms ease-out forwards",
                    }}
                />
            ))}
        </React.Fragment>
    );
}

/**
 * The pointer's contents, for a positioned parent (its tip is the bottom
 * centre, unless `originTop`: resting with nothing pointed at).
 * `onFile`: the tag as it is on the file pointed at (✓ when it's there).
 */
export function PointerLabel({
    onFile,
    originTop = false,
}: {
    onFile: OnFile | undefined;
    originTop?: boolean;
}): JSX.Element {
    const {
        tag,
        rolling,
        countdown,
        picking,
        closePicker,
        query,
        searchMode,
        setSearchMode,
        highlight,
        setHighlight,
        matches,
        stack,
        cursor,
        listMode,
        listItems,
        listIndex,
        related,
        pickFill,
        resultsAbove,
    } = useTagPointer();

    // The countdown bar's fill, sized from the deadline every frame.
    const countdownFill = useRef<HTMLDivElement>(null);
    const countdownNow = useRef(countdown);
    countdownNow.current = countdown;
    const hasCountdown = countdown != null;
    useEffect(() => {
        if (!hasCountdown) return;
        let raf = 0;
        const frame = () => {
            const cd = countdownNow.current;
            const fill = countdownFill.current;
            if (cd && fill) {
                const left = Math.max(0, cd.deadline - Date.now());
                fill.style.width = `${(left / (cd.interval * 1000)) * 100}%`;
                // The last 3 seconds pulse.
                fill.dataset.ending = left < 3000 ? "1" : "0";
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [hasCountdown]);

    return (
        <>
            {/* Enlarged while picking, growing away from the tip. */}
            <div
                className={`flex flex-col items-center transition-transform duration-150 ${
                    picking ? "scale-[1.25]" : ""
                } ${originTop ? "origin-top" : "origin-bottom"}`}
            >
                <div className="relative mt-2 flex flex-col items-stretch">
                    {/* Held + 1 / 2 / 3: which list is showing. Hidden when 3's
                        results open upward, over where it sits. */}
                    {picking && listMode && !(listMode === "excluded" && searchMode && resultsAbove) && (
                        <div className="pointer-events-none absolute bottom-full left-1/2 mb-[62px] flex -translate-x-1/2 gap-1 whitespace-nowrap rounded-full bg-black/80 px-2 py-0.5 text-[10px] shadow">
                            {(
                                [
                                    ["category", "1 same category"],
                                    ["related", "2 related"],
                                    ["excluded", "3 excluded"],
                                ] as const
                            ).map(([m, label]) => (
                                <span
                                    key={m}
                                    className={`rounded-full px-1.5 ${
                                        listMode === m ? "bg-neutral-200 text-neutral-900" : "text-neutral-400"
                                    }`}
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                    )}
                    {/* A list with nothing in it says so. */}
                    {picking && listMode && !searchMode && listItems.length <= 1 && (
                        <div
                            className="pointer-events-none absolute left-1/2 top-0 min-w-[5rem] whitespace-nowrap rounded-full bg-neutral-900 px-3 py-1 text-xs text-neutral-400 shadow-lg"
                            style={stackSlotStyle(1)}
                        >
                            {listMode === "excluded"
                                ? "No tags are excluded from the tag pointer"
                                : listMode === "category"
                                  ? "No other tags in this category"
                                  : related === null
                                    ? "Finding related tags…"
                                    : "No related tags yet"}
                        </div>
                    )}
                    {/* The history stack (or a list), a rolodex over the main
                        pill. Each keeps its element, so moving rolls them. */}
                    {picking &&
                        !searchMode &&
                        (listMode ? listItems : stack).map((t, i) => {
                            const inList = listMode != null;
                            const slot = i - (inList ? listIndex : cursor);
                            if (slot < -STACK_SHOWN - 1 || slot > STACK_SHOWN + 1) return null;
                            const isCurrent =
                                i === 0 && listMode !== "excluded" && tag != null && t.id === tag.id;
                            const isSearchCard = t.id === SEARCH_CARD.id;
                            return (
                                <div
                                    key={t.id}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        // The current one just lets go; "search…" waits for typing.
                                        if (isSearchCard) setSearchMode(true);
                                        else closePicker(isCurrent ? undefined : t);
                                    }}
                                    title={
                                        isSearchCard
                                            ? "Type to search tags not offered in the tag pointer"
                                            : isCurrent
                                              ? "Keep this tag"
                                              : inList
                                                ? "Use this tag"
                                                : "Back to this tag (Space)"
                                    }
                                    className={`pointer-events-auto absolute left-1/2 top-0 flex min-w-[5rem] cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-full px-3 py-1 text-xs font-medium shadow-lg backdrop-blur ${
                                        slot === 0
                                            ? "bg-neutral-900 text-neutral-100 ring-1 ring-white/50"
                                            : "bg-neutral-900 text-neutral-400"
                                    }`}
                                    style={stackSlotStyle(slot)}
                                >
                                    {/* About to be picked from resting on it: fills left to right. */}
                                    {slot === 0 && pickFill && (
                                        <span
                                            key={pickFill.seq}
                                            className="pointer-events-none absolute inset-0 -z-10 origin-left bg-white/15"
                                            style={{ animation: `sweep-pick-fill ${pickFill.ms}ms linear forwards` }}
                                        />
                                    )}
                                    {t.category && (
                                        <span
                                            className="rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none"
                                            style={{ color: t.category.color }}
                                        >
                                            {t.category.icon}
                                        </span>
                                    )}
                                    {isSearchCard ? (
                                        <span className="text-neutral-500">search…</span>
                                    ) : isCurrent && onFile ? (
                                        `✓ ${t.name}`
                                    ) : (
                                        t.name
                                    )}
                                </div>
                            );
                        })}
                    <div
                        style={
                            // In the stack view the stack shows its own pill
                            // here; this one keeps the place.
                            picking && !searchMode ? { visibility: "hidden" } : undefined
                        }
                        // min-w: one typed letter mustn't shrink it to a dot.
                        className={`relative flex min-w-[5rem] items-center justify-center gap-1.5 overflow-hidden rounded-full px-3 py-1 text-xs font-medium shadow-lg backdrop-blur transition-colors ${
                            picking
                                ? "bg-neutral-900 text-neutral-100 ring-1 ring-white/50"
                                : onFile && !rolling
                                  ? "bg-neutral-100 text-neutral-900"
                                  : "bg-black/70 text-neutral-200"
                        } ${onFile?.inherited && !rolling && !picking ? "opacity-60" : ""}`}
                        title={
                            onFile?.inherited
                                ? onFile.inheritedVia
                                    ? `Comes with "${onFile.inheritedVia}"`
                                    : "From the folder's tags"
                                : undefined
                        }
                    >
                        {picking && searchMode ? (
                            // What's typed, live (the pill is the search).
                            <span className="relative flex items-center">
                                {!query && listMode === "excluded" && (
                                    <span className="text-neutral-500">excluded tags…</span>
                                )}
                                <span>{query}</span>
                                <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-neutral-200" />
                            </span>
                        ) : (
                            (() => {
                                const shown = rolling ?? tag;
                                return (
                                    <>
                                        {shown?.category && (
                                            // Dark backing: the label turns white, and so are some category colors.
                                            <span
                                                className="relative rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none"
                                                style={{ color: shown.category.color }}
                                            >
                                                {shown.category.icon}
                                            </span>
                                        )}
                                        <span className="relative">
                                            {rolling
                                                ? rolling.name
                                                : tag
                                                  ? onFile
                                                      ? `✓ ${tag.name}`
                                                      : tag.name
                                                  : "pick a tag"}
                                        </span>
                                    </>
                                );
                            })()
                        )}
                    </div>
                    {/* Time left until the next random tag (as wide as the label) */}
                    {countdown && !rolling && !picking && (
                        <div className="mx-2 mt-1 h-1.5 overflow-hidden rounded-full bg-black/60 shadow">
                            <div
                                ref={countdownFill}
                                className="sweep-countdown-fill h-full rounded-full bg-neutral-200"
                                style={{ width: "100%" }}
                            />
                        </div>
                    )}
                </div>
                {/* Hidden in the hold (still taking its space, so nothing shifts). */}
                <svg width="22" height="14" viewBox="0 0 22 14" className={`drop-shadow ${picking ? "invisible" : ""}`}>
                    <path
                        d="M1 1 H21 L11 13 Z"
                        fill={onFile && !picking ? "#f5f5f5" : "rgba(0,0,0,0.7)"}
                        stroke="#f5f5f5"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                    />
                </svg>
            </div>

            {/* Suggestions, while something's typed */}
            {picking && searchMode && (query || listMode === "excluded") && (
                <div
                    className={`pointer-events-auto absolute left-1/2 min-w-[12rem] -translate-x-1/2 overflow-hidden rounded-md border border-neutral-700 bg-neutral-950/95 text-xs shadow-xl backdrop-blur ${
                        resultsAbove ? "bottom-full mb-2" : "top-full mt-2"
                    }`}
                >
                    {matches.length > 0 ? (
                        matches.map((t, i) => (
                            <button
                                key={t.id}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closePicker(t);
                                }}
                                onMouseEnter={() => setHighlight(i)}
                                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                                    i === highlight ? "bg-neutral-800 text-white" : "text-neutral-300"
                                }`}
                            >
                                <span className="w-3 text-center text-[10px]" style={{ color: t.category?.color }}>
                                    {t.category?.icon ?? ""}
                                </span>
                                {t.name}
                            </button>
                        ))
                    ) : (
                        <div className="px-3 py-2 text-neutral-500">
                            {listMode === "excluded" && !query
                                ? "No tags are excluded from the tag pointer"
                                : "No tags match"}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}

/**
 * The pointer on the cursor, off Sweep: shown while the cursor is over a
 * piece of media (a pointer target) and the pointer isn't put away. It
 * holds still while the picker is open, so results can be clicked.
 */
export function CursorPointer(): JSX.Element | null {
    const { enabled, target, hidden, picking, pickingRef, tag } = useTagPointer();
    const ref = useRef<HTMLDivElement>(null);
    const at = useRef({ x: 0, y: 0 });
    const show = enabled && target != null && !target.ownPointer && (!hidden || picking);
    // Moved off the mouse (Compare's 1 / 3): drawn there until the target
    // says otherwise.
    const pointAt = useRef(target?.pointAt);
    pointAt.current = target?.pointAt;

    const place = () => {
        const el = ref.current;
        if (!el) return;
        const p = pointAt.current ?? at.current;
        el.style.left = `${p.x}px`;
        // Kept low enough that the label isn't cut off at the top.
        el.style.top = `${Math.max(p.y, el.offsetHeight)}px`;
    };
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (pickingRef.current) return;
            at.current = { x: e.clientX, y: e.clientY };
            place();
        };
        window.addEventListener("mousemove", onMove, true);
        return () => window.removeEventListener("mousemove", onMove, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Shown, grown for the picker or moved: place it now that it has a size.
    useEffect(() => {
        if (show) place();
    });

    const { tags } = useFileTags(show ? target!.file.id : null);
    const onFile = tag ? (tags.find((t) => t.id === tag.id) as OnFile | undefined) : undefined;

    return (
        <div
            ref={ref}
            className={`pointer-events-none fixed z-50 w-max flex-col items-center whitespace-nowrap ${
                show ? "flex" : "hidden"
            }`}
            style={{ transform: "translate(-50%, -100%)" }}
        >
            <PointerLabel onFile={onFile} />
        </div>
    );
}
