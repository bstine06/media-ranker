// main/formats.ts
// Every file format the library tracks, in one place. The scanner, watcher,
// media:// protocol, thumbnailer and rotation all read from this table.

export type MediaType = "photo" | "gif" | "video";

interface Format {
    mediaType: MediaType;
    mime: string;
    // false: Chromium can't show it, so the media:// handler serves a JPEG
    // copy instead (see displayCopy.ts).
    browserNative: boolean;
}

const photo = (mime: string, browserNative = true): Format => ({
    mediaType: "photo",
    mime,
    browserNative,
});
const video = (mime: string): Format => ({
    mediaType: "video",
    mime,
    browserNative: true,
});

const FORMATS: Record<string, Format> = {
    ".jpg": photo("image/jpeg"),
    ".jpeg": photo("image/jpeg"),
    ".jpe": photo("image/jpeg"),
    ".jfif": photo("image/jpeg"),
    ".png": photo("image/png"),
    ".apng": photo("image/apng"),
    ".webp": photo("image/webp"),
    ".avif": photo("image/avif"),
    ".bmp": photo("image/bmp"),
    ".svg": photo("image/svg+xml"),
    ".heic": photo("image/heic", false),
    ".heif": photo("image/heif", false),
    ".tif": photo("image/tiff", false),
    ".tiff": photo("image/tiff", false),

    ".gif": { mediaType: "gif", mime: "image/gif", browserNative: true },

    ".mp4": video("video/mp4"),
    ".m4v": video("video/mp4"),
    ".mov": video("video/quicktime"),
    ".qt": video("video/quicktime"),
    ".webm": video("video/webm"),
    ".ogv": video("video/ogg"),
    ".3gp": video("video/3gpp"),
};

function lookup(ext: string): Format | undefined {
    return FORMATS[ext.toLowerCase()];
}

export function getMediaType(ext: string): MediaType | null {
    return lookup(ext)?.mediaType ?? null;
}

export function getMimeType(ext: string): string {
    return lookup(ext)?.mime ?? "application/octet-stream";
}

export function isBrowserNative(ext: string): boolean {
    return lookup(ext)?.browserNative ?? true;
}

// For file pickers: extensions without the dot.
export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS).map((e) => e.slice(1));
