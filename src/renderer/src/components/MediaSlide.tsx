import React from "react";
import { DbFile } from "@renderer/shared/types/types";
import { MediaPlayer } from "./MediaPlayer";
import { PlayState } from "@renderer/lib/inspect";

export const MediaSlide = React.forwardRef<
    HTMLVideoElement,
    {
        file: DbFile;
        rootPath: string;
        disabled: boolean;
        /** Preview turn, in quarter turns to the left (before it's saved). */
        rotation?: number;
        /** A video picks up here instead of from the top (see MediaPlayer). */
        startAt?: PlayState | null;
        /** There's something to show (see MediaPlayer). */
        onReady?: () => void;
        /** No black behind the media (see MediaPlayer). */
        seeThrough?: boolean;
    }
>(({ file, rootPath, disabled, rotation = 0, startAt, onReady, seeThrough = false }, _ref) => (
    <div className={`relative flex h-full w-full flex-col ${seeThrough ? "" : "bg-black"}`}>
        <MediaPlayer
            file={file}
            rootPath={rootPath}
            muted={false}
            className="h-full w-full"
            disabled={disabled}
            rotation={rotation}
            startAt={startAt}
            onReady={onReady}
            seeThrough={seeThrough}
        />
    </div>
));
