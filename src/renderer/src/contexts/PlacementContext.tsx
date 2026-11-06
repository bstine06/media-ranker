import { createContext, useCallback, useContext, useState } from "react";
import type { DbFile, View } from "@renderer/shared/types/types";

/** Placement matches each new file gets: it stays on screen in Compare
 *  until it has this many comparisons (main/placement.ts). */
export const PLACEMENT_MATCHES = 10;

/**
 * Placement run in Compare, against the whole library, then back to
 * `returnTo`:
 * - "folder": a collection's files that still need placement (Browse's
 *   "Place N new").
 * - "file": one file gets PLACEMENT_MATCHES fresh matches, however many
 *   comparisons it already has (the single file view's Place button).
 */
export type PlacementSession =
    | {
          kind: "folder";
          folder: string;
          /** Files needing placement when it started, for the "N placed" message. */
          total: number;
          returnTo: View;
      }
    | { kind: "file"; file: DbFile; returnTo: View };

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
