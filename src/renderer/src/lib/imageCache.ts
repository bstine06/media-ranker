// Shared image preloader. Holds on to the last few decoded images so a view
// that's about to show one (e.g. Compare's next pair) can display it at once,
// and lets MediaPlayer skip its blurred-thumbnail stage for those.

const MAX_HELD = 12;

// Insertion-ordered, so the first key is the oldest.
const held = new Map<string, HTMLImageElement>();
const ready = new Set<string>();

function hold(url: string, img: HTMLImageElement): void {
    held.delete(url);
    held.set(url, img);
    while (held.size > MAX_HELD) {
        const oldest = held.keys().next().value as string;
        held.delete(oldest);
        ready.delete(oldest);
    }
}

export function preloadImage(url: string): Promise<void> {
    const existing = held.get(url);
    if (existing) {
        hold(url, existing); // refresh its spot
        return existing.decode().catch(() => {});
    }
    const img = new Image();
    img.src = url;
    hold(url, img);
    return img
        .decode()
        .then(() => {
            if (held.get(url) === img) ready.add(url);
        })
        .catch(() => {});
}

/** True once the image is downloaded and decoded, so it can be shown instantly. */
export function isImageReady(url: string): boolean {
    return ready.has(url);
}
