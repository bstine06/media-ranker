import { FolderNode } from "@renderer/shared/types/types";
import {
    createContext,
    useContext,
    useState,
    useCallback,
    useEffect,
} from "react";

interface FolderContextValue {
    // Structure
    rootPath: string | null;
    setRootPath: (path: string) => void;
    folders: FolderNode[];
    refreshFolders: () => Promise<void>;

    // Navigation
    activeFolder: string | null;
    setActiveFolder: (path: string | null) => void;

    // Filtering
    checkedFolders: Set<string>;
    toggleFolder: (path: string, allPaths: string[]) => void;
    checkAll: () => void;
    setAllChecked: (paths: string[]) => void;
    folderPrefixes: string[] | null; // derived — null means "all"

    // Cleanup
    resetFolders: () => void;
}

const FolderContext = createContext<FolderContextValue>({
    rootPath: null,
    setRootPath: (path: string) => {},
    folders: [],
    refreshFolders: async () => {},
    activeFolder: null,
    setActiveFolder: () => {},
    checkedFolders: new Set(),
    toggleFolder: () => {},
    checkAll: () => {},
    setAllChecked: () => {},
    folderPrefixes: null,
    resetFolders: () => {}
});

function getAllPaths(nodes: FolderNode[]): string[] {
    return nodes.flatMap((n) => [n.relativePath, ...getAllPaths(n.children)]);
}

function rebaseChildren(
    nodes: FolderNode[],
    oldBase: string,
    newBase: string,
): FolderNode[] {
    return nodes.map((n) => ({
        ...n,
        relativePath: newBase + n.relativePath.slice(oldBase.length),
        children: rebaseChildren(n.children, oldBase, newBase),
    }));
}

// helper — walks the tree and renames the matching node
function renameFolderNode(
    nodes: FolderNode[],
    oldPath: string,
    newPath: string,
): FolderNode[] {
    return nodes.map((n) => {
        if (n.relativePath === oldPath) {
            return {
                ...n,
                name: newPath.split("/").pop()!,
                relativePath: newPath,
                children: rebaseChildren(n.children, oldPath, newPath),
            };
        }
        if (oldPath.startsWith(n.relativePath + "/")) {
            return {
                ...n,
                children: renameFolderNode(n.children, oldPath, newPath),
            };
        }
        return n;
    });
}

export function FolderProvider({ children }: { children: React.ReactNode }) {
    const [rootPath, setRootPath] = useState<string | null>(null);
    const [folders, setFolders] = useState<FolderNode[]>([]);
    const [activeFolder, setActiveFolder] = useState<string | null>(null);
    const [checkedFolders, setCheckedFolders] = useState<Set<string>>(
        new Set(),
    );

    // on mount, try to restore saved root path
    useEffect(() => {
        window.api.getRootPath().then((path) => {
            if (path) {
                setRootPath(path);
            }
        });
    }, []);

    useEffect(() => {
        if (rootPath) refreshFolders();
    }, [rootPath]);

    useEffect(() => {
        if (!rootPath) return;

        const unsubs = [
            window.api.onFolderRenamed(({ oldRelativePath, relativePath }) => {
                setFolders((prev) =>
                    renameFolderNode(prev, oldRelativePath, relativePath),
                );
                setActiveFolder((prev) =>
                    prev === oldRelativePath ? relativePath : prev,
                );
                setCheckedFolders((prev) => {
                    const next = new Set<string>();
                    for (const p of prev) {
                        if (p === oldRelativePath) next.add(relativePath);
                        else if (p.startsWith(oldRelativePath + "/"))
                            next.add(
                                relativePath + p.slice(oldRelativePath.length),
                            );
                        else next.add(p);
                    }
                    return next;
                });
            }),

            window.api.onFolderRemoved(({ relativePath }) => {
                setFolders((prev) =>
                    prev.filter((f) => f.relativePath !== relativePath),
                );
                setActiveFolder((prev) =>
                    prev === relativePath ? null : prev,
                );
                setCheckedFolders((prev) => {
                    const next = new Set(prev);
                    for (const p of [...next]) {
                        if (
                            p === relativePath ||
                            p.startsWith(relativePath + "/")
                        ) {
                            next.delete(p);
                        }
                    }
                    return next;
                });
            }),

            window.api.onFolderAdded(({ relativePath }) => {
                const depth = relativePath.split("/").filter(Boolean).length;
                if (depth !== 1) return;
                setFolders((prev) => [
                    ...prev,
                    {
                        name: relativePath.split("/").pop() ?? relativePath,
                        relativePath,
                        children: [],
                    },
                ]);
            }),
        ];

        return () => unsubs.forEach((unsub) => unsub());
    }, [rootPath]);

    const checkAll = useCallback(() => {
        const allPaths = getAllPaths(folders);
        setCheckedFolders((prev) => {
            const allChecked = allPaths.every((p) => prev.has(p));
            if (allChecked) return new Set();
            return new Set(allPaths);
        });
    }, [folders]);

    const refreshFolders = useCallback(async () => {
        const folders = await window.api.getSubfolders();
        setFolders(folders);
        // on first load, check everything
        setCheckedFolders((prev) => {
            if (prev.size === 0) {
                return new Set(getAllPaths(folders));
            }
            return prev;
        });
    }, []);

    const toggleFolder = useCallback((path: string, allPaths: string[]) => {
        setCheckedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                allPaths.forEach((p) => next.delete(p));
            } else {
                allPaths.forEach((p) => next.add(p));
            }
            return next;
        });
    }, []);

    const setAllChecked = useCallback((paths: string[]) => {
        setCheckedFolders(new Set(paths));
    }, []);

    const resetFolders = useCallback(() => {
        setRootPath(null);
        setFolders([]);
        setActiveFolder(null);
        setCheckedFolders(new Set());

    }, []);

    // derived — null means no folder filter (all checked or none checked)
    const allPaths = getAllPaths(folders);
    const folderPrefixes =
        checkedFolders.size === 0 || checkedFolders.size === allPaths.length
            ? null
            : [...checkedFolders];

    return (
        <FolderContext.Provider
            value={{
                rootPath,
                setRootPath,
                folders,
                refreshFolders,
                activeFolder,
                setActiveFolder,
                checkedFolders,
                toggleFolder,
                checkAll,
                setAllChecked,
                folderPrefixes,
                resetFolders
            }}
        >
            {children}
        </FolderContext.Provider>
    );
}

export const useFolders = () => useContext(FolderContext);
