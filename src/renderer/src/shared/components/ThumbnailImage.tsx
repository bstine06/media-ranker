// ─── ThumbnailImage ───────────────────────────────────────────────────────────

import { toThumbnailUrl } from "@renderer/lib/media";
import { useEffect, useState } from "react";

export default function ThumbnailImage({
    contentHash,
    className,
    isVideo,
}: {
    contentHash: string;
    className?: string;
    isVideo?: boolean;
}) {
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);

    useEffect(() => {
        window.api.getThumbnailPath(contentHash).then((absPath) => {
            if (absPath) setThumbUrl(toThumbnailUrl(absPath));
        });
    }, [contentHash]);

    if (!thumbUrl) {
        return (
            <div
                className={`flex items-center justify-center bg-neutral-800 text-neutral-600 text-xs ${className}`}
            >
                {isVideo ? "▶" : "?"}
            </div>
        );
    }
    return (
        <img src={thumbUrl} alt="" className={`object-cover ${className}`} />
    );
}