import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { DbFile, View } from "@renderer/shared/types/types";
import { useFolders } from "@renderer/contexts/FolderContext";
import ScrollView, { InspectProps } from "./ScrollView";
import { showInFolder } from "@renderer/lib/filesystem";
import { SlotResolver } from "@renderer/hooks/useScrollSlots";
import { usePlacement } from "@renderer/contexts/PlacementContext";


export default function SingleFileView({
    onClose,
    file,
    active,
    setView,
    inspect,
}: {
    onClose: () => void;
    file: DbFile;
    active: boolean;
    setView: (view: View) => void;
    /** Opened as an inspection (grows from its spot; see ScrollView). */
    inspect?: InspectProps;
}): JSX.Element {
    const [folderProfileHash, setFolderProfileHash] = useState<string | null>(
        null,
    );

    const { rootPath, setActiveFolder, setShowUnsorted, folderMetaVersion } = useFolders();
    const { startSession } = usePlacement();

    // Its file deleted (here, by a redo, in Finder): there's nothing to
    // move on to, so the view closes. Renames are followed first, so the
    // path compared is the current one.
    const pathRef = useRef(file.path);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        pathRef.current = file.path;
        const offRenamed = window.api.onMediaRenamed(({ oldRelativePath, relativePath }) => {
            if (oldRelativePath === pathRef.current) pathRef.current = relativePath;
        });
        const offRemoved = window.api.onMediaRemoved(({ relativePath }) => {
            if (relativePath === pathRef.current) onCloseRef.current();
        });
        return () => {
            offRenamed();
            offRemoved();
        };
    }, [file.id, file.path]);

    //resolver to appease ScrollView
    const resolver: SlotResolver = useCallback(async () => {
        return null;
    }, []);

    // Folder profile image
    const folder =
        file?.path.split("/")[0] ?? null;
    useEffect(() => {
        if (!folder) return;
        window.api
            .getFolder(folder)
            .then((f) => setFolderProfileHash(f?.profile_image_hash ?? null))
            .catch(() => setFolderProfileHash(null));
    }, [folder, folderMetaVersion]);

    if (!file)
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-500">
                No file found
            </div>
        );

    return (
        <ScrollView
            onClose={onClose}
            initialFile={file}
            resolver={resolver}
            active={active}
            rootPath={rootPath!}
            folderProfileHash={folderProfileHash}
            onFolderClick={(folderName) => {
                setActiveFolder(folderName);
                if (folderName === null) setShowUnsorted(true);
                setView("browse");
            }}
            onFileClick={(file) => showInFolder(rootPath!, file.path)}
            onPlace={(file) => {
                // Opened from Compare: the session takes over Compare.
                startSession({ kind: "file", file, returnTo: "compare" });
                setView("compare");
            }}
            inspect={inspect}
        />
    );
}
