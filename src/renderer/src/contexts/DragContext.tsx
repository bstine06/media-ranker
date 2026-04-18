// DragContext.tsx
import { DbFile } from "@renderer/shared/types/types";
import { createContext, useContext, useCallback, ReactNode } from "react";
import { useFolders } from "./FolderContext";

interface DragContextValue {
    startDrag: (e: React.DragEvent, file: DbFile) => void;
}

const DragContext = createContext<DragContextValue | null>(null);

export function DragProvider({ children }: { children: ReactNode }) {
  const {rootPath} = useFolders();
  console.log(rootPath);
    const startDrag = useCallback((e: React.DragEvent, file: DbFile) => {
  e.dataTransfer.effectAllowed = "copy"
  e.dataTransfer.setData("text/uri-list", `file://${rootPath}/${file.path}`)
  e.dataTransfer.setData("text/plain", file.filename)
}, [])

    return (
        <DragContext.Provider value={{ startDrag }}>
            {children}
        </DragContext.Provider>
    );
}

export function useDrag() {
    const ctx = useContext(DragContext);
    if (!ctx) throw new Error("useDrag must be used within a DragProvider");
    return ctx;
}

export function useDragSource(file: DbFile) {
    const { startDrag } = useDrag();

    return {
        dragHandlers: {
            draggable: true as const,
            onDragStart: (e: React.DragEvent) => startDrag(e, file),
        },
    };
}
