import {
    useEffect,
    useState,
    useCallback,
    useRef,
    useMemo,
} from "react";
import type {
    DbFile,
    DbTag,
    PlacementBounds,
    PoolFilter,
    View,
} from "../shared/types/types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { preloadImage } from "../lib/imageCache";
import { MediaPlayer, type MediaControls } from "./MediaPlayer";
import { claimSpaceAndTab, isTyping } from "@renderer/lib/keys";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { showInFolder } from "@renderer/lib/filesystem";
import { TagPill } from "./TagPill";
import { CrownIcon } from "./icons/CrownIcon";
import { FolderIcon } from "./icons/FolderIcon";
import { RotateIcon } from "./icons/RotateIcon";
import { useRotation } from "@renderer/hooks/useRotation";
import { useLibraryRank } from "@renderer/contexts/RankContext";
import {
    useKingOfHill,
    type KingState,
} from "@renderer/contexts/KingOfHillContext";
import SingleFileView from "./SingleFileView";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useStatus } from "@renderer/contexts/StatusContext";
import { usePlacement, PLACEMENT_MATCHES } from "@renderer/contexts/PlacementContext";
import {
    useTagPointer,
    useTagPointerSurface,
    usePointerCursorClass,
    type MediaFlashState,
    type PointerTarget,
} from "@renderer/contexts/TagPointerContext";
import { MediaFlash } from "./TagPointer";

async function preloadFile(rootPath: string, file: DbFile): Promise<void> {
    if (file.media_type === "video") return;
    preloadImage(toMediaUrl(rootPath, file.path, file.content_hash));
}

type Side = "a" | "b";

// After a new pair appears, ignore S this long so an extra keypress meant
// for the last round doesn't pick on the new one.
const PICK_LOCKOUT_MS = 175;

// The info bar slides in when the cursor is within this many px of a card's top.
const INFO_BAR_ZONE_PX = 88;

// How many picks W can step back through.
const UNDO_LIMIT = 5;

// Placement (main/placement.ts): the file being placed stays on its side
// while opponents are picked by binary search over the other side's pool.
interface PlacementState {
    file: DbFile;
    side: Side;
    /** The opponents' pool (the other side's filters). */
    pool: PoolFilter;
    bounds: PlacementBounds;
    /** Opponents already faced, so the search doesn't repeat them. */
    recent: number[];
    /** The session it belongs to; a different session starts over. */
    key: string;
    /** Comparison count it had when its placement started… */
    startCount: number;
    /** …and the count at which it's done. */
    target: number;
}

interface UndoEntry {
    comparisonId: number;
    pair: [DbFile, DbFile];
    focus: Side;
    king: KingState | null;
    recentChallengers: number[];
    placement: PlacementState | null;
}

export default function CompareView({
    active,
    setView,
}: {
    active: boolean;
    setView: (view: View) => void;
}): JSX.Element {
    const [pair, setPair] = useState<[DbFile, DbFile] | null>(null);
    const [loading, setLoading] = useState(true);
    const [comparing, setComparing] = useState(false);
    // Always one side focused: it has sound and gets V / Q / E (Tab switches).
    // Starts on the left, then follows whichever side won the last round.
    const [focus, setFocus] = useState<Side>("a");
    const [inspectedFile, setInspectedFile] = useState<DbFile | null>(null);

    const undoStackRef = useRef<UndoEntry[]>([]);
    const pairShownAtRef = useRef(0);
    const controlsA = useRef<MediaControls | null>(null);
    const controlsB = useRef<MediaControls | null>(null);
    // Each card's rotate-left, for R on the focused side.
    const rotateA = useRef<(() => void) | null>(null);
    const rotateB = useRef<(() => void) | null>(null);

    const { activeTags, tagMode } = useTags();
    const {
        compareBothAudio,
        toggleCompareBothAudio,
    } = useSettings();
    const { setStatus, resetStatus } = useStatus();
    // Placement runs only as a session: a collection's new files, or one
    // file, against the whole library (see the placement branch in loadPair).
    const { session, endSession, bump } = usePlacement();
    const placementRef = useRef<PlacementState | null>(null);
    // Mirrors placementRef for rendering (badge, banner).
    const [placing, setPlacing] = useState<PlacementState | null>(null);
    const [placementLeft, setPlacementLeft] = useState<number | null>(null);
    // Status messages from Compare: a new one cancels the previous one's
    // timer, so an older message's reset can't wipe a newer message.
    const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashStatus = (message: string, ms: number) => {
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        setStatus(message);
        statusTimerRef.current = setTimeout(resetStatus, ms);
    };
    const setPlacement = (st: PlacementState | null) => {
        placementRef.current = st;
        setPlacing(st);
    };
    const { rootPath, laneFolderPrefixes, setActiveFolder } = useFolders();
    // Each side's folders come from the sidebar's L / R checkboxes.
    const laneKey = JSON.stringify(laneFolderPrefixes);

    const tagKey = useMemo(
        () => [...activeTags].sort().join(","),
        [activeTags],
    );

    // Next pair, fetched + preloaded in the background. Tagged with the filter
    // state it was fetched under so it's discarded if filters change.
    const prefetchedRef = useRef<{
        key: string;
        pair: [DbFile, DbFile];
    } | null>(null);

    // ── King of the Hill ────────────────────────────────────────────────────
    const { king, crown, setKing, endKing } = useKingOfHill();
    // loadPair reads the king from here so it doesn't need to be recreated
    // (and re-triggered) every time the king's streak/score changes.
    const kingRef = useRef<KingState | null>(king);
    kingRef.current = king;
    // Challengers the king has faced recently, so it doesn't see repeats.
    const recentChallengersRef = useRef<number[]>([]);

    const loadPair = useCallback(
        async (
            k: KingState | null = kingRef.current,
            // Filters changed with this pair on screen: keep whichever sides
            // still fit and replace only the rest.
            refit?: [DbFile, DbFile],
        ) => {
            const tagList = activeTags.size > 0 ? [...activeTags] : null;
            const lanes: Record<Side, string[] | null> = JSON.parse(laneKey);
            const filterKey = JSON.stringify([
                laneKey,
                tagKey,
                tagMode,
                rootPath,
                k?.file.id ?? null,
            ]);

            // Folders per side; tags apply to both.
            const laneFilter = (side: Side): PoolFilter => ({
                folderPrefixes: lanes[side],
                tagList,
                tagMode,
            });

            const fetchNext = async (): Promise<[DbFile, DbFile] | null> => {
                if (!k) {
                    // Same folders on both sides: the usual single-pool pick.
                    if (JSON.stringify(lanes.a) === JSON.stringify(lanes.b)) {
                        return window.api.getPair(lanes.a, tagList, tagMode);
                    }
                    return window.api.getLanePair(
                        laneFilter("a"),
                        laneFilter("b"),
                    );
                }
                // Challengers come from the lane opposite the king.
                const pool = laneFilter(k.side === "a" ? "b" : "a");
                const challenger = await window.api.getChallenger(
                    k.file.id,
                    pool.folderPrefixes,
                    pool.tagList,
                    pool.tagMode,
                    recentChallengersRef.current,
                );
                if (!challenger) return null;
                return k.side === "a"
                    ? [k.file, challenger]
                    : [challenger, k.file];
            };

            // ── Placement session (Browse's "Place N new", or one file's
            // Place button). The file being placed stays on the left, against
            // the whole library. (A king, crowned by hand, takes priority.)
            if (!k && session) {
                const wholeLibrary: PoolFilter = {
                    folderPrefixes: null,
                    tagList: null,
                    tagMode: "or",
                };
                const key =
                    session.kind === "folder"
                        ? `folder:${session.folder}`
                        : `file:${session.file.id}`;
                let st = placementRef.current?.key === key ? placementRef.current : null;
                let done = false;

                if (session.kind === "file") {
                    // Fresh matches from wherever it stands now, however many
                    // comparisons it already has.
                    if (!st) {
                        const start = session.file.comparison_count;
                        st = {
                            file: session.file,
                            side: "a",
                            pool: wholeLibrary,
                            bounds: { lo: 0, hi: 1 },
                            recent: [],
                            key,
                            startCount: start,
                            target: start + PLACEMENT_MATCHES,
                        };
                    }
                    done = st.file.comparison_count >= st.target;
                } else {
                    const folderPool: PoolFilter = {
                        folderPrefixes: [session.folder],
                        tagList: null,
                        tagMode: "or",
                    };
                    if (st && st.file.comparison_count >= st.target) st = null;
                    if (!st) {
                        const cand = await window.api.getPlacementCandidate(
                            folderPool,
                            folderPool,
                            PLACEMENT_MATCHES,
                            wholeLibrary,
                        );
                        if (cand) {
                            st = {
                                file: cand.file,
                                side: "a",
                                pool: wholeLibrary,
                                bounds: await window.api.getPlacementBounds(
                                    cand.file.id,
                                    wholeLibrary,
                                    PLACEMENT_MATCHES,
                                ),
                                recent: [],
                                key,
                                startCount: 0,
                                target: PLACEMENT_MATCHES,
                            };
                        }
                    }
                    window.api
                        .countPlacementCandidates(folderPool, folderPool, PLACEMENT_MATCHES)
                        .then(setPlacementLeft)
                        .catch(() => {});
                }

                const opponent =
                    st && !done
                        ? await window.api.getPlacementOpponent(
                              st.file.id,
                              st.pool,
                              PLACEMENT_MATCHES,
                              st.bounds,
                              st.recent,
                          )
                        : null;
                if (st && opponent) {
                    setPlacement(st);
                    prefetchedRef.current = null;
                    setPair([st.file, opponent]);
                    setLoading(false);
                    return;
                }

                // Finished (or nothing to do): back where it was started.
                setPlacement(null);
                endSession();
                setView(session.returnTo);
                if (session.kind === "folder") {
                    const n = session.total;
                    flashStatus(
                        n > 0
                            ? `Placed ${n} file${n === 1 ? "" : "s"} in ${session.folder}`
                            : `Nothing left to place in ${session.folder}`,
                        3000,
                    );
                } else if (!done) {
                    flashStatus("Nothing else in the library to compare it with", 3000);
                }
                // A finished file's "Placed … at #n" was shown by its last pick.
                return;
            }

            const prefetched = prefetchedRef.current;
            prefetchedRef.current = null;

            let result: [DbFile, DbFile] | null;
            if (refit) {
                result = await window.api.refitPair(
                    [refit[0].id, refit[1].id],
                    laneFilter("a"),
                    laneFilter("b"),
                    k?.side ?? null,
                    recentChallengersRef.current,
                );
            } else if (prefetched && prefetched.key === filterKey) {
                result = prefetched.pair;
                // Use the king's latest score, not the one from prefetch time.
                if (k) {
                    result =
                        k.side === "a"
                            ? [k.file, result[1]]
                            : [result[0], k.file];
                }
            } else {
                setLoading(true);
                result = await fetchNext();
            }

            // King vanished (deleted/missing) or no challengers left: drop
            // back to normal mode rather than showing an empty screen.
            if (k && !result) {
                endKing();
                kingRef.current = null;
                return loadPair(null);
            }

            if (k && result) {
                const challenger = k.side === "a" ? result[1] : result[0];
                recentChallengersRef.current = [
                    challenger.id,
                    ...recentChallengersRef.current.filter(
                        (id) => id !== challenger.id,
                    ),
                ].slice(0, 10);
            }

            setPair(result);
            setLoading(false);

            fetchNext().then((next) => {
                if (!next) return;
                // Don't queue up the exact pair we're showing right now.
                const showing = result ? [result[0].id, result[1].id] : [];
                if (
                    showing.includes(next[0].id) &&
                    showing.includes(next[1].id)
                ) {
                    return;
                }
                prefetchedRef.current = { key: filterKey, pair: next };
                preloadFile(rootPath!, next[0]);
                preloadFile(rootPath!, next[1]);
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [laneKey, rootPath, tagKey, tagMode, endKing, session],
    );

    // Starting a session from Browse: placement takes over (a king would
    // otherwise hold the screen).
    useEffect(() => {
        if (!session) return;
        endKing();
        kingRef.current = null;
        setPlacement(null);
        // Started from a file opened here: show the matches, not the file.
        setInspectedFile(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);

    // Filters changed (or first load). With a pair already up from the same
    // library, refit it so only sides that no longer fit get swapped.
    // A file edited in place (e.g. rotated in the single file view) shows
    // its new version here too: same record, new content hash.
    // Also called directly by a card that rotated its file, so the new
    // version is in place before the preview turn is dropped.
    const replaceFile = useCallback(
        (file: DbFile) => {
            const swap = (f: DbFile): DbFile => (f.id === file.id ? file : f);
            setPair((p) => (p ? [swap(p[0]), swap(p[1])] : p));
            if (kingRef.current?.file.id === file.id) {
                const k = { ...kingRef.current, file };
                kingRef.current = k;
                setKing(k);
            }
            setInspectedFile((f) => (f ? swap(f) : f));
            const st = placementRef.current;
            if (st?.file.id === file.id) setPlacement({ ...st, file });
            undoStackRef.current = undoStackRef.current.map((e) => ({
                ...e,
                pair: [swap(e.pair[0]), swap(e.pair[1])],
                king:
                    e.king?.file.id === file.id ? { ...e.king, file } : e.king,
            }));
            const pre = prefetchedRef.current;
            if (pre) pre.pair = [swap(pre.pair[0]), swap(pre.pair[1])];
        },
        [setKing],
    );
    useEffect(() => {
        return window.api.onMediaUpdated(({ file }) => {
            if (file) replaceFile(file);
        });
    }, [replaceFile]);

    // After the launch catch-up scan the queued pair may include files that
    // turned out to be gone; fetch a fresh one when it's needed.
    useEffect(() => {
        return window.api.onLibraryScanned(() => {
            prefetchedRef.current = null;
        });
    }, []);

    const pairRef = useRef(pair);
    pairRef.current = pair;
    const loadedRootRef = useRef(rootPath);
    useEffect(() => {
        const current = pairRef.current;
        const sameLibrary = loadedRootRef.current === rootPath;
        loadedRootRef.current = rootPath;
        if (current && sameLibrary) loadPair(undefined, current);
        else loadPair();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadPair]);

    // Files deleted or moved from another view (or in Finder). The handlers
    // are subscribed once, so they reach loadPair through a ref.
    const loadPairRef = useRef(loadPair);
    loadPairRef.current = loadPair;
    useEffect(() => {
        const offRemoved = window.api.onMediaRemoved(({ relativePath }) => {
            const gone = (f: DbFile) => f.path === relativePath;
            const pre = prefetchedRef.current;
            if (pre && pre.pair.some(gone)) prefetchedRef.current = null;
            // Undoing would bring the deleted file back on screen.
            undoStackRef.current = undoStackRef.current.filter(
                (e) => !e.pair.some(gone),
            );
            setInspectedFile((f) => (f && gone(f) ? null : f));
            if (placementRef.current && gone(placementRef.current.file)) {
                setPlacement(null);
            }

            const current = pairRef.current;
            if (!current?.some(gone)) return;
            let k = kingRef.current;
            if (k && gone(k.file)) {
                endKing();
                k = null;
                kingRef.current = null;
            }
            // Refit keeps the side that's still there and replaces the other.
            loadPairRef.current(k, current);
        });

        const offRenamed = window.api.onMediaRenamed(
            ({ oldRelativePath, relativePath }) => {
                const move = (f: DbFile): DbFile =>
                    f.path === oldRelativePath
                        ? {
                              ...f,
                              path: relativePath,
                              filename:
                                  relativePath.split("/").pop() ?? f.filename,
                          }
                        : f;
                const movePair = (p: [DbFile, DbFile]): [DbFile, DbFile] => [
                    move(p[0]),
                    move(p[1]),
                ];
                setPair((p) => (p ? movePair(p) : p));
                setInspectedFile((f) => (f ? move(f) : f));
                const pre = prefetchedRef.current;
                if (pre) pre.pair = movePair(pre.pair);
                undoStackRef.current = undoStackRef.current.map((e) => ({
                    ...e,
                    pair: movePair(e.pair),
                    king: e.king ? { ...e.king, file: move(e.king.file) } : e.king,
                }));
                const st = placementRef.current;
                if (st && st.file.path === oldRelativePath) {
                    setPlacement({ ...st, file: move(st.file) });
                }
                const k = kingRef.current;
                if (k && k.file.path === oldRelativePath) {
                    const next = { ...k, file: move(k.file) };
                    kingRef.current = next;
                    setKing(next);
                }
            },
        );

        return () => {
            offRemoved();
            offRenamed();
        };
    }, [endKing, setKing]);

    // A king crowned from elsewhere (Browse, single file view) isn't on screen yet,
    // so pull up a matchup for it. Crowning a card that's already showing,
    // or a challenger taking the hill, keeps the current pair.
    useEffect(() => {
        if (!king) return;
        if (pair?.some((f) => f.id === king.file.id)) return;
        loadPair(king);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [king?.file.id]);

    useEffect(() => {
        pairShownAtRef.current = performance.now();
    }, [pair]);

    const handlePick = useCallback(
        async (winnerSide: Side) => {
            if (comparing || !pair) return;
            const winner = winnerSide === "a" ? pair[0] : pair[1];
            const loser = winnerSide === "a" ? pair[1] : pair[0];
            setComparing(true);
            const kingBefore = kingRef.current;
            const recentBefore = recentChallengersRef.current;
            const placementBefore = placementRef.current;
            const pushUndo = (comparisonId: number) => {
                undoStackRef.current = [
                    ...undoStackRef.current,
                    {
                        comparisonId,
                        pair,
                        focus,
                        king: kingBefore,
                        recentChallengers: recentBefore,
                        placement: placementBefore,
                    },
                ].slice(-UNDO_LIMIT);
            };

            // A placement match: narrows the file's range and sets its score.
            const st = placementRef.current;
            if (st && !kingBefore && pair.some((f) => f.id === st.file.id)) {
                const opponent = pair.find((f) => f.id !== st.file.id)!;
                const res = await window.api.recordPlacement(
                    st.file.id,
                    opponent.id,
                    winner.id === st.file.id,
                    st.pool,
                    PLACEMENT_MATCHES,
                    st.bounds,
                );
                if (res) {
                    pushUndo(res.comparisonId);
                    const placed = res.winner.id === st.file.id ? res.winner : res.loser;
                    setPlacement({
                        ...st,
                        file: placed,
                        bounds: res.bounds,
                        recent: [opponent.id, ...st.recent].slice(0, 30),
                    });
                    if (placed.comparison_count >= st.target) {
                        const rank =
                            res.winner.id === placed.id
                                ? res.winnerRank.after
                                : res.loserRank.after;
                        flashStatus(`Placed ${placed.filename} at #${rank}`, 2500);
                    }
                    bump();
                }
                await loadPair(null);
                setFocus(winnerSide);
                setComparing(false);
                return;
            }

            const res = await window.api.recordComparison(winner.id, loser.id);
            if (res) pushUndo(res.comparisonId);

            let nextKing = kingRef.current;
            if (res && nextKing) {
                if (winner.id === nextKing.file.id) {
                    nextKing = {
                        ...nextKing,
                        file: res.winner,
                        streak: nextKing.streak + 1,
                    };
                } else if (loser.id === nextKing.file.id) {
                    // The old king shouldn't come straight back as challenger.
                    recentChallengersRef.current = [
                        nextKing.file.id,
                        ...recentChallengersRef.current,
                    ].slice(0, 10);
                    nextKing = {
                        file: res.winner,
                        streak: 1,
                        side: winnerSide,
                    };
                }
                kingRef.current = nextKing;
                setKing(nextKing);
            }

            await loadPair(nextKing);
            setFocus(winnerSide);
            setComparing(false);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [comparing, pair, focus, loadPair, setKing, bump],
    );

    // Rolls back the last pick and puts that matchup back on screen.
    const handleUndo = useCallback(async () => {
        if (comparing) return;
        const entry = undoStackRef.current.at(-1);
        if (!entry) return;
        setComparing(true);
        const [a, b] = entry.pair;
        const fresh = await window.api.undoComparison(entry.comparisonId, [
            a.id,
            b.id,
        ]);
        undoStackRef.current = undoStackRef.current.slice(0, -1);
        if (fresh && fresh[0] && fresh[1]) {
            const restored: [DbFile, DbFile] = [fresh[0], fresh[1]];
            let k = entry.king;
            if (k) {
                const kingFile = restored.find((f) => f.id === k!.file.id);
                if (kingFile) k = { ...k, file: kingFile };
            }
            recentChallengersRef.current = entry.recentChallengers;
            kingRef.current = k;
            setKing(k);
            const p = entry.placement;
            const placedFile = p ? restored.find((f) => f.id === p.file.id) : undefined;
            setPlacement(p && placedFile ? { ...p, file: placedFile } : p);
            if (p) bump();
            setPair(restored);
            setFocus(entry.focus);
        }
        setComparing(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [comparing, setKing, bump]);

    // 2 / ↓: the focused side wins.
    const submit = useCallback(() => {
        if (comparing || !pair) return;
        if (performance.now() - pairShownAtRef.current < PICK_LOCKOUT_MS)
            return;
        handlePick(focus);
    }, [comparing, pair, focus, handlePick]);

    const keysEnabled = active && !inspectedFile;

    // ── Tag pointer ──────────────────────────────────────────────────────
    // It works over both sides: the side under the mouse is its target. 1 /
    // 3 move it to the same spot on the other side without moving the mouse
    // (like Sweep's 2); it follows the mouse again once the mouse really moves.
    useTagPointerSurface(keysEnabled);
    const { setTarget, clearTarget, togglePicker } = useTagPointer();
    const cursorClass = usePointerCursorClass(keysEnabled);
    const [hoverSide, setHoverSide] = useState<Side | null>(null);
    const hoverSideRef = useRef<Side | null>(null);
    hoverSideRef.current = hoverSide;
    const [pointerShift, setPointerShift] = useState<{ side: Side; x: number; y: number } | null>(null);
    const pointerShiftRef = useRef(pointerShift);
    pointerShiftRef.current = pointerShift;
    const [pointerFlash, setPointerFlash] = useState<Record<Side, MediaFlashState>>({ a: null, b: null });
    const mousePos = useRef({ x: 0, y: 0 });
    useEffect(() => {
        let last: { x: number; y: number } | null = null;
        const onMove = (e: MouseEvent) => {
            mousePos.current = { x: e.clientX, y: e.clientY };
            // Really moved (not content changing under a still mouse).
            const moved = !last || last.x !== e.screenX || last.y !== e.screenY;
            last = { x: e.screenX, y: e.screenY };
            if (moved && pointerShiftRef.current) setPointerShift(null);
        };
        window.addEventListener("mousemove", onMove, true);
        return () => window.removeEventListener("mousemove", onMove, true);
    }, []);
    // 1 / 3: the pointer to that side, at the mouse's spot mirrored there.
    const shiftPointerTo = useCallback((side: Side) => {
        const from = hoverSideRef.current;
        const shifted = pointerShiftRef.current?.side ?? from;
        if (!from || shifted === side) return;
        if (side === from) {
            setPointerShift(null);
            return;
        }
        const fromEl = document.querySelector(`[data-side="${from}"]`);
        const toEl = document.querySelector(`[data-side="${side}"]`);
        if (!fromEl || !toEl) return;
        const f = fromEl.getBoundingClientRect();
        const t = toEl.getBoundingClientRect();
        const m = mousePos.current;
        setPointerShift({
            side,
            x: t.left + ((m.x - f.left) / f.width) * t.width,
            y: t.top + ((m.y - f.top) / f.height) * t.height,
        });
    }, []);
    const pointerSide = pointerShift?.side ?? hoverSide;
    const pointerFile = pair && pointerSide ? (pointerSide === "a" ? pair[0] : pair[1]) : null;
    useEffect(() => {
        if (!keysEnabled || !pointerFile || !pointerSide) return;
        const t: PointerTarget = {
            file: pointerFile,
            pointAt: pointerShift ? { x: pointerShift.x, y: pointerShift.y } : undefined,
            onFlash: (kind) =>
                setPointerFlash((f) => ({
                    ...f,
                    [pointerSide]: { kind, n: (f[pointerSide]?.n ?? 0) + 1 },
                })),
        };
        setTarget(t);
        return () => clearTarget(t);
    }, [keysEnabled, pointerFile, pointerSide, pointerShift, setTarget, clearTarget]);
    const pointerProps = (side: Side) => ({
        cursorClass,
        flash: pointerFlash[side],
        onPointerEnter: () => setHoverSide(side),
        onPointerLeave: () => setHoverSide((s) => (s === side ? null : s)),
        onContextMenu: (e: React.MouseEvent) => {
            if (!keysEnabled) return;
            e.preventDefault();
            togglePicker();
        },
    });

    useEffect(() => {
        if (!keysEnabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // Leave keys alone only while typing. A focused checkbox (the
            // sidebar's L / R boxes) or button shouldn't swallow hotkeys.
            if (isTyping()) return;

            const controls =
                focus === "a" ? controlsA.current : controlsB.current;

            // Physical keys, so the left-hand layout holds on any keyboard
            // layout. The scheme is in lib/keys.ts.
            // (Tab and Space belong to the tag pointer.)
            switch (e.code) {
                case "Digit1":
                case "Digit3":
                    // 1 / 3: the left / right side (next to Tab + 1 / 2 / 3).
                    e.preventDefault();
                    if (e.repeat) return;
                    setFocus(e.code === "Digit1" ? "a" : "b");
                    shiftPointerTo(e.code === "Digit1" ? "a" : "b");
                    break;
                case "Digit2":
                case "ArrowDown":
                    e.preventDefault();
                    if (e.repeat) return;
                    submit();
                    break;
                case "KeyW":
                case "ArrowUp":
                    e.preventDefault();
                    if (e.repeat) return;
                    handleUndo();
                    break;
                case "KeyX":
                    e.preventDefault();
                    if (e.repeat) return;
                    toggleCompareBothAudio();
                    flashStatus(
                        compareBothAudio
                            ? "Audio: focused side only"
                            : "Audio: both sides",
                        2000,
                    );
                    break;
                case "KeyR":
                    // Rotate the focused side left.
                    e.preventDefault();
                    if (e.repeat) return;
                    (focus === "a" ? rotateA : rotateB).current?.();
                    break;
                case "KeyK": {
                    // Crown the focused side, or uncrown it if it's king.
                    e.preventDefault();
                    if (e.repeat || !pair) return;
                    const file = focus === "a" ? pair[0] : pair[1];
                    if (king?.file.id === file.id) endKing();
                    else crown(file, focus);
                    break;
                }
                case "KeyQ":
                case "KeyE":
                case "ArrowLeft":
                case "ArrowRight":
                    e.preventDefault();
                    controls?.step(
                        e.code === "KeyQ" || e.code === "ArrowLeft" ? -1 : 1,
                    );
                    break;
                case "KeyV":
                    e.preventDefault();
                    if (e.repeat) return;
                    controls?.togglePlay();
                    break;
            }
        };
        window.addEventListener("keydown", onKey);
        const releaseSpaceAndTab = claimSpaceAndTab();
        return () => {
            window.removeEventListener("keydown", onKey);
            releaseSpaceAndTab();
        };
    }, [
        keysEnabled,
        focus,
        submit,
        handleUndo,
        pair,
        king,
        crown,
        endKing,
        compareBothAudio,
        toggleCompareBothAudio,
        setStatus,
        resetStatus,
        shiftPointerTo,
    ]);

    // Only blank the screen on the very first load. Swapping in a new pair
    // keeps the cards mounted, so a video that stays on screen (the king)
    // isn't torn down and reloaded.
    if (loading && !pair) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Loading…
            </div>
        );
    }

    if (!pair) {
        if (laneFolderPrefixes.a || laneFolderPrefixes.b) {
            return (
                <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                    Not enough files to compare in the folders checked for
                    each side (L / R in the sidebar).
                </div>
            );
        }
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Not enough files to compare. Add more media to your library.
            </div>
        );
    }

    const [a, b] = pair;

    // "Placing 3/10" on the file being placed (hidden while a king holds).
    const placingLabel = (f: DbFile): string | undefined =>
        placing && !king && placing.file.id === f.id
            ? `Placing ${Math.min(placing.file.comparison_count - placing.startCount + 1, PLACEMENT_MATCHES)}/${PLACEMENT_MATCHES}`
            : undefined;


    if (inspectedFile) {
        return (<SingleFileView
            onClose={() => setInspectedFile(null)}
            file={inspectedFile}
            active={active}
            setView={setView}
        />)
    }

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden">
            {session && (
                <div className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center">
                    <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-black/70 px-3 py-1 text-xs text-white/80 shadow">
                        {session.kind === "folder" ? (
                            <span>
                                Placing new files in{" "}
                                <span className="text-white">{session.folder}</span>
                                {placementLeft != null && ` · ${placementLeft} left`}
                            </span>
                        ) : (
                            <span>
                                Placing{" "}
                                <span className="text-white">{session.file.filename}</span>
                            </span>
                        )}
                        <button
                            onClick={() => {
                                const back = session.returnTo;
                                endSession();
                                setPlacement(null);
                                setView(back);
                            }}
                            className="rounded-full bg-white/10 px-2 py-0.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
                        >
                            Stop
                        </button>
                    </div>
                </div>
            )}
            <div className="flex flex-1 min-h-0 overflow-hidden bg-black">
                    <CompareCard
                        file={a}
                        side="a"
                        {...pointerProps("a")}
                        rootPath={rootPath!}
                        disabled={!active}
                        focused={focus === "a"}
                        audible={compareBothAudio || focus === "a"}
                        controlsRef={controlsA}
                        rotateRef={rotateA}
                        onFocus={() => setFocus("a")}
                        onPick={() => handlePick("a")}
                        onInspectFile={() => {
                            setInspectedFile(a);
                        }}
                        isKing={king?.file.id === a.id}
                        placingLabel={placingLabel(a)}
                        streak={king?.streak ?? 0}
                        onCrown={() => crown(a, "a")}
                        onUncrown={endKing}
                        onReplaceFile={replaceFile}
                        onGoToFolder={() => {
                            const folderName = a.path.split("/")[0];
                            setActiveFolder(folderName);
                            setView("browse");
                        }}
                    />
                    <div className="w-px shrink-0 bg-neutral-800" />
                    <CompareCard
                        file={b}
                        side="b"
                        {...pointerProps("b")}
                        rootPath={rootPath!}
                        disabled={!active}
                        focused={focus === "b"}
                        audible={compareBothAudio || focus === "b"}
                        controlsRef={controlsB}
                        rotateRef={rotateB}
                        onFocus={() => setFocus("b")}
                        onPick={() => handlePick("b")}
                        onInspectFile={() => {
                            setInspectedFile(b);
                        }}
                        isKing={king?.file.id === b.id}
                        placingLabel={placingLabel(b)}
                        streak={king?.streak ?? 0}
                        onCrown={() => crown(b, "b")}
                        onUncrown={endKing}
                        onReplaceFile={replaceFile}
                        onGoToFolder={() => {
                            const folderName = b.path.split("/")[0];
                            setActiveFolder(folderName);
                            setView("browse");
                        }}
                    />
            </div>
        </div>
    );
}

function CompareCard({
    file,
    side,
    cursorClass,
    flash,
    onPointerEnter,
    onPointerLeave,
    onContextMenu,
    rootPath,
    disabled,
    focused,
    audible,
    controlsRef,
    rotateRef,
    onFocus,
    onPick,
    onInspectFile,
    onGoToFolder,
    isKing,
    placingLabel,
    streak,
    onCrown,
    onUncrown,
    onReplaceFile,
}: {
    file: DbFile;
    side: Side;
    /** Tag pointer: hides the cursor while the pointer shows over it. */
    cursorClass: string;
    /** Tag pointer: the last toggle's feedback on this side. */
    flash: MediaFlashState;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    rootPath: string;
    disabled: boolean;
    focused: boolean;
    audible: boolean;
    controlsRef: React.MutableRefObject<MediaControls | null>;
    /** Filled with this card's rotate-left (R on the focused side). */
    rotateRef: React.MutableRefObject<(() => void) | null>;
    onFocus: () => void;
    onPick: () => void;
    onInspectFile: (file: DbFile) => void;
    onGoToFolder: (folderPath: string) => void;
    isKing: boolean;
    /** Shown while this file is going through placement matches. */
    placingLabel?: string;
    streak: number;
    onCrown: () => void;
    onUncrown: () => void;
    /** A rotated file's new version (same record, new content hash). */
    onReplaceFile: (file: DbFile) => void;
}): JSX.Element {
    const { turns: rotationOf, rotateLeft } = useRotation(file, rootPath, onReplaceFile);
    rotateRef.current = rotateLeft;
    const libraryRank = useLibraryRank(file.id);

    // Only real mouse movement takes focus. The browser can fire mousemove
    // when the content under a resting cursor changes (a new pair loading),
    // which must not override the keyboard's focus.
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const last = lastPointRef.current;
            lastPointRef.current = { x: e.screenX, y: e.screenY };
            if (!last || (last.x === e.screenX && last.y === e.screenY)) return;
            if (!focused) onFocus();
        },
        [focused, onFocus],
    );

    // When this side gets a new file, the old player stays on top until the
    // new one has a frame to show, so the cut never passes through black.
    const [outgoing, setOutgoing] = useState<DbFile | null>(null);
    const [prevFile, setPrevFile] = useState(file);
    if (file.id !== prevFile.id) {
        // Mid-swap already? The outgoing one is still what's visible.
        setOutgoing(outgoing ?? prevFile);
        setPrevFile(file);
    } else if (file !== prevFile) {
        setPrevFile(file); // same file, fresh scores
    }
    const incomingReady = useCallback(() => setOutgoing(null), []);
    // Don't hold the old one forever if the new one never loads.
    useEffect(() => {
        if (!outgoing) return;
        const t = setTimeout(incomingReady, 1500);
        return () => clearTimeout(t);
    }, [outgoing, incomingReady]);

    const [showBar, setShowBar] = useState(false);

    // Bar pieces fade together; only shown pieces catch the mouse, and the
    // bar itself lets clicks through so they still pick.
    const fade = showBar
        ? "opacity-100 pointer-events-auto"
        : "opacity-0 pointer-events-none";

    return (
        <div
            data-side={side}
            className={`relative flex min-w-0 flex-1 flex-col overflow-hidden transition-opacity ${disabled ? "opacity-60" : ""} ${cursorClass}`}
            onMouseMove={(e) => {
                const top = e.currentTarget.getBoundingClientRect().top;
                setShowBar(e.clientY - top < INFO_BAR_ZONE_PX);
            }}
            onMouseEnter={onPointerEnter}
            onMouseLeave={() => {
                setShowBar(false);
                onPointerLeave();
            }}
            onContextMenu={onContextMenu}
        >
            {/* Keyed siblings in one list, so the old player is the same
                instance it was a moment ago (not remounted) while it covers
                the swap. */}
            <div className="relative min-h-0 flex-1">
                <MediaFlash flash={flash} />
                {[outgoing, file].map((f) => {
                    if (!f) return null;
                    const isOutgoing = f === outgoing;
                    return (
                        <div
                            key={f.id}
                            className={`absolute inset-0 ${isOutgoing ? "pointer-events-none z-10" : ""}`}
                        >
                            {isOutgoing ? (
                                <MediaPlayer
                                    file={f}
                                    rootPath={rootPath}
                                    disabled
                                    muted
                                    className="h-full w-full"
                                    clickToPauseEnabled={false}
                                    keyboardEnabled={false}
                                />
                            ) : (
                                <MediaPlayer
                                    file={f}
                                    rootPath={rootPath}
                                    disabled={disabled}
                                    muted={!audible || disabled}
                                    onClick={disabled ? undefined : onPick}
                                    onMouseMove={handleMouseMove}
                                    onReady={incomingReady}
                                    className="h-full w-full"
                                    clickToPauseEnabled={false}
                                    keyboardEnabled={false}
                                    controlsRef={controlsRef}
                                    rotation={rotationOf(f.id)}
                                />
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Focus marker: a thin line across the top of the focused side. */}
            <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 bg-white/80 transition-opacity duration-100 ${focused && !disabled ? "opacity-100" : "opacity-0"}`}
            />

            {/* Info bar: overlays the top of the media while hovered. */}
            <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-150 ${showBar ? "opacity-100" : "opacity-0"}`}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 px-3 pt-2.5">
                <div
                    className={`min-w-0 flex-1 transition-opacity duration-150 ${fade}`}
                >
                    <p
                        className="cursor-pointer truncate text-sm font-medium text-white/90 drop-shadow hover:text-white transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            onInspectFile(file);
                        }}
                    >
                        {file.filename}
                    </p>
                    <p className="text-xs text-white/60 drop-shadow">
                        {Math.round(file.elo_score)} pts ·{" "}
                        {file.comparison_count} comparisons
                        {isKing && streak > 0 && ` · ${streak} in a row`}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    {/* Library rank stays visible, like the king's crown. */}
                    {libraryRank && (
                        <span
                            className="mr-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/80 drop-shadow"
                            title="Place in the whole library"
                        >
                            {libraryRank}
                        </span>
                    )}
                    {placingLabel && (
                        <span
                            className="pointer-events-auto mr-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white/80 drop-shadow"
                            title="New file: kept on screen until it has had its placement matches"
                        >
                            {placingLabel}
                        </span>
                    )}
                    {/* The king's crown stays visible even with the bar hidden. */}
                    <button
                        className={`rounded-md p-1.5 drop-shadow transition-all duration-150 ${
                            isKing
                                ? "pointer-events-auto opacity-100 text-amber-300 hover:text-amber-200"
                                : `${fade} text-white/60 hover:text-white`
                        }`}
                        title={isKing ? "Stop keeping on screen (K)" : "Keep on screen (K)"}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (isKing) onUncrown();
                            else onCrown();
                        }}
                    >
                        <CrownIcon className="h-4 w-4" />
                    </button>
                    <button
                        className={`rounded-md p-1.5 text-white/60 drop-shadow hover:text-white transition-all duration-150 ${fade}`}
                        title="Rotate left (R)"
                        onClick={(e) => {
                            e.stopPropagation();
                            rotateLeft();
                        }}
                    >
                        <RotateIcon className="h-4 w-4" />
                    </button>
                    <button
                        className={`rounded-md p-1.5 text-white/60 drop-shadow hover:text-white transition-all duration-150 ${fade}`}
                        title="Go to folder"
                        onClick={(e) => {
                            e.stopPropagation();
                            onGoToFolder(file.path.split("/")[0]);
                        }}
                    >
                        <FolderIcon className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}
