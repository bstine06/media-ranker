import { FolderNode } from "@renderer/shared/types/types";
import {
    createContext,
    useContext,
    useState,
    useCallback,
    useEffect,
    useRef,
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
    /** Browsing files that sit directly in the library folder. activeFolder
     *  is null while this is on. Choosing a folder turns it off. */
    showUnsorted: boolean;
    setShowUnsorted: (show: boolean) => void;

    // Filtering
    checkedFolders: Set<string>;
    toggleFolder: (path: string, allPaths: string[]) => void;
    checkAll: () => void;
    setAllChecked: (paths: string[]) => void;
    /** Derived: null = every collection selected (no limit, Unsorted
     *  included), [] = none selected (no files), else the selected ones. */
    folderPrefixes: string[] | null;

    // Compare's per-side folder checkboxes (session only). Same rules as
    // checkedFolders: none or all checked means no folder limit.

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
    const [folderMetaVersion, setFolderMetaVersion] = useState(0);
    
    const handleFolderMetadataChanged = useCallback(() => {
        setFolderMetaVersion((v) => v + 1);
    }, []);

    // The folders as of now, for callbacks that outlive a render.
    const foldersRef = useRef(folders);
    foldersRef.current = folders;
    const loadedOnce = useRef(false);
    useEffect(() => {
        loadedOnce.current = false;
    }, [rootPath]);

    // New folders join the selection when every folder was selected, so
    // "all collections" stays all (from the app or from Finder).
    const joinIfAllSelected = useCallback((added: string[]) => {
        if (added.length === 0) return;
        const before = getAllPaths(foldersRef.current);
        setCheckedFolders((prev) => {
            if (!before.every((p) => prev.has(p))) return prev;
            const next = new Set(prev);
            added.forEach((p) => next.add(p));
            return next;
        });
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
            }),

            window.api.onFolderRemoved(({ relativePath }) => {
                setFolders((prev) =>
                    prev.filter((f) => f.relativePath !== relativePath),
                );
                setActiveFolder((prev) =>
                    prev === relativePath ? null : prev,
                );
                setCheckedFolders((prev) => removeFromSet(prev, relativePath));
            }),

            window.api.onFolderAdded(({ relativePath }) => {
                const depth = relativePath.split("/").filter(Boolean).length;
                if (depth !== 1) return;
                joinIfAllSelected([relativePath]);
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
        const next = await window.api.getSubfolders();
        // The library's first load selects everything. After that, new
        // folders join the selection only while everything is selected.
        if (!loadedOnce.current) {
            loadedOnce.current = true;
            setCheckedFolders(new Set(getAllPaths(next)));
        } else {
            const known = new Set(getAllPaths(foldersRef.current));
            joinIfAllSelected(getAllPaths(next).filter((p) => !known.has(p)));
        }
        setFolders(next);
    }, [joinIfAllSelected]);

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
        setShowUnsorted(false);
        setCheckedFolders(new Set());

    }, []);

    // Derived: see folderPrefixes above.
    const allPaths = getAllPaths(folders);
    const folderPrefixes = allPaths.every((p) => checkedFolders.has(p))
        ? null
        : allPaths.filter((p) => checkedFolders.has(p));

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
