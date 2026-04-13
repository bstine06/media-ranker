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

export default function App(): JSX.Element {
    const [view, setView] = useState<View>("browse");
    const [isScanning, setIsScanning] = useState(false);
    const [scanResult, setScanResult] = useState<{
        scanned: number;
        added: number;
    } | null>(null);
    const { toggleHoverPreview } = useSettings();

    const [welcomeMessage, setWelcomeMessage] = useState<string | null>(null);

    const [folderMetaVersion, setFolderMetaVersion] = useState(0);

    const handleFolderMetadataChanged = useCallback(() => {
        setFolderMetaVersion((v) => v + 1);
    }, []);

    const { setStatus, resetStatus } = useStatus();
    const { rootPath, setRootPath, refreshFolders, activeFolder, setActiveFolder, resetFolders } = useFolders();
    const { resetTags } = useTags();

    useEffect

    useEffect(() => {
        window.api.onLibraryInvalid(() => {
            setView("browse");
            setIsScanning(false);
            setScanResult(null);
            resetFolders();
            resetTags();
            setStatus(
                "Couldn't find the library folder.",
            );
            setWelcomeMessage(
                "Library folder was moved or renamed. Please select a new location.",
            );
        });
    }, []);

    const toggleHoverzoom = useCallback(() => {
        toggleHoverPreview();
    }, []); 

    useKeyboardShortcut({ key: "z", onKeyPressed: toggleHoverzoom });

    const openLibrary = useCallback(
        async (path: string, activeFolder: string | null = null) => {
            setIsScanning(true);
            setWelcomeMessage("Scanning the selected library...");
            setStatus(activeFolder ? "Rescanning..." : "Opening library...");
            setRootPath(path);

            let result;
            try {
                result = await window.api.openLibrary(path);
            } catch (e) {
                setStatus("Library not found. Change library to select a valid folder.");
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
                    onChangeLibrary={handleSelectFolder}
                    onRescanLibrary={handleRescanLibrary}
                    folderMetaVersion={folderMetaVersion}
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
                            onFolderMetadataChanged={handleFolderMetadataChanged}
                            setView={setView}
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
                            view === "scroll"
                                ? "flex flex-1 flex-col overflow-hidden"
                                : "hidden"
                        }
                    >
                        <ScrollView
                            active={view === "scroll"}
                            setView={setView}
                            folderMetaVersion={folderMetaVersion}
                        />
                    </div>
                </main>
            </div>
        </div>
    );
}
