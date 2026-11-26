// ─── ThumbnailImage ───────────────────────────────────────────────────────────
// A thumbnail known only by its content hash (folder pictures). Drawn turned
// by the rotation setting of the file it belongs to, kept up to date when
// that file is turned (or a turn undone).

import { toThumbnailUrl } from "@renderer/lib/media";
import { TurnedImg } from "@renderer/lib/turn";
import { useEffect, useState } from "react";

export default function ThumbnailImage({
    contentHash,
    className,
}: {
    contentHash: string;
    className?: string;
}) {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const [rotation, setRotation] = useState(0);

    useEffect(() => {
        let live = true;
        window.api.getThumbnailPath(contentHash).then((absPath) => {
            if (live && absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
        window.api.fileRotationByHash(contentHash).then((r) => {
            if (live) setRotation(r);
        });
        const off = window.api.onMediaUpdated(({ file }) => {
            if (file?.content_hash === contentHash) setRotation(file.rotation);
        });
        return () => {
            live = false;
            off();
        };
    }, [contentHash]);

    if (!thumbUrl) {
        return (
            <div
                className={`flex items-center justify-center bg-neutral-800 text-neutral-600 text-xs ${className}`}
            >
                ?
            </div>
        );
    }
    return (
        <TurnedImg rotation={rotation} src={thumbUrl} alt="" className={`object-cover ${className}`} />
    );
}
