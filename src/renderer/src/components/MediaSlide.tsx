import React, { useCallback, useRef } from "react";
import { DbFile } from "@renderer/shared/types/types";
import { MediaPlayer } from "./MediaPlayer";

export const MediaSlide = React.forwardRef<
    HTMLVideoElement,
    { file: DbFile; rootPath: string; disabled: boolean }
>(({ file, rootPath, disabled }, ref) => {
    const localRef = useRef<HTMLVideoElement>(null);
    return (
        <div className="relative flex h-full w-full flex-col bg-black">
            <MediaPlayer
                file={file}
                rootPath={rootPath}
                muted={false}
                className="h-full w-full"
                disabled={disabled}
            />
        </div>
    );
});