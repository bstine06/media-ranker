import { DbTag } from "@renderer/shared/types/types";
import { createContext, useContext, useState, useCallback } from "react";

interface Clipboard {
    copyTags: (tags: DbTag[]) => void;
    clipboard: any;
}

const ClipboardContext = createContext<Clipboard>({
    copyTags: () => {},
    clipboard: {},
});

export function ClipboardProvider({ children }: { children: React.ReactNode }) {

    const [clipboard, setClipboard] = useState<any>({});
    const copyTags = useCallback((tags: DbTag[]) => {
        setClipboard(tags);
    }, []);

    return (
        <ClipboardContext.Provider
            value={{
                copyTags,
                clipboard
            }}
        >
            {children}
        </ClipboardContext.Provider>
    );
}

export const useClipboard = () => useContext(ClipboardContext);