import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { DbFile, FolderNode } from "./shared/types/types";
import NavItem from "./components/NavItem";
import BrowseView from "./browse/components/BrowseView";
import CompareView from "./components/CompareView";
import RankingsView from "./components/RankingsView";
import Sidebar from "./components/Sidebar";
import FileView from "./components/FileView";
import { useKeyboardShortcut } from "./hooks/useKeyboard";
import { useHoverPreview } from "./browse/hooks/useHoverPreview";
import { useSettings } from "./contexts/SettingsContext";
import { useStatus } from "./contexts/StatusContext";

type View = "browse" | "compare" | "file";

function getAllPaths(nodes: FolderNode[]): string[] {
    const paths: string[] = [];
    function walk(ns: FolderNode[]) {
        for (const n of ns) {
            paths.push(n.relativePath);
            walk(n.children);
        }
    }
    walk(nodes);
    return paths;
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

function WelcomeScreen({
    onSelect,
    isLoading,
}: {
    onSelect: () => void;
    isLoading: boolean;
}): JSX.Element {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-6 bg-neutral-950">
            <div className="titlebar-drag absolute inset-x-0 top-0 h-10" />
            <h1 className="text-3xl font-bold text-white">Media Ranker</h1>
            <p className="text-neutral-400">Choose a folder to begin.</p>
            <button
                onClick={onSelect}
                disabled={isLoading}
                className="rounded-lg bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-50"
            >
                {isLoading ? "Scanning…" : "Open Library Folder"}
            </button>
        </div>
    );
}

function PlaceholderView({ label }: { label: string }): JSX.Element {
    return (
        <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
            {label}
        </div>
    );
}

export default function App(): JSX.Element {
    const [rootPath, setRootPath] = useState<string | null>(null);
    const [view, setView] = useState<View>("browse");
    const [subfolders, setSubfolders] = useState<FolderNode[]>([]);
    const [activeFolder, setActiveFolder] = useState<string | null>(null);
    const [files, setFiles] = useState<DbFile[]>([]);
    const [isScanning, setIsScanning] = useState(false);
    const [scanResult, setScanResult] = useState<{
        scanned: number;
        added: number;
    } | null>(null);
    const [checkedFolders, setCheckedFolders] = useState<Set<string>>(
        new Set(),
    );
    const [activeFile, setActiveFile] = useState<DbFile | null>(null);

    const { toggleHoverPreview, volume } = useSettings();
    const volumeRef = useRef(volume / 100);

    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
    const [tagMode, setTagMode] = useState<"and" | "or">("or");
    const [allTags, setAllTags] = useState<string[]>([]);
    const [tagFilteredIds, setTagFilteredIds] = useState<Set<number> | null>(
        null,
    );

    const { status, setStatus, resetStatus } = useStatus();

    useEffect(() => {
        volumeRef.current = volume / 100;
        const apply = (el: HTMLMediaElement) => {
            el.volume = volumeRef.current;
        };
        document
            .querySelectorAll("audio, video")
            .forEach((el) => apply(el as HTMLMediaElement));
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLMediaElement) apply(node);
                    if (node instanceof Element) {
                        node.querySelectorAll("audio, video").forEach((el) =>
                            apply(el as HTMLMediaElement),
                        );
                    }
                });
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [volume]);

    const loadFolder = useCallback(
        async (folder: string | null, root: string) => {
            setActiveFolder(folder);
            const result = folder
                ? await window.api.getFilesInFolder(folder)
                : await window.api.getAllFiles();
            setFiles(result);
        },
        [],
    );

    const toggleHoverzoom = useCallback(() => {
        toggleHoverPreview();
    }, []);

    useKeyboardShortcut({ key: "z", onKeyPressed: toggleHoverzoom });

    const openLibrary = useCallback(
        async (path: string) => {
            setIsScanning(true);
            setStatus("Opening library...");
            setRootPath(path);
            const result = await window.api.openLibrary(path);
            setScanResult({ scanned: result.scanned, added: result.added });
            const folders = await window.api.getSubfolders();
            setSubfolders(folders);
            // Check all folders by default
            setCheckedFolders(new Set(getAllPaths(folders)));
            await loadFolder(null, path);
            resetStatus();
            setIsScanning(false);
        },
        [loadFolder],
    );

    useEffect(() => {
        const removeAdded = window.api.onMediaAdded(() => {
            // Re-fetch whatever the current view is showing
            if (rootPath) loadFolder(activeFolder, rootPath);
        });

        const removeRemoved = window.api.onMediaRemoved(() => {
            if (rootPath) loadFolder(activeFolder, rootPath);
        });

        return () => {
            removeAdded();
            removeRemoved();
        };
    }, [rootPath, activeFolder, loadFolder]);

    // Load all tags once on mount (and after any tag is added/removed)
    useEffect(() => {
        window.api.getAllTags().then(setAllTags);
    }, [activeFile]);

    // Re-query DB whenever activeTags or tagMode changes
    useEffect(() => {
        if (activeTags.size === 0) {
            setTagFilteredIds(null);
            return;
        }
        window.api.getFileIdsByTags([...activeTags], tagMode).then((ids) => {
            setTagFilteredIds(new Set(ids));
        });
    }, [activeTags, tagMode]);

    const rescanLibrary = useCallback(
        async (path: string, activeFolder: string | null) => {
            setIsScanning(true);
            setStatus("Rescanning...");
            setRootPath(path);
            const result = await window.api.openLibrary(path);
            setScanResult({ scanned: result.scanned, added: result.added });
            const folders = await window.api.getSubfolders();
            setSubfolders(folders);
            // Check all folders by default
            setCheckedFolders(new Set(getAllPaths(folders)));
            await loadFolder(activeFolder, path);
            resetStatus();
            setIsScanning(false);
        },
        [loadFolder],
    );

    const handleSelectFolder = async () => {
        const path = await window.api.selectRootFolder();
        if (path) await openLibrary(path);
    };

    const handleRescanLibrary = async () => {
        const path = await window.api.getRootPath();
        if (path) await rescanLibrary(path, activeFolder);
    };

    useEffect(() => {
        window.api.getRootPath().then((savedPath) => {
            if (savedPath) openLibrary(savedPath);
        });
    }, []);

    const handleToggleFolder = useCallback(
        (relativePath: string, allPaths: string[]) => {
            setCheckedFolders((prev) => {
                const next = new Set(prev);
                const allChecked = allPaths.every((p) => next.has(p));
                if (allChecked) {
                    allPaths.forEach((p) => next.delete(p));
                } else {
                    allPaths.forEach((p) => next.add(p));
                }
                return next;
            });
        },
        [],
    );

    const handleCheckAll = useCallback(() => {
        const allPaths = getAllPaths(subfolders);
        setCheckedFolders((prev) => {
            const allChecked = allPaths.every((p) => prev.has(p));
            if (allChecked) return new Set();
            return new Set(allPaths);
        });
    }, [subfolders]);

    const handleFolderRenamed = useCallback(
        (oldRelPath: string, newRelPath: string) => {
            setSubfolders((prev) =>
                renameFolderNode(prev, oldRelPath, newRelPath),
            );
            setActiveFolder(newRelPath);
            setCheckedFolders((prev) => {
                const next = new Set<string>();
                for (const p of prev) {
                    if (p === oldRelPath) {
                        next.add(newRelPath);
                    } else if (p.startsWith(oldRelPath + "/")) {
                        // child path — rebase it
                        next.add(newRelPath + p.slice(oldRelPath.length));
                    } else {
                        next.add(p);
                    }
                }
                return next;
            });
        },
        [],
    );

    const compareFolders = useMemo(
        () => (checkedFolders.size === 0 ? null : [...checkedFolders]),
        [checkedFolders],
    );

    const previousView = useRef<"browse" | "compare">("browse");

    const handleInspectFile = (file: DbFile) => {
        previousView.current = view as "browse" | "compare";
        setActiveFile(file);
        setView("file");
    };

    const handleBackFromFile = () => {
        setView(previousView.current);
    };

    if (!rootPath) {
        return (
            <WelcomeScreen
                onSelect={handleSelectFolder}
                isLoading={isScanning}
            />
        );
    }

    const handleToggleTag = (tag: string) => {
        setActiveTags((prev) => {
            const next = new Set(prev);
            next.has(tag) ? next.delete(tag) : next.add(tag);
            return next;
        });
    };

    const handleGoToFolder = (folderPath: string) => {
        setActiveFolder(folderPath);
        setView("browse");
    }

    // Apply tag filter on top of whatever files BrowseView already receives
    const visibleFiles = tagFilteredIds
        ? files.filter((f) => tagFilteredIds.has(f.id))
        : files;

    return (
        <div className="flex h-full flex-col">
            <div className="titlebar-drag flex h-10 shrink-0 items-center bg-neutral-900 px-4 pl-20">
                <span className="titlebar-no-drag text-sm font-medium text-neutral-400">
                    Media Ranker
                </span>
                {scanResult && (
                    <span className="titlebar-no-drag ml-3 text-xs text-neutral-600">
                        {scanResult.scanned} files · {scanResult.added} new
                    </span>
                )}
            </div>

            <div className="flex flex-1 overflow-hidden">
                <Sidebar
                    rootPath={rootPath}
                    view={view}
                    setView={setView}
                    subfolders={subfolders}
                    activeFolder={activeFolder}
                    checkedFolders={checkedFolders}
                    onSelectFolder={(folder) => {
                        setView("browse");
                        loadFolder(folder, rootPath);
                    }}
                    onToggleFolder={handleToggleFolder}
                    onCheckAll={handleCheckAll}
                    onChangeLibrary={handleSelectFolder}
                    onRescanLibrary={handleRescanLibrary}
                    allTags={allTags}
                    activeTags={activeTags}
                    tagMode={tagMode}
                    onToggleTag={handleToggleTag}
                    onSetTagMode={setTagMode}
                />

                <main className="flex flex-1 flex-col overflow-hidden bg-neutral-950 min-w-0">
                    <div
                        className={
                            view === "browse"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <BrowseView
                            files={visibleFiles}
                            rootPath={rootPath}
                            activeFolder={activeFolder}
                            onFolderRenamed={handleFolderRenamed}
                            onInspectFile={handleInspectFile}
                            allTags={allTags}
                            onTagsChanged={() =>
                                window.api.getAllTags().then(setAllTags)
                            }
                        />
                    </div>
                    <div
                        className={
                            view === "compare"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <CompareView
                            rootPath={rootPath}
                            folderPrefixes={compareFolders}
                            active={view === "compare"}
                            onInspectFile={handleInspectFile}
                            activeTags={activeTags}
                            tagMode={tagMode}
                            onGoToFolder={handleGoToFolder}
                        />
                    </div>
                    {view === "file" && activeFile && (
                        <FileView
                            file={activeFile}
                            rootPath={rootPath}
                            onBack={handleBackFromFile}
                        />
                    )}
                </main>
            </div>
        </div>
    );
}
