import { createContext, useCallback, useContext, useMemo, useState } from "react";

// Sweep pass mode: going through a fixed list of files, one tag at a time,
// stepping by hand. This holds the lobby (where a run is set up); the run
// itself comes later.

/** Which files a pass goes through: those without a firm answer for the
 *  tag (yes, hard no, pass no), or every file (an audit). */
export type PassWhich = "needs-firm" | "all";

export interface LobbyDraft {
    /** Tags in the order the run will go through them. */
    tagIds: number[];
    which: PassWhich;
}

interface PassContextValue {
    /** The lobby, open over Sweep, or null. */
    lobby: LobbyDraft | null;
    /** Opens the lobby, starting with these tags (e.g. Coverage's "Pass
     *  with this tag"). */
    openLobby: (tagIds?: number[]) => void;
    updateLobby: (patch: Partial<LobbyDraft>) => void;
    closeLobby: () => void;
}

const PassContext = createContext<PassContextValue>({
    lobby: null,
    openLobby: () => {},
    updateLobby: () => {},
    closeLobby: () => {},
});

export function PassProvider({ children }: { children: React.ReactNode }): JSX.Element {
    const [lobby, setLobby] = useState<LobbyDraft | null>(null);
    const openLobby = useCallback((tagIds: number[] = []) => {
        setLobby({ tagIds, which: "needs-firm" });
    }, []);
    const updateLobby = useCallback((patch: Partial<LobbyDraft>) => {
        setLobby((l) => (l ? { ...l, ...patch } : l));
    }, []);
    const closeLobby = useCallback(() => setLobby(null), []);
    const value = useMemo(
        () => ({ lobby, openLobby, updateLobby, closeLobby }),
        [lobby, openLobby, updateLobby, closeLobby],
    );
    return <PassContext.Provider value={value}>{children}</PassContext.Provider>;
}

export const usePass = () => useContext(PassContext);
