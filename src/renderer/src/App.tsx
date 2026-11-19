import { useEffect, useState, useCallback } from "react";
import type { DbFile, FolderNode, View } from "./shared/types/types";
import BrowseView from "./browse/components/BrowseView";
import Sidebar from "./components/Sidebar";
import { useKeyboardShortcut } from "./hooks/useKeyboard";
import { useSettings } from "./contexts/SettingsContext";
import { useStatus } from "./contexts/StatusContext";
import WelcomeScreen from "./components/WelcomeScreen";
import { useTags } from "./contexts/TagsContext";
import { useFolders } from "./contexts/FolderContext";
import ScrollView from "./components/ScrollView";
import CompareView from "./components/CompareView";
import PassView from "./components/PassView";
import SweepView from "./components/SweepView";
import TagManagerView from "./components/TagManagerView";
import { CursorPointer } from "./components/TagPointer";
import { HistoryDrawer, UndoToast } from "./components/History";

export default function App(): JSX.Element {
    const [view, setView] = useState<View>("browse");
    const [isScanning, setIsScanning] = useState(false);
    const [scanResult, setScanResult] = useState<{
        scanned: number;
        added: number;
    } | null>(null);
    const { toggleHoverPreview } = useSettings();

    const [welcomeMessage, setWelcomeMessage] = useState<string | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    // Sweep's full screen: just Sweep, no sidebar (the window goes full
    // screen too). Ends with the window's full screen.
    const [immersive, setImmersive] = useState(false);
    useEffect(() => {
        if (!isFullscreen) setImmersive(false);
    }, [isFullscreen]);

    const { setStatus, resetStatus } = useStatus();
    const {
        rootPath,
        setRootPath,
        refreshFolders,
        activeFolder,
        setActiveFolder,
        resetFolders,
    } = useFolders();
    const { resetTags } = useTags();

    useEffect(() => {
        window.api.onLibraryInvalid(() => {
            setView("browse");
            setIsScanning(false);
            setScanResult(null);
            resetFolders();
            resetTags();
            setStatus("Couldn't find the library folder.");
            setWelcomeMessage(
                "Library folder was moved or renamed. Please select a new location.",
            );
        });
    }, []);

    // Catch-up scan at launch (files changed while the app was closed). Runs
    // in the background; the library is usable meanwhile.
    useEffect(() => {
        const unsubs = [
            window.api.onLibraryScanStarted(() => {
                setStatus("Checking library for changes…");
            }),
            window.api.onLibraryScanned((result) => {
                if (!result) {
                    setStatus("Couldn't check the library for changes.");
                    return;
                }
                setScanResult({ scanned: result.scanned, added: result.added });
                refreshFolders();
                if (result.added > 0) {
                    setStatus(
                        `Found ${result.added} new file${result.added === 1 ? "" : "s"}`,
                    );
                    setTimeout(resetStatus, 3000);
                } else {
                    resetStatus();
                }
            }),
        ];
        return () => unsubs.forEach((u) => u());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const cleanup = window.api.onFullscreenChange((isFullscreen) => {
            console.log("Fullscreen changed:", isFullscreen);
            setIsFullscreen(isFullscreen);
        });
        return cleanup;
    }, []);

    const toggleHoverzoom = useCallback(() => {
        toggleHoverPreview();
    }, []);

    useKeyboardShortcut({ key: "z", onKeyPressed: toggleHoverzoom });

    const openLibrary = useCallback(
        async (path: string, activeFolder: string | null = null) => {
            setIsScanning(true);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            setWelcomeMessage("Scanning the selected library...");
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
            await refreshFolders();
            setActiveFolder(activeFolder);
            resetStatus();
            setIsScanning(false);
        },
        [refreshFolders, setActiveFolder],
    );

    const handleSelectFolder = async () => {
        const path = await window.api.selectRootFolder();
        if (path) await openLibrary(path);
    };

    const handleRescanLibrary = async () => {
        const path = await window.api.getRootPath();
        if (path) await openLibrary(path, activeFolder);
    };

    if (!rootPath || isScanning) {
        return (
            <WelcomeScreen
                onSelect={handleSelectFolder}
                isLoading={isScanning}
                message={welcomeMessage}
            />
        );
    }

    return (
        <div className="flex h-full flex-col">
            {!isFullscreen && (
                <div className="titlebar-drag flex h-10 shrink-0 items-center bg-neutral-900 px-4 pl-20">
                    <div className="titlebar-drag flex flex-1 items-center justify-center">
                        <span className="text-sm font-medium text-neutral-400">
                            Media Ranker
                        </span>
                        {scanResult && (
                            <span className="ml-3 text-xs text-neutral-600">
                                {scanResult.scanned} files · {scanResult.added}{" "}
                                new
                            </span>
                        )}
                    </div>
                </div>
            )}

            <div className="flex flex-1 overflow-hidden">
                {!immersive && (
                    <Sidebar
                        view={view}
                        setView={setView}
                        onChangeLibrary={handleSelectFolder}
                        onRescanLibrary={handleRescanLibrary}
                        isFullscreen={isFullscreen}
                    />
                )}

                <main className="flex flex-1 flex-col overflow-hidden bg-neutral-950 min-w-0">
                    <div
                        className={
                            view === "browse"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <BrowseView
                            setView={setView}
                            active={view === "browse"}
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
                            active={view === "compare"}
                            setView={setView}
                        />
                    </div>
                    <div
                        className={
                            view === "sweep"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <SweepView
                            active={view === "sweep"}
                            setView={setView}
                            immersive={immersive}
                            setImmersive={setImmersive}
                        />
                    </div>
                    <div
                        className={
                            view === "pass"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <PassView
                            active={view === "pass"}
                            setView={setView}
                            immersive={immersive}
                            setImmersive={setImmersive}
                        />
                    </div>
                    <div
                        className={
                            view === "tag-manager"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <TagManagerView
                            active={view === "tag-manager"}
                            setView={setView}
                        />
                    </div>
                </main>
                {!immersive && <HistoryDrawer />}
            </div>
            <CursorPointer />
            <UndoToast />
        </div>
    );
}
