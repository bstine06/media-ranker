import { useEffect, useState, useCallback } from "react";
import type { DbFile, FolderNode } from "./types";
import NavItem from "./components/NavItem";
import BrowseView from "./components/BrowseView";
import CompareView from "./components/CompareView";
import RankingsView from "./components/RankingsView";
import Sidebar from "./components/Sidebar";

type View = "browse" | "compare" | "rankings";

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

    const openLibrary = useCallback(
        async (path: string) => {
            setIsScanning(true);
            setRootPath(path);
            const result = await window.api.openLibrary(path);
            setScanResult({ scanned: result.scanned, added: result.added });
            const folders = await window.api.getSubfolders();
            setSubfolders(folders);
            // Check all folders by default
            setCheckedFolders(new Set(getAllPaths(folders)));
            await loadFolder(null, path);
            setIsScanning(false);
        },
        [loadFolder],
    );

    const handleSelectFolder = async () => {
        const path = await window.api.selectRootFolder();
        if (path) await openLibrary(path);
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

    if (!rootPath) {
        return (
            <WelcomeScreen
                onSelect={handleSelectFolder}
                isLoading={isScanning}
            />
        );
    }

    const compareFolders =
        checkedFolders.size === 0 ? null : [...checkedFolders];

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
                />

                <main className="flex flex-1 flex-col overflow-hidden bg-neutral-950 min-w-0">
                    {view === "browse" && (
                        <BrowseView
                            files={files}
                            rootPath={rootPath}
                            activeFolder={activeFolder}
                        />
                    )}
                    {view === "compare" && (
                        <CompareView
                            rootPath={rootPath}
                            folderPrefixes={compareFolders}
                        />
                    )}
                    {view === "rankings" && (
                        <RankingsView
                            rootPath={rootPath}
                            folderPrefixes={compareFolders}
                        />
                    )}
                </main>
            </div>
        </div>
    );
}
