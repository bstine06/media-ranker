import { createContext, useCallback, useContext, useState } from "react";

/** Placement matches each new file gets: it stays on screen in Compare
 *  until it has this many comparisons (main/placement.ts). */
export const PLACEMENT_MATCHES = 10;

/** Placement started from Browse: only this collection's files are placed
 *  (against each other), then Compare returns to Browse. */
export interface PlacementSession {
    folder: string;
    /** Files needing placement when it started, for the "N placed" message. */
    total: number;
}

interface PlacementContextValue {
    session: PlacementSession | null;
    startSession: (session: PlacementSession) => void;
    endSession: () => void;
    /** Bumped after each placement match, so counts shown elsewhere refresh. */
    version: number;
    bump: () => void;
}

const PlacementContext = createContext<PlacementContextValue>({
    session: null,
    startSession: () => {},
    endSession: () => {},
    version: 0,
    bump: () => {},
});

export function PlacementProvider({ children }: { children: React.ReactNode }) {
    const [session, setSession] = useState<PlacementSession | null>(null);
    const [version, setVersion] = useState(0);
    const startSession = useCallback((s: PlacementSession) => setSession(s), []);
    const endSession = useCallback(() => setSession(null), []);
    const bump = useCallback(() => setVersion((v) => v + 1), []);
    return (
        <PlacementContext.Provider
            value={{ session, startSession, endSession, version, bump }}
        >
            {children}
        </PlacementContext.Provider>
    );
}

export const usePlacement = () => useContext(PlacementContext);
