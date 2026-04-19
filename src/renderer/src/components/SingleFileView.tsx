import {
    useCallback,
    useEffect,
    useState,
} from "react";
import { DbFile, View } from "@renderer/shared/types/types";
import { useFolders } from "@renderer/contexts/FolderContext";
import ScrollView from "./ScrollView";
import { showInFolder } from "@renderer/lib/filesystem";
import { SlotResolver } from "@renderer/hooks/useScrollSlots";


export default function SingleFileView({
    onClose,
    file,
    active,
    setView,
}: {
    onClose: () => void;
    file: DbFile;
    active: boolean;
    setView: (view: View) => void;
}): JSX.Element {
    const [folderProfileHash, setFolderProfileHash] = useState<string | null>(
        null,
    );

    const { rootPath, setActiveFolder, folderMetaVersion } = useFolders();

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
                setView("browse");
            }}
            onFileClick={(file) => showInFolder(rootPath!, file.path)}
        />
    );
}
