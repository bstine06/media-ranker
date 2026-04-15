import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { DbFile, View } from "@renderer/shared/types/types";
import { useTags } from "@renderer/contexts/TagsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { toMediaUrl } from "@renderer/lib/media";
import { SlotResolver } from "@renderer/hooks/useScrollSlots";
import ScrollView from "./ScrollView";
import { showInFolder } from "@renderer/lib/filesystem";

const preloadCache = new Map<string, HTMLImageElement>();
function preloadImage(url: string): Promise<void> {
    if (preloadCache.has(url)) return Promise.resolve();
    const img = new Image();
    img.src = url;
    preloadCache.set(url, img);
    return img.decode().catch(() => {});
}

export default function DiscoverView({
    active,
    setView,
    folderMetaVersion,
}: {
    active: boolean;
    setView: (view: View) => void;
    folderMetaVersion: number;
}): JSX.Element {
    const [history, setHistory] = useState<DbFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [initialFile, setInitialFile] = useState<DbFile | null>(null);
    const [folderProfileHash, setFolderProfileHash] = useState<string | null>(
        null,
    );

    const { activeTags, tagMode } = useTags();
    const { rootPath, folderPrefixes, setActiveFolder } = useFolders();

    const prefetchRef = useRef<DbFile | null>(null);
    const historyRef = useRef<DbFile[]>([]);
    const cursorRef = useRef(0);

    const tagKey = useMemo(
        () => [...activeTags].sort().join(","),
        [activeTags],
    );

    const folderPrefixesRef = useRef(folderPrefixes);
    const activeTagsRef = useRef(activeTags);
    const tagModeRef = useRef(tagMode);
    useEffect(() => {
        folderPrefixesRef.current = folderPrefixes;
    }, [folderPrefixes]);
    useEffect(() => {
        activeTagsRef.current = activeTags;
    }, [activeTags]);
    useEffect(() => {
        tagModeRef.current = tagMode;
    }, [tagMode]);

    // Keep historyRef in sync
    useEffect(() => {
        historyRef.current = history;
    }, [history]);

    const fetchOne = useCallback(
        async (exclude: DbFile[] = []): Promise<DbFile | null> => {
            const tags = activeTagsRef.current;
            const tagList = tags.size > 0 ? [...tags] : null;
            const excludeIds = exclude.map((f) => f.id);
            let file = await window.api.getRandomFile(
                folderPrefixesRef.current,
                tagList,
                tagModeRef.current,
                excludeIds,
            );
            if (!file) {
                file = await window.api.getRandomFile(
                    folderPrefixesRef.current,
                    tagList,
                    tagModeRef.current,
                    [],
                );
            }
            if (file && file.media_type !== "video") {
                preloadImage(toMediaUrl(rootPath!, file.path));
            }
            return file;
        },
        [rootPath],
    );

    const fetchOneRef = useRef(fetchOne);
    useEffect(() => {
        fetchOneRef.current = fetchOne;
    }, [fetchOne]);

    // Initial load
    useEffect(() => {
        setLoading(true);
        prefetchRef.current = null;
        setHistory([]);
        historyRef.current = [];

        fetchOne([]).then((file) => {
            if (!file) {
                setLoading(false);
                return;
            }
            setInitialFile(file);
            setHistory([file]);
            historyRef.current = [file];
            setLoading(false);
            fetchOne([file]).then((f) => {
                prefetchRef.current = f;
            });
        });
    }, [rootPath]);

    // Bust prefetch on filter changes
    useEffect(() => {
        prefetchRef.current = null;
    }, [folderPrefixes, tagKey, tagMode]);

    // Re-bootstrap if no files
    const hasNoFiles = !loading && history.length === 0;
    useEffect(() => {
        if (!hasNoFiles) return;
        prefetchRef.current = null;
        fetchOne([]).then((file) => {
            if (!file) return;
            setInitialFile(file);
            setHistory([file]);
            historyRef.current = [file];
            fetchOne([file]).then((f) => {
                prefetchRef.current = f;
            });
        });
    }, [folderPrefixes, tagKey, tagMode]);

    // Folder profile image
    const currentFolder = initialFile?.path.split("/")[0] ?? null;
    useEffect(() => {
        if (!currentFolder) return;
        window.api
            .getFolder(currentFolder)
            .then((f) => setFolderProfileHash(f?.profile_image_hash ?? null))
            .catch(() => setFolderProfileHash(null));
    }, [currentFolder, folderMetaVersion]);

    // Media rename handler
    useEffect(() => {
        const unsub = window.api.onMediaRenamed(
            ({ oldRelativePath, relativePath }) => {
                if (prefetchRef.current?.path === oldRelativePath) {
                    prefetchRef.current = {
                        ...prefetchRef.current,
                        path: relativePath,
                        filename:
                            relativePath.split("/").pop() ??
                            prefetchRef.current.filename,
                    };
                }
            },
        );
        return () => unsub();
    }, []);

    const resolver: SlotResolver = useCallback(async (dir, cursor) => {
        const h = historyRef.current;

        if (dir === "up") return h[cursor - 1] ?? null;

        const candidate = prefetchRef.current;
        prefetchRef.current = null;
        const isDupe = candidate && h.some((f) => f.id === candidate.id);
        const next = isDupe
            ? await fetchOneRef.current(h)
            : (candidate ?? (await fetchOneRef.current(h)));
        if (!next) return null;
        setHistory((prev) => {
            const updated = [...prev, next];
            historyRef.current = updated;
            return updated;
        });
        fetchOneRef.current([...h, next]).then((f) => {
            prefetchRef.current = f;
        });
        return next;
    }, []);

    if (loading)
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-500">
                Loading…
            </div>
        );
    if (!initialFile)
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-500">
                No files found
            </div>
        );

    return (
        <ScrollView
            initialFile={initialFile}
            resolver={resolver}
            active={active}
            rootPath={rootPath!}
            folderProfileHash={folderProfileHash}
            onFolderClick={(folderName) => {
                setActiveFolder(folderName);
                setView("browse");
            }}
            onFileClick={(file) => showInFolder(rootPath!, file.path)}
        />
    );
}
