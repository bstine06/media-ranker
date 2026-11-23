import { useEffect, useRef, useState } from "react";

/**
 * A panel resized by dragging one of its edges (the sidebar's right edge,
 * the file view's tag panel's left edge). While dragging the width is kept
 * here; it's handed to `save` once, on release, so the saved setting isn't
 * written (and everything reading settings redrawn) on every mouse move.
 */
export function useEdgeResize({
    width,
    save,
    min,
    max,
    edge,
}: {
    width: number;
    save: (px: number) => void;
    min: number;
    max: number;
    /** Which of the panel's edges the handle is on. */
    edge: "left" | "right";
}): { width: number; dragging: boolean; onMouseDown: (e: React.MouseEvent) => void } {
    const [live, setLive] = useState<number | null>(null);
    const start = useRef<{ x: number; width: number } | null>(null);
    const latest = useRef(width);

    useEffect(() => {
        if (live === null) return;
        const clamp = (px: number) => Math.max(min, Math.min(max, Math.round(px)));
        const onMove = (e: MouseEvent) => {
            const s = start.current;
            if (!s) return;
            const dx = e.clientX - s.x;
            const next = clamp(edge === "right" ? s.width + dx : s.width - dx);
            latest.current = next;
            setLive(next);
        };
        const onUp = () => {
            start.current = null;
            save(latest.current);
            setLive(null);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        // Only (re)attach when a drag starts or ends.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live === null]);

    return {
        width: live ?? width,
        dragging: live !== null,
        onMouseDown: (e) => {
            e.preventDefault();
            start.current = { x: e.clientX, width };
            latest.current = width;
            setLive(width);
        },
    };
}
