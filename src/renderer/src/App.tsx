import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { DbFile, FolderNode } from "./shared/types/types";
import BrowseView from "./browse/components/BrowseView";
import CompareView from "./components/CompareView";
import Sidebar from "./components/Sidebar";
import FileView from "./components/FileView";
import { useKeyboardShortcut } from "./hooks/useKeyboard";
import { useSettings } from "./contexts/SettingsContext";
import { useStatus } from "./contexts/StatusContext";
import ScrollView from "./components/ScrollView";
import WelcomeScreen from "./components/WelcomeScreen";

type View = "browse" | "compare" | "file" | "scroll";

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
    const [welcomeMessage, setWelcomeMessage] = useState<string | null>(null);

    const { status, setStatus, resetStatus } = useStatus();

    useEffect(() => {
        window.api.onLibraryInvalid(() => {
            setRootPath(null);
            setView("browse");
            setSubfolders([]);
            setActiveFolder(null);
            setFiles([]);
            setIsScanning(false);
            setScanResult(null);
            setCheckedFolders(new Set());
            setActiveFile(null);
            setActiveTags(new Set());
            setTagMode("or");
            setAllTags([]);
            setTagFilteredIds(null);
            setStatus(
                "Library folder was moved or renamed. Please select a new location.",
            );
            setWelcomeMessage(
                "Library folder was moved or renamed. Please select a new location.",
            );
        });
    }, []);

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
        async (folder: string | null) => {
            setActiveFolder(folder);
            const result = folder
                ? await window.api.getFilesInFolder(folder)
                : await window.api.getAllActiveFiles();
            setFiles(result);
        },
        [],
    );

    const toggleHoverzoom = useCallback(() => {
        toggleHoverPreview();
    }, []);

    useKeyboardShortcut({ key: "z", onKeyPressed: toggleHoverzoom });

    const openLibrary = useCallback(
        async (path: string, activeFolder: string | null = null) => {
            setIsScanning(true);
            setStatus(activeFolder ? "Rescanning..." : "Opening library...");
            setRootPath(path);

            let result;
            try {
                result = await window.api.openLibrary(path);
            } catch (e) {
                setStatus(
                    "Library not found. Change library to select a valid folder.",
                );
                setIsScanning(false);
                return;
            }

            setScanResult({ scanned: result.scanned, added: result.added });
            const folders = await window.api.getSubfolders();
            setSubfolders(folders);
            setCheckedFolders(new Set(getAllPaths(folders)));
            await loadFolder(activeFolder);
            const tags = await window.api.getAllTags();
            setAllTags(tags);
            resetStatus();
            setIsScanning(false);
        },
        [loadFolder],
    );

    useEffect(() => {
        const handleAdded = window.api.onMediaAdded(
            ({ relativePath, hash, mediaType }) => {
                // only matters if it belongs to the active folder (or we're in all-files view)
                const folderPath = relativePath
                    .split("/")
                    .slice(0, -1)
                    .join("/");
                if (activeFolder && folderPath !== activeFolder) return;
                if (rootPath) loadFolder(activeFolder); // still reload for adds — need full DbFile
            },
        );

        const handleRemoved = window.api.onMediaRemoved(({ relativePath }) => {
            // always remove from state regardless of which folder is active
            setFiles((prev) => prev.filter((f) => f.path !== relativePath));
        });

        const handleRenamed = window.api.onMediaRenamed(
            ({ oldRelativePath, relativePath }) => {
                setFiles((prev) =>
                    prev.map((f) =>
                        f.path === oldRelativePath
                            ? {
                                  ...f,
                                  path: relativePath,
                                  filename:
                                      relativePath.split("/").pop() ??
                                      f.filename,
                              }
                            : f,
                    ),
                );
            },
        );

        const handleFolderRenamed = window.api.onFolderRenamed(
            ({ oldRelativePath, relativePath }) => {
                setSubfolders((prev) =>
                    prev.map((f) =>
                        f.relativePath === oldRelativePath
                            ? {
                                  ...f,
                                  name: relativePath.split("/").pop() ?? f.name,
                                  relativePath,
                              }
                            : f,
                    ),
                );
                if (activeFolder === oldRelativePath)
                    setActiveFolder(relativePath);
                console.log("Folder renamed");
            },
        );

        const handleFolderRemoved = window.api.onFolderRemoved(
            ({ relativePath }) => {
                setSubfolders((prev) =>
                    prev.filter((f) => f.relativePath !== relativePath),
                );
                if (activeFolder === relativePath) {
                    setActiveFolder(null); // or wherever you send users when active folder disappears
                    if (rootPath) loadFolder(null);
                }
            },
        );

        const handleFolderAdded = window.api.onFolderAdded(
            ({ relativePath }) => {
                const depth = relativePath.split("/").filter(Boolean).length;
                if (depth !== 1) return;
                setSubfolders((prev) => [
                    ...prev,
                    {
                        name: relativePath.split("/").pop() ?? relativePath,
                        relativePath,
                        children: [],
                    },
                ]);
                console.log("Folder added");
            },
        );

        return () => {
            handleAdded();
            handleRemoved();
            handleRenamed();
            handleFolderRenamed();
            handleFolderRemoved();
            handleFolderAdded();
        };
    }, [rootPath, activeFolder, loadFolder]);

    // Load all tags once on mount (and after any tag is added/removed)
    useEffect(() => {
        if (!activeFile) return;
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

    useEffect(() => {
        if (activeFile && files.length > 0) {
            const updated = files.find(
                (f) => f.content_hash === activeFile.content_hash,
            );
            if (updated) setActiveFile(updated);
        }
    }, [files]);

    const handleSelectFolder = async () => {
        const path = await window.api.selectRootFolder();
        if (path) await openLibrary(path);
    };

    const handleRescanLibrary = async () => {
        const path = await window.api.getRootPath();
        if (path) await openLibrary(path, activeFolder);
    };

    useEffect(() => {
        window.api.getRootPath().then((savedPath) => {
            if (savedPath) {
                openLibrary(savedPath).then(() => {
                    window.api.getAllTags().then(setAllTags);
                });
            }
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
                message={welcomeMessage}
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

    const handleGoToFolder = (folder: string) => {
        setView("browse");
        loadFolder(folder);
    };

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
                        loadFolder(folder);
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
                    <div
                        className={
                            view === "scroll"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <ScrollView
                            rootPath={rootPath}
                            folderPrefixes={compareFolders}
                            active={view === "scroll"}
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
