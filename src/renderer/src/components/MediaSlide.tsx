import React from "react";
import { DbFile } from "@renderer/shared/types/types";
import { MediaPlayer } from "./MediaPlayer";

export const MediaSlide = React.forwardRef<
    HTMLVideoElement,
    {
        file: DbFile;
        rootPath: string;
        disabled: boolean;
        /** Preview turn, in quarter turns to the left (before it's saved). */
        rotation?: number;
        /** No black behind the media (see MediaPlayer). */
        seeThrough?: boolean;
    }
>(({ file, rootPath, disabled, rotation = 0, seeThrough = false }, _ref) => (
    <div className={`relative flex h-full w-full flex-col ${seeThrough ? "" : "bg-black"}`}>
        <MediaPlayer
            file={file}
            rootPath={rootPath}
            muted={false}
            className="h-full w-full"
            disabled={disabled}
            rotation={rotation}
            seeThrough={seeThrough}
        />
    </div>
));
