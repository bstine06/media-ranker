import { useCallback, useEffect, useState } from "react";
import type { DbFile, View } from "@renderer/shared/types/types";
import { useFolders } from "@renderer/contexts/FolderContext";
import { usePass } from "@renderer/contexts/PassContext";
import { useTagPointer } from "@renderer/contexts/TagPointerContext";
import { useKingOfHill } from "@renderer/contexts/KingOfHillContext";
import { useLaneFullscreen } from "./lane";
import PassLobby from "./PassLobby";
import PassRun from "./PassRun";
import SingleFileView from "./SingleFileView";
import { INSPECT_MS, INSPECT_OUT_MS } from "@renderer/lib/inspect";

// Pass: going through a fixed list of files, one tag at a time (see
// PassContext). Its own view, next to Sweep. Coming to it always starts in
// the lobby, which offers to resume an unfinished pass; Start or Resume
// shows the run.

export default function PassView({
    active,
    setView,
    immersive,
    setImmersive,
}: {
    active: boolean;
    setView: (view: View) => void;
    /** Full screen: just the lane, no sidebar (the app hides it). */
    immersive: boolean;
    setImmersive: (on: boolean) => void;
}): JSX.Element {
    const { rootPath } = useFolders();
    const { lobby, run, runActive, openLobby, leaveRun } = usePass();
    const { pickingRef } = useTagPointer();
    const { crown } = useKingOfHill();
    // G: a file open in the file view over the run, as an inspection (as
    // over Compare): the run stays on screen, dimmed, and the current tile's
    // very player flies to the file view and back on closing.
    const [inspect, setInspect] = useState<{ file: DbFile; closing: boolean; shown: boolean } | null>(null);
    const openInspected = useCallback(
        (file: DbFile) => setInspect((i) => i ?? { file, closing: false, shown: false }),
        [],
    );

    // Leaving the view parks the run; coming back opens the lobby.
    useEffect(() => {
        if (!active) {
            leaveRun();
            setInspect(null);
        } else if (!lobby && !runActive) {
            openLobby();
        }
    }, [active, lobby, runActive, openLobby, leaveRun]);

    const toCompare = useCallback(
        (file: DbFile) => {
            crown(file);
            setView("compare");
        },
        [crown, setView],
    );

    // Closing: the file view's spot goes, so the player flies back to its
    // tile; done once it has landed.
    const closeInspected = useCallback(() => setInspect((i) => (i && !i.closing ? { ...i, closing: true } : i)), []);
    const onInspectShown = useCallback(() => setInspect((i) => (i && !i.shown ? { ...i, shown: true } : i)), []);
    const onInspectClosed = useCallback(() => setInspect(null), []);
    const inspecting = !!inspect && !inspect.closing;
    const dimmed = !!inspect?.shown && !inspect.closing;
    const fadeMs = inspect?.closing ? INSPECT_OUT_MS : INSPECT_MS;
    // The run's pieces on the media go above the flight meanwhile, fading
    // with the dim (see Liftable).
    const liftFade = inspect ? { opacity: dimmed ? 0 : 1, ms: fadeMs } : null;
    useLaneFullscreen({
        active: active && !!run && runActive,
        immersive,
        setImmersive,
        pickingRef,
        inspected: !!inspect,
        closeInspected,
    });

    const running = !!run && runActive && !lobby;
    return (
        <div className="relative flex flex-1 flex-col overflow-hidden bg-neutral-950">
            {!running && !inspect && <PassLobby />}
            {/* Stays on screen under the file view (dimmed), so G comes back
                to the same file and its player can fly there and back. */}
            {running && rootPath && (
                <div
                    className="flex flex-1 flex-col overflow-hidden"
                    style={{ opacity: dimmed ? 0.06 : 1, transition: `opacity ${fadeMs}ms ease-out` }}
                >
                    <PassRun
                        active={active && !inspecting}
                        rootPath={rootPath}
                        onInspect={openInspected}
                        onCompare={toCompare}
                        liftFade={liftFade}
                    />
                </div>
            )}
            {inspect && (
                <div className="absolute inset-0 z-20 flex flex-col">
                    <SingleFileView
                        file={inspect.file}
                        active={active}
                        setView={setView}
                        onClose={closeInspected}
                        inspect={{ closing: inspect.closing, onClosed: onInspectClosed, onShown: onInspectShown }}
                    />
                </div>
            )}
        </div>
    );
}
