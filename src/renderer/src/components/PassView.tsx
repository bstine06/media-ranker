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
    // G: a file open in the single file view, over the run.
    const [inspected, setInspected] = useState<DbFile | null>(null);

    // Leaving the view parks the run; coming back opens the lobby.
    useEffect(() => {
        if (!active) {
            leaveRun();
            setInspected(null);
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

    const closeInspected = useCallback(() => setInspected(null), []);
    useLaneFullscreen({
        active: active && !!run && runActive,
        immersive,
        setImmersive,
        pickingRef,
        inspected: !!inspected,
        closeInspected,
    });

    const running = !!run && runActive && !lobby;
    return (
        <div className="relative flex flex-1 flex-col overflow-hidden bg-neutral-950">
            {inspected && (
                <SingleFileView
                    file={inspected}
                    active={active}
                    setView={setView}
                    onClose={closeInspected}
                />
            )}
            {!running && !inspected && <PassLobby />}
            {/* Kept mounted under the file view, so G comes back to the same file. */}
            {running && rootPath && (
                <div className={inspected ? "hidden" : "flex flex-1 flex-col overflow-hidden"}>
                    <PassRun
                        active={active && !inspected}
                        rootPath={rootPath}
                        onInspect={setInspected}
                        onCompare={toCompare}
                    />
                </div>
            )}
        </div>
    );
}
