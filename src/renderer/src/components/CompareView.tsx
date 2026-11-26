import {
    Fragment,
    useEffect,
    useState,
    useCallback,
    useRef,
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
    INSPECT_MS,
    INSPECT_OUT_MS,
    type PlayState,
    applyPlayState,
    barRect,
    pictureRect,
    playStateIn,
    shownVideo,
} from "@renderer/lib/inspect";

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

// Matchups remembered for undo (⌘Z): undoing a pick puts it back on screen.
const UNDO_LIMIT = 200;
/** Pairs remembered for replaying after an undo (see replayRef). */
const REPLAY_LIMIT = 5;

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
    pair: [DbFile, DbFile];
    /** Who won it (to tell whether a re-pick after undo went the same way). */
    winnerId: number;
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
    // A side open in the file view, as an inspection: its picture grows from
    // that side and goes back there on closing (Compare stays underneath,
    // dimmed, and keeps playing).
    const [inspect, setInspect] = useState<{
        file: DbFile;
        side: Side;
        from: DOMRect | null;
        /** Where this side drew the video's playhead strip. */
        fromBar: DOMRect | null;
        startAt: PlayState | null;
        closing: { to: DOMRect | null; toBar: DOMRect | null } | null;
        /** The file view's copy is showing: this side hides its own (it
         *  keeps playing) until the file view has gone back and closed. */
        shown: boolean;
    } | null>(null);
    const inspectRef = useRef(inspect);
    inspectRef.current = inspect;
    // Sound: none from Compare while a file view is up. Once it's going back,
    // the other side may be heard again at once (focus can move there during
    // the flight); the opened side stays quiet until the swap, the file
    // view's copy has the sound till then.
    const audibleDuringInspect = (side: Side): boolean =>
        !inspect || (!!inspect.closing && inspect.side !== side);
    // The file changed in place (rotated, renamed): same inspection.
    const setInspectedFile = useCallback(
        (update: (f: DbFile) => DbFile) =>
            setInspect((i) => {
                if (!i) return i;
                const file = update(i.file);
                return file === i.file ? i : { ...i, file };
            }),
        [],
    );
    const cardsRef = useRef<HTMLDivElement>(null);
    const sideRoot = (side: Side): Element | null =>
        cardsRef.current?.querySelector(`[data-side="${side}"] [data-current]`) ?? null;
    const openInspect = useCallback((side: Side) => {
        const p = pairRef.current;
        if (!p || inspectRef.current) return;
        const root = sideRoot(side);
        setInspect({
            file: side === "a" ? p[0] : p[1],
            side,
            from: pictureRect(root),
            fromBar: barRect(root),
            startAt: playStateIn(root),
            closing: null,
            shown: false,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Back to its side if that side still shows it; otherwise (deleted, or
    // the side moved on) it fades out.
    const closeInspect = useCallback((flyBack: boolean) => {
        const i = inspectRef.current;
        if (!i || i.closing) return;
        const p = pairRef.current;
        const still = !!p && (i.side === "a" ? p[0] : p[1]).id === i.file.id;
        const back = flyBack && still;
        const next = {
            ...i,
            closing: {
                to: back ? pictureRect(sideRoot(i.side)) : null,
                toBar: back ? barRect(sideRoot(i.side)) : null,
            },
        };
        inspectRef.current = next;
        setInspect(next);
        // Compare is back in charge from now, not from the landing: the other
        // side plays again at once (its keys are on again too; see
        // keysEnabled).
        if (resumeOtherSide.current) {
            shownVideo(sideRoot(resumeOtherSide.current))?.play().catch(() => {});
            resumeOtherSide.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // G again, or Esc, closes the file view (back to its side, like ← Back).
    // An open tag picker keeps Esc for itself.
    const inspecting = !!inspect && !inspect.closing;
    useEffect(() => {
        if (!active || !inspecting) return;
        const onKey = (e: KeyboardEvent) => {
            if ((e.code !== "KeyG" && e.code !== "Escape") || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
            if (document.querySelector("[data-modal]")) return;
            e.preventDefault();
            closeInspect(true);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, inspecting, closeInspect]);
    // Nothing moves behind the file view: the other side's video pauses as
    // Compare dims, and picks up again on closing if it was playing.
    // The opened side's own copy (hidden, muted) keeps rolling in step with
    // the file view's video instead, so on closing the two are on the same
    // frame and can simply swap. It follows on events only: once now (the
    // file view's copy has just jumped to its moment, a guess that can be a
    // few frames off) and on every scrub, pause and play.
    const resumeOtherSide = useRef<Side | null>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const stopFollowing = useRef<(() => void) | null>(null);
    // While paused: the exact time the hidden copy last jumped to (null:
    // it hasn't, or it's playing).
    const mineJumpedTo = useRef<number | null>(null);
    const onInspectShown = useCallback(() => {
        const i = inspectRef.current;
        if (i && !i.shown) {
            const other: Side = i.side === "a" ? "b" : "a";
            const otherVideo = shownVideo(sideRoot(other));
            resumeOtherSide.current = otherVideo && !otherVideo.paused ? other : null;
            otherVideo?.pause();
            const mine = shownVideo(sideRoot(i.side));
            const theirs = shownVideo(overlayRef.current);
            if (mine && theirs) {
                const follow = () => {
                    if (theirs.paused) {
                        // Paused, a still frame shows: same time isn't
                        // enough. Jump to exactly theirs, the way theirs got
                        // there, so both pick the same frame.
                        if (!mine.paused) mine.pause();
                        if (mineJumpedTo.current !== theirs.currentTime) {
                            mineJumpedTo.current = theirs.currentTime;
                            mine.currentTime = theirs.currentTime;
                        }
                        return;
                    }
                    mineJumpedTo.current = null;
                    if (Math.abs(mine.currentTime - theirs.currentTime) > 0.04) {
                        mine.currentTime = theirs.currentTime;
                    }
                    if (mine.paused) mine.play().catch(() => {});
                };
                const events = ["seeked", "play", "pause", "playing"] as const;
                for (const ev of events) theirs.addEventListener(ev, follow);
                stopFollowing.current?.();
                stopFollowing.current = () => {
                    for (const ev of events) theirs.removeEventListener(ev, follow);
                };
                follow();
            }
        }
        setInspect((i) => (i && !i.shown ? { ...i, shown: true } : i));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // However the file view went (closed, or a session took over): stop.
    useEffect(() => {
        if (inspect) return;
        stopFollowing.current?.();
        stopFollowing.current = null;
        mineJumpedTo.current = null;
    }, [inspect]);
    // This side's own copy is hidden while the file view's is up.
    const hiddenSide = (side: Side, file: DbFile): boolean =>
        !!inspect?.shown && inspect.side === side && inspect.file.id === file.id;
    // Gone back. A video's two copies are normally on the same frame by now
    // (see above): swap at once. Only if they're apart (one stuttered) does
    // this side's copy jump to the file view's moment first, with the swap
    // waiting until that frame is on screen (the file view's copy holds
    // still at the landing spot meanwhile, capped) so it never shows a
    // stray frame.
    const onInspectClosed = useCallback((state: PlayState | null) => {
        const i = inspectRef.current;
        const p = pairRef.current;
        const finish = () => {
            stopFollowing.current?.();
            stopFollowing.current = null;
            if (resumeOtherSide.current) {
                shownVideo(sideRoot(resumeOtherSide.current))?.play().catch(() => {});
                resumeOtherSide.current = null;
            }
            inspectRef.current = null;
            setInspect(null);
        };
        const same = !!i && !!p && (i.side === "a" ? p[0] : p[1]).id === i.file.id;
        const mine = same ? shownVideo(sideRoot(i!.side)) : null;
        const theirs = shownVideo(overlayRef.current);
        if (!mine || !state) {
            if (same) applyPlayState(sideRoot(i!.side), state);
            finish();
            return;
        }
        // In step: just swap. Playing: within a frame. Paused: this copy
        // jumped to exactly theirs and has finished getting there.
        const inStep =
            !!theirs &&
            mine.paused === theirs.paused &&
            (theirs.paused
                ? mineJumpedTo.current === theirs.currentTime && !mine.seeking
                : Math.abs(mine.currentTime - theirs.currentTime) < 0.05);
        // For checking in dev tools how the landing went (temporary).
        const report = {
            apart: theirs ? +(mine.currentTime - theirs.currentTime).toFixed(3) : null,
            comparePaused: mine.paused,
            fileViewPaused: theirs?.paused ?? null,
            seeking: mine.seeking,
        };
        if (inStep) {
            console.info("[inspect] landing: in step, instant swap", report);
            finish();
            return;
        }
        console.warn("[inspect] landing: copies apart, jump-and-wait fallback", report);
        const waitStart = performance.now();
        theirs?.pause();
        const time = theirs ? theirs.currentTime : state.time;
        let done = false;
        const swap = () => {
            if (done) return;
            done = true;
            clearTimeout(cap);
            mine.removeEventListener("seeked", onSeeked);
            if (!state.paused) mine.play().catch(() => {});
            console.warn(`[inspect] fallback swap after ${Math.round(performance.now() - waitStart)} ms`);
            finish();
        };
        // Seeked: wait for that frame to be on screen, where supported.
        const onSeeked = () => {
            if (mine.requestVideoFrameCallback) mine.requestVideoFrameCallback(() => swap());
            else swap();
        };
        const cap = setTimeout(swap, 300);
        // Paused: only an exact jump to that time counts (see follow).
        const there = state.paused
            ? mineJumpedTo.current === time && !mine.seeking
            : Math.abs(mine.currentTime - time) < 0.02;
        if (there) {
            swap();
        } else {
            mine.addEventListener("seeked", onSeeked);
            mineJumpedTo.current = time;
            mine.currentTime = time;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const undoStackRef = useRef<UndoEntry[]>([]);
    const pairShownAtRef = useRef(0);
    const controlsA = useRef<MediaControls | null>(null);
    const controlsB = useRef<MediaControls | null>(null);
    // Each card's rotate-left, for R on the focused side.
    const rotateA = useRef<(() => void) | null>(null);
    const rotateB = useRef<(() => void) | null>(null);

    const { activeFilter, activeFilterKey: tagKey } = useTags();
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
    const { rootPath, folderPrefixes, setActiveFolder } = useFolders();
    // Both sides draw from the sidebar's ticked collections (the shared
    // selection). Kept per side because a king's challengers, refits and
    // placement still think in sides.
    const laneKey = JSON.stringify({ a: folderPrefixes, b: folderPrefixes });

    // Next pair, fetched + preloaded in the background. Tagged with the filter
    // state it was fetched under so it's discarded if filters change.
    const prefetchedRef = useRef<{
        key: string;
        pair: [DbFile, DbFile];
    } | null>(null);

    // ── Replaying after an undo ─────────────────────────────────────────────
    // Undoing a pick brings its pair back; the pair that was on screen goes
    // to the front of this list (the last REPLAY_LIMIT, sides kept). Picking
    // again, or redoing, shows those pairs again in order instead of new
    // ones. In King of the Hill and placement the next pair depends on who
    // won, so a different result drops the list (the king or the file being
    // placed no longer matches). So does a different selection or filter.
    type ReplayEntry = {
        pair: [DbFile, DbFile];
        kingId: number | null;
        placingId: number | null;
        scope: string;
    };
    const replayRef = useRef<ReplayEntry[]>([]);
    /** Who won each undone pick, by pair. */
    const undoneWinnersRef = useRef<Map<string, number>>(new Map());
    const scopeRef = useRef("");
    scopeRef.current = `${laneKey}|${tagKey}`;
    const pairKey = (p: [DbFile, DbFile]) => [p[0].id, p[1].id].sort((x, y) => x - y).join("-");
    const dropReplay = () => {
        replayRef.current = [];
        undoneWinnersRef.current.clear();
    };

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
            const lanes: Record<Side, string[] | null> = JSON.parse(laneKey);
            const filterKey = JSON.stringify([
                laneKey,
                tagKey,
                rootPath,
                k?.file.id ?? null,
            ]);

            // Folders per side; tags apply to both.
            const laneFilter = (side: Side): PoolFilter => ({
                folderPrefixes: lanes[side],
                filter: activeFilter,
            });

            const fetchNext = async (): Promise<[DbFile, DbFile] | null> => {
                if (!k) return window.api.getPair(lanes.a, activeFilter);
                // Challengers come from the lane opposite the king.
                const pool = laneFilter(k.side === "a" ? "b" : "a");
                const challenger = await window.api.getChallenger(
                    k.file.id,
                    pool.folderPrefixes,
                    pool.filter,
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
                    filter: null,
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
                        filter: null,
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
        [laneKey, rootPath, tagKey, activeFilter, endKing, session],
    );

    // Starting a session from Browse: placement takes over (a king would
    // otherwise hold the screen).
    useEffect(() => {
        if (!session) return;
        endKing();
        kingRef.current = null;
        setPlacement(null);
        // Started from a file opened here: show the matches, not the file.
        inspectRef.current = null;
        setInspect(null);
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
            setInspectedFile(swap);
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
            // Its file deleted: the file view fades out (nothing to go back to).
            if (inspectRef.current && gone(inspectRef.current.file)) closeInspect(false);
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
                setInspectedFile(move);
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

    /** After `picked` was decided (a re-pick or a redo): shows the next
     *  remembered pair, if it still fits. False: load a new pair as usual. */
    const playReplay = async (picked: [DbFile, DbFile], winnerId: number): Promise<boolean> => {
        if (replayRef.current.length === 0) return false;
        const expected = undoneWinnersRef.current.get(pairKey(picked));
        undoneWinnersRef.current.delete(pairKey(picked));
        // Only a pair that was undone leads into the remembered ones; in
        // King of the Hill and placement, only if it went the same way.
        const dependsOnResult = kingRef.current != null || placementRef.current != null;
        if (expected === undefined || (dependsOnResult && expected !== winnerId)) {
            dropReplay();
            return false;
        }
        while (replayRef.current.length > 0) {
            const e = replayRef.current.shift()!;
            if (
                e.scope !== scopeRef.current ||
                e.kingId !== (kingRef.current?.file.id ?? null) ||
                e.placingId !== (placementRef.current?.file.id ?? null)
            ) {
                dropReplay();
                return false;
            }
            // Fresh copies (scores changed); skip a pair with a file gone.
            const rows = await window.api.getFilesByIds(e.pair.map((f) => f.id));
            const byId = new Map(rows.map((f) => [f.id, f]));
            const a = byId.get(e.pair[0].id);
            const b = byId.get(e.pair[1].id);
            if (!a || !b || a.status !== "active" || b.status !== "active") continue;
            const k = kingRef.current;
            if (k) {
                const challenger = k.side === "a" ? b : a;
                recentChallengersRef.current = [
                    challenger.id,
                    ...recentChallengersRef.current.filter((id) => id !== challenger.id),
                ].slice(0, 10);
            }
            setPair([a, b]);
            setLoading(false);
            if (replayRef.current.length === 0) undoneWinnersRef.current.clear();
            return true;
        }
        dropReplay();
        return false;
    };

    const handlePick = useCallback(
        async (winnerSide: Side) => {
            if (comparing || !pair) return;
            const winner = winnerSide === "a" ? pair[0] : pair[1];
            const loser = winnerSide === "a" ? pair[1] : pair[0];
            setComparing(true);
            const kingBefore = kingRef.current;
            const recentBefore = recentChallengersRef.current;
            const placementBefore = placementRef.current;
            const pushUndo = () => {
                undoStackRef.current = [
                    ...undoStackRef.current,
                    {
                        pair,
                        winnerId: winner.id,
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
                    pushUndo();
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
                if (!(await playReplay(pair, winner.id))) await loadPair(null);
                setFocus(winnerSide);
                setComparing(false);
                return;
            }

            const res = await window.api.recordComparison(winner.id, loser.id);
            if (res) pushUndo();

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

            if (!(res && (await playReplay(pair, winner.id)))) await loadPair(nextKing);
            setFocus(winnerSide);
            setComparing(false);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [comparing, pair, focus, loadPair, setKing, bump],
    );

    // A pick undone from the app-wide history (⌘Z, here or in any view):
    // the scores are already back; that matchup returns to the screen as
    // it was. Redoing it moves on to a new pair. Any other undo or redo
    // may have changed scores, so the pair on screen is refetched.
    const loadPairForHistoryRef = useRef(loadPair);
    loadPairForHistoryRef.current = loadPair;
    const playReplayRef = useRef(playReplay);
    playReplayRef.current = playReplay;
    useEffect(() => {
        return window.api.onHistoryApplied(async (applied) => {
            const meta = applied.meta;
            const ids =
                meta?.kind === "compare"
                    ? [meta.winnerId, meta.loserId]
                    : meta?.kind === "placement"
                      ? [meta.placingId, meta.opponentId]
                      : null;
            const samePair = (p: [DbFile, DbFile] | null | undefined) =>
                !!p && !!ids && p.some((f) => f.id === ids[0]) && p.some((f) => f.id === ids[1]);

            if (ids && !applied.error && applied.direction === "undo") {
                const stack = undoStackRef.current;
                let i = stack.length - 1;
                while (i >= 0 && !samePair(stack[i].pair)) i--;
                const entry = i >= 0 ? stack[i] : null;
                if (entry) undoStackRef.current = stack.slice(0, i);
                const order = entry ? entry.pair.map((f) => f.id) : ids;
                const rows = await window.api.getFilesByIds(order);
                const byId = new Map(rows.map((f) => [f.id, f]));
                const a = byId.get(order[0]);
                const b = byId.get(order[1]);
                if (!a || !b) return;
                const restored: [DbFile, DbFile] = [a, b];
                prefetchedRef.current = null;
                // The pair on screen goes to the front of the replay, as it
                // was shown (the king / placement as they are now).
                const onScreen = pairRef.current;
                if (onScreen && pairKey(onScreen) !== pairKey(restored)) {
                    replayRef.current = [
                        {
                            pair: onScreen,
                            kingId: kingRef.current?.file.id ?? null,
                            placingId: placementRef.current?.file.id ?? null,
                            scope: scopeRef.current,
                        },
                        ...replayRef.current,
                    ].slice(0, REPLAY_LIMIT);
                }
                const undoneWinner =
                    entry?.winnerId ?? (meta?.kind === "compare" ? meta.winnerId : undefined);
                if (undoneWinner !== undefined) undoneWinnersRef.current.set(pairKey(restored), undoneWinner);
                if (entry) {
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
                    setFocus(entry.focus);
                }
                setPair(restored);
                return;
            }

            const current = pairRef.current;
            if (ids && !applied.error && applied.direction === "redo" && samePair(current)) {
                // A redone pick (not placement: its range isn't redone here)
                // moves on like picking it again: the king as after that
                // pick, then the remembered next pair if there is one.
                if (meta?.kind === "compare" && current) {
                    const rows = await window.api.getFilesByIds([meta.winnerId]);
                    const winnerFile = rows[0];
                    const kingBefore = kingRef.current;
                    undoStackRef.current = [
                        ...undoStackRef.current,
                        {
                            pair: current,
                            winnerId: meta.winnerId,
                            focus: (current[0].id === meta.winnerId ? "a" : "b") as Side,
                            king: kingBefore,
                            recentChallengers: recentChallengersRef.current,
                            placement: placementRef.current,
                        },
                    ].slice(-UNDO_LIMIT);
                    if (kingBefore && winnerFile) {
                        let next = kingBefore;
                        if (meta.winnerId === kingBefore.file.id) {
                            next = { ...kingBefore, file: winnerFile, streak: kingBefore.streak + 1 };
                        } else if (meta.loserId === kingBefore.file.id) {
                            recentChallengersRef.current = [
                                kingBefore.file.id,
                                ...recentChallengersRef.current,
                            ].slice(0, 10);
                            next = {
                                file: winnerFile,
                                streak: 1,
                                side: (current[0].id === meta.winnerId ? "a" : "b") as Side,
                            };
                        }
                        kingRef.current = next;
                        setKing(next);
                    }
                    if (await playReplayRef.current(current, meta.winnerId)) return;
                } else {
                    dropReplay();
                }
                loadPairForHistoryRef.current(kingRef.current);
                return;
            }
            if (!current) return;
            const rows = await window.api.getFilesByIds(current.map((f) => f.id));
            const byId = new Map(rows.map((f) => [f.id, f]));
            setPair((p) =>
                p && p[0].id === current[0].id && p[1].id === current[1].id
                    ? [byId.get(p[0].id) ?? p[0], byId.get(p[1].id) ?? p[1]]
                    : p,
            );
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setKing, bump]);

    // 2 / ↓: the focused side wins.
    const submit = useCallback(() => {
        if (comparing || !pair) return;
        if (performance.now() - pairShownAtRef.current < PICK_LOCKOUT_MS)
            return;
        handlePick(focus);
    }, [comparing, pair, focus, handlePick]);

    // Off while a file view is up, back on the moment it starts going back
    // (not at its landing): Compare responds straight away.
    const keysEnabled = active && !inspecting;

    // No tag pointer in Compare (it's for scoring; tagging is Sweep's, Pass's
    // and the file view's). Its keys here: Space picks, Tab does nothing.

    useEffect(() => {
        if (!keysEnabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // Leave keys alone only while typing. A focused checkbox (the
            // sidebar's collection boxes) or button shouldn't swallow hotkeys.
            if (isTyping()) return;

            const controls =
                focus === "a" ? controlsA.current : controlsB.current;

            // Physical keys, so the left-hand layout holds on any keyboard
            // layout. The scheme is in lib/keys.ts.
            switch (e.code) {
                case "Digit1":
                case "Digit3":
                    // 1 / 3: the left / right side.
                    e.preventDefault();
                    if (e.repeat) return;
                    setFocus(e.code === "Digit1" ? "a" : "b");
                    break;
                // Space: the action key, picking (same as 2 / ↓).
                case "Space":
                case "Digit2":
                case "ArrowDown":
                    e.preventDefault();
                    if (e.repeat) return;
                    submit();
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
                case "KeyG":
                    // G: the focused side in the file view, as in Sweep and Pass.
                    e.preventDefault();
                    if (e.repeat || !pair) return;
                    openInspect(focus);
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
        pair,
        king,
        crown,
        endKing,
        compareBothAudio,
        toggleCompareBothAudio,
        setStatus,
        resetStatus,
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
        if (folderPrefixes?.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                    No collections selected in the sidebar.
                </div>
            );
        }
        if (folderPrefixes) {
            return (
                <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                    Not enough files to compare in the collections selected in
                    the sidebar.
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


    return (
        <div className="relative flex flex-1 flex-col overflow-hidden">
        <div
            className="relative flex flex-1 flex-col overflow-hidden"
            style={{
                // Dims when the file view's copy appears (not before: this
                // side's own copy would darken, then the moving one pop in).
                opacity: inspect?.shown && !inspect.closing ? 0.06 : 1,
                transition: `opacity ${inspect?.closing ? INSPECT_OUT_MS : INSPECT_MS}ms ease-out`,
            }}
        >
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
            <div ref={cardsRef} className="flex flex-1 min-h-0 overflow-hidden bg-black">
                    <CompareCard
                        file={a}
                        side="a"
                        rootPath={rootPath!}
                        disabled={!active}
                        focused={focus === "a"}
                        audible={(compareBothAudio || focus === "a") && audibleDuringInspect("a")}
                        hideMedia={hiddenSide("a", a)}
                        hudLifted={!!inspect}
                        controlsRef={controlsA}
                        rotateRef={rotateA}
                        onFocus={() => setFocus("a")}
                        onPick={() => handlePick("a")}
                        onInspectFile={() => {
                            openInspect("a");
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
                        rootPath={rootPath!}
                        disabled={!active}
                        focused={focus === "b"}
                        audible={(compareBothAudio || focus === "b") && audibleDuringInspect("b")}
                        hideMedia={hiddenSide("b", b)}
                        hudLifted={!!inspect}
                        controlsRef={controlsB}
                        rotateRef={rotateB}
                        onFocus={() => setFocus("b")}
                        onPick={() => handlePick("b")}
                        onInspectFile={() => {
                            openInspect("b");
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
            {inspect && (
                <div ref={overlayRef} className="absolute inset-0 z-50 flex flex-col">
                    <SingleFileView
                        onClose={() => closeInspect(true)}
                        file={inspect.file}
                        active={active}
                        setView={setView}
                        inspect={{
                            from: inspect.from,
                            fromBar: inspect.fromBar,
                            startAt: inspect.startAt,
                            closing: inspect.closing,
                            onClosed: onInspectClosed,
                            onShown: onInspectShown,
                        }}
                    />
                </div>
            )}
            {/* The cards' always-on top pieces (focus line, rank, placing,
                crown), above the flight so it never covers them: they fade
                out as Compare dims and back in as the file view goes back,
                then the cards' own take over in the same spot. Laid out
                like the cards (two equal halves and the divider). */}
            {inspect && (
                <div
                    className="pointer-events-none absolute inset-0 z-[60] flex"
                    style={{
                        opacity: inspect.shown && !inspect.closing ? 0 : 1,
                        transition: `opacity ${inspect.closing ? INSPECT_OUT_MS : INSPECT_MS}ms ease-out`,
                    }}
                >
                    {([a, b] as const).map((f, i) => (
                        <Fragment key={i === 0 ? "a" : "b"}>
                            {i === 1 && <div className="w-px shrink-0" />}
                            <div className="relative min-w-0 flex-1">
                                <CardTopGhost
                                    file={f}
                                    focused={active && focus === (i === 0 ? "a" : "b")}
                                    placingLabel={placingLabel(f)}
                                    isKing={king?.file.id === f.id}
                                    streak={king?.streak ?? 0}
                                />
                            </div>
                        </Fragment>
                    ))}
                </div>
            )}
        </div>
    );
}

/** A card's always-on top pieces, drawn above a file view flight. */
function CardTopGhost(props: {
    file: DbFile;
    focused: boolean;
    placingLabel?: string;
    isKing: boolean;
    streak: number;
}): JSX.Element {
    const libraryRank = useLibraryRank(props.file.id);
    return <CardTop {...props} showBar={false} libraryRank={libraryRank} ghost />;
}

function CompareCard({
    file,
    side,
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
    hideMedia,
    hudLifted,
}: {
    /** Open in the file view, whose copy is on screen: this one is hidden
     *  (still playing) so there aren't two. */
    hideMedia: boolean;
    /** A file view is up: the always-on top pieces show in the copy above
     *  it (CardTop ghost), so the card's own are hidden. */
    hudLifted: boolean;
    file: DbFile;
    side: Side;
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

    return (
        <div
            data-side={side}
            className={`relative flex min-w-0 flex-1 flex-col overflow-hidden transition-opacity ${disabled ? "opacity-60" : ""}`}
            onMouseMove={(e) => {
                const top = e.currentTarget.getBoundingClientRect().top;
                setShowBar(e.clientY - top < INFO_BAR_ZONE_PX);
            }}
            onMouseLeave={() => setShowBar(false)}
        >
            {/* Keyed siblings in one list, so the old player is the same
                instance it was a moment ago (not remounted) while it covers
                the swap. */}
            <div className="relative min-h-0 flex-1">
                {[outgoing, file].map((f) => {
                    if (!f) return null;
                    const isOutgoing = f === outgoing;
                    return (
                        <div
                            key={f.id}
                            data-current={isOutgoing ? undefined : ""}
                            style={!isOutgoing && hideMedia ? { opacity: 0 } : undefined}
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

            <CardTop
                file={file}
                focused={focused && !disabled}
                showBar={showBar}
                libraryRank={libraryRank}
                placingLabel={placingLabel}
                isKing={isKing}
                streak={streak}
                lifted={hudLifted}
                onInspectFile={onInspectFile}
                onCrown={onCrown}
                onUncrown={onUncrown}
                rotateLeft={rotateLeft}
                onGoToFolder={onGoToFolder}
            />
        </div>
    );
}

/**
 * The top of a Compare card: the focus line, and the info row (name and
 * scores, rank, placing, crown, rotate, folder). The rank, placing label,
 * the king's crown and the focus line are always on; the rest shows on
 * hover. `ghost`: a copy of just the always-on pieces in the same places,
 * drawn above a file view flight (see CompareView), not interactive.
 * `lifted`: the card's own always-on pieces are hidden (the ghost shows
 * them meanwhile).
 */
function CardTop({
    file,
    focused,
    showBar,
    libraryRank,
    placingLabel,
    isKing,
    streak,
    ghost = false,
    lifted = false,
    onInspectFile,
    onCrown,
    onUncrown,
    rotateLeft,
    onGoToFolder,
}: {
    file: DbFile;
    focused: boolean;
    showBar: boolean;
    libraryRank: string | null | undefined;
    placingLabel?: string;
    isKing: boolean;
    streak: number;
    ghost?: boolean;
    lifted?: boolean;
    onInspectFile?: (file: DbFile) => void;
    onCrown?: () => void;
    onUncrown?: () => void;
    rotateLeft?: () => void;
    onGoToFolder?: (folderPath: string) => void;
}): JSX.Element {
    // Hover pieces: never in the ghost.
    const fade =
        showBar && !ghost ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none";
    // Always-on pieces: hidden on the card while the ghost has them. By
    // visibility, which switches at once (their opacity fades would make
    // them blink in after the ghost has gone).
    const keep = lifted ? "invisible" : "";
    const live = ghost ? "" : "pointer-events-auto";
    return (
        <>
            {/* Focus marker: a thin line across the top of the focused side. */}
            <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 bg-white/80 transition-opacity duration-100 ${focused ? "opacity-100" : "opacity-0"} ${keep}`}
            />

            {/* Info bar: overlays the top of the media while hovered. */}
            {!ghost && (
                <div
                    className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-150 ${showBar ? "opacity-100" : "opacity-0"}`}
                />
            )}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 px-3 pt-2.5">
                <div
                    className={`min-w-0 flex-1 transition-opacity duration-150 ${fade}`}
                >
                    <p
                        className="cursor-pointer truncate text-sm font-medium text-white/90 drop-shadow hover:text-white transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            onInspectFile?.(file);
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
                            className={`mr-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/80 drop-shadow ${keep}`}
                            title="Place in the whole library"
                        >
                            {libraryRank}
                        </span>
                    )}
                    {placingLabel && (
                        <span
                            className={`${live} mr-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white/80 drop-shadow ${keep}`}
                            title="New file: kept on screen until it has had its placement matches"
                        >
                            {placingLabel}
                        </span>
                    )}
                    {/* The king's crown stays visible even with the bar hidden. */}
                    <button
                        className={`rounded-md p-1.5 drop-shadow transition-all duration-150 ${
                            isKing
                                ? `${live} opacity-100 text-amber-300 hover:text-amber-200 ${keep}`
                                : `${fade} text-white/60 hover:text-white`
                        }`}
                        title={isKing ? "Stop keeping on screen (K)" : "Keep on screen (K)"}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (isKing) onUncrown?.();
                            else onCrown?.();
                        }}
                    >
                        <CrownIcon className="h-4 w-4" />
                    </button>
                    <button
                        className={`rounded-md p-1.5 text-white/60 drop-shadow hover:text-white transition-all duration-150 ${fade}`}
                        title="Rotate left (R)"
                        onClick={(e) => {
                            e.stopPropagation();
                            rotateLeft?.();
                        }}
                    >
                        <RotateIcon className="h-4 w-4" />
                    </button>
                    <button
                        className={`rounded-md p-1.5 text-white/60 drop-shadow hover:text-white transition-all duration-150 ${fade}`}
                        title="Go to folder"
                        onClick={(e) => {
                            e.stopPropagation();
                            onGoToFolder?.(file.path.split("/")[0]);
                        }}
                    >
                        <FolderIcon className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </>
    );
}
