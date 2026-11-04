import { FolderNode } from "@renderer/shared/types/types";
import {
    createContext,
    useContext,
    useState,
    useCallback,
    useEffect,
    useRef,
} from "react";

/** A side of Compare: a = left, b = right. */
export type Lane = "a" | "b";

interface FolderContextValue {
    // Structure
    rootPath: string | null;
    setRootPath: (path: string) => void;
    folders: FolderNode[];
    refreshFolders: () => Promise<void>;

    // Navigation
    activeFolder: string | null;
    setActiveFolder: (path: string | null) => void;
    /** Browsing files that sit directly in the library folder. activeFolder
     *  is null while this is on. Choosing a folder turns it off. */
    showUnsorted: boolean;
    setShowUnsorted: (show: boolean) => void;

    // Filtering
    checkedFolders: Set<string>;
    toggleFolder: (path: string, allPaths: string[]) => void;
    checkAll: () => void;
    setAllChecked: (paths: string[]) => void;
    folderPrefixes: string[] | null; // derived — null means "all"

    // Compare's per-side folder checkboxes (session only). Same rules as
    // checkedFolders: none or all checked means no folder limit.
    laneChecked: Record<Lane, Set<string>>;
    toggleLaneFolder: (lane: Lane, path: string) => void;
    toggleLaneAll: (lane: Lane) => void;
    laneFolderPrefixes: Record<Lane, string[] | null>; // derived

    // Folder metadata to prompt changes throughout app
    folderMetaVersion: number;
    handleFolderMetadataChanged: () => void;

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
    showUnsorted: false,
    setShowUnsorted: () => {},
    checkedFolders: new Set(),
    toggleFolder: () => {},
    checkAll: () => {},
    setAllChecked: () => {},
    folderPrefixes: null,
    laneChecked: { a: new Set(), b: new Set() },
    toggleLaneFolder: () => {},
    toggleLaneAll: () => {},
    laneFolderPrefixes: { a: null, b: null },
    folderMetaVersion: 0,
    handleFolderMetadataChanged: () => {},
    resetFolders: () => {}
});

function getAllPaths(nodes: FolderNode[]): string[] {
    return nodes.flatMap((n) => [n.relativePath, ...getAllPaths(n.children)]);
}

// Path sets after a folder rename / removal (the folder and everything in it).
function renameInSet(
    prev: Set<string>,
    oldPath: string,
    newPath: string,
): Set<string> {
    const next = new Set<string>();
    for (const p of prev) {
        if (p === oldPath) next.add(newPath);
        else if (p.startsWith(oldPath + "/"))
            next.add(newPath + p.slice(oldPath.length));
        else next.add(p);
    }
    return next;
}

function removeFromSet(prev: Set<string>, path: string): Set<string> {
    const next = new Set(prev);
    for (const p of [...next]) {
        if (p === path || p.startsWith(path + "/")) next.delete(p);
    }
    return next;
}

function mapLanes(
    lanes: Record<Lane, Set<string>>,
    fn: (set: Set<string>) => Set<string>,
): Record<Lane, Set<string>> {
    return { a: fn(lanes.a), b: fn(lanes.b) };
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
    const [showUnsorted, setShowUnsorted] = useState(false);
    // Picking a real folder always leaves Unsorted.
    const selectFolder = useCallback((path: string | null) => {
        if (path !== null) setShowUnsorted(false);
        setActiveFolder(path);
    }, []);
    const [checkedFolders, setCheckedFolders] = useState<Set<string>>(
        new Set(),
    );
    const [laneChecked, setLaneChecked] = useState<
        Record<Lane, Set<string>>
    >({ a: new Set(), b: new Set() });
    const lanesInitializedRef = useRef(false);
    const [folderMetaVersion, setFolderMetaVersion] = useState(0);
    
    const handleFolderMetadataChanged = useCallback(() => {
        setFolderMetaVersion((v) => v + 1);
    }, []);

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
                setCheckedFolders((prev) =>
                    renameInSet(prev, oldRelativePath, relativePath),
                );
                setLaneChecked((prev) =>
                    mapLanes(prev, (set) =>
                        renameInSet(set, oldRelativePath, relativePath),
                    ),
                );
            }),

            window.api.onFolderRemoved(({ relativePath }) => {
                setFolders((prev) =>
                    prev.filter((f) => f.relativePath !== relativePath),
                );
                setActiveFolder((prev) =>
                    prev === relativePath ? null : prev,
                );
                setCheckedFolders((prev) => removeFromSet(prev, relativePath));
                setLaneChecked((prev) =>
                    mapLanes(prev, (set) => removeFromSet(set, relativePath)),
                );
            }),

            window.api.onFolderAdded(({ relativePath }) => {
                const depth = relativePath.split("/").filter(Boolean).length;
                if (depth !== 1) return;
                setFolders((prev) => prev.some((f) => f.relativePath === relativePath) ? prev : [
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
        if (!lanesInitializedRef.current) {
            lanesInitializedRef.current = true;
            const all = getAllPaths(folders);
            setLaneChecked({ a: new Set(all), b: new Set(all) });
        }
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
        // A new folder made while a lane had everything checked joins it.
        setLaneChecked((prev) =>
            mapLanes(prev, (set) =>
                paths.every((p) => set.has(p) || !folders.some((f) => f.relativePath === p))
                    ? new Set(paths)
                    : set,
            ),
        );
    }, [folders]);

    const toggleLaneFolder = useCallback((lane: Lane, path: string) => {
        setLaneChecked((prev) => {
            const next = new Set(prev[lane]);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return { ...prev, [lane]: next };
        });
    }, []);

    const toggleLaneAll = useCallback(
        (lane: Lane) => {
            const allPaths = getAllPaths(folders);
            setLaneChecked((prev) => {
                const allChecked = allPaths.every((p) => prev[lane].has(p));
                return {
                    ...prev,
                    [lane]: allChecked ? new Set() : new Set(allPaths),
                };
            });
        },
        [folders],
    );

    const resetFolders = useCallback(() => {
        setRootPath(null);
        setFolders([]);
        setActiveFolder(null);
        setShowUnsorted(false);
        setCheckedFolders(new Set());
        setLaneChecked({ a: new Set(), b: new Set() });
        lanesInitializedRef.current = false;

    }, []);

    // derived — null means no folder filter (all checked or none checked)
    const allPaths = getAllPaths(folders);
    const folderPrefixes =
        checkedFolders.size === 0 || checkedFolders.size === allPaths.length
            ? null
            : [...checkedFolders];
    const lanePrefixes = (set: Set<string>): string[] | null =>
        set.size === 0 || allPaths.every((p) => set.has(p)) ? null : [...set];
    const laneFolderPrefixes = {
        a: lanePrefixes(laneChecked.a),
        b: lanePrefixes(laneChecked.b),
    };

    return (
        <FolderContext.Provider
            value={{
                rootPath,
                setRootPath,
                folders,
                refreshFolders,
                activeFolder,
                setActiveFolder: selectFolder,
                showUnsorted,
                setShowUnsorted,
                checkedFolders,
                toggleFolder,
                checkAll,
                setAllChecked,
                folderPrefixes,
                laneChecked,
                toggleLaneFolder,
                toggleLaneAll,
                laneFolderPrefixes,
                folderMetaVersion,
                handleFolderMetadataChanged,
                resetFolders
            }}
        >
            {children}
        </FolderContext.Provider>
    );
}

export const useFolders = () => useContext(FolderContext);
