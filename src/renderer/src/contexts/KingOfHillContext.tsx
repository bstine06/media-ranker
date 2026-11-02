import { createContext, useCallback, useContext, useState } from "react";
import type { DbFile } from "@renderer/shared/types/types";

export interface KingState {
    file: DbFile;
    /** Wins since this file took the hill. */
    streak: number;
    /** Which compare card the king sits on; it stays there between matches. */
    side: "a" | "b";
}

interface KingOfHillContextValue {
    king: KingState | null;
    /** Put a file on the hill (streak starts at 0). */
    crown: (file: DbFile, side?: "a" | "b") => void;
    setKing: (king: KingState | null) => void;
    endKing: () => void;
}

const KingOfHillContext = createContext<KingOfHillContextValue>({
    king: null,
    crown: () => {},
    setKing: () => {},
    endKing: () => {},
});

export function KingOfHillProvider({
    children,
}: {
    children: React.ReactNode;
}): JSX.Element {
    const [king, setKing] = useState<KingState | null>(null);

    const crown = useCallback((file: DbFile, side: "a" | "b" = "a") => {
        setKing({ file, streak: 0, side });
    }, []);

    const endKing = useCallback(() => setKing(null), []);

    return (
        <KingOfHillContext.Provider value={{ king, crown, setKing, endKing }}>
            {children}
        </KingOfHillContext.Provider>
    );
}

export function useKingOfHill(): KingOfHillContextValue {
    return useContext(KingOfHillContext);
}
