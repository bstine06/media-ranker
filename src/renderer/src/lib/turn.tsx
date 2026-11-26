// Drawing a file turned by its rotation setting (DbFile.rotation: quarter
// turns counter-clockwise) where a picture fills a box: thumbnails, hover
// zoom. The player turns itself (MediaPlayer's turnStyle).
//
// A sideways turn swaps the picture's width and height: the element is
// sized to the box the other way round (container units: the box is a size
// container) and turned about its centre, so it covers / fits the box just
// as an unturned one would.

import { forwardRef, type CSSProperties, type ImgHTMLAttributes } from "react";
import type { DbFile } from "@renderer/shared/types/types";

export const isSideways = (rotation: number): boolean => rotation % 2 !== 0;

/** A file's shape (width / height) as it's drawn: a sideways turn flips it. */
export function turnedAspect(file: Pick<DbFile, "rotation">, aspect: number): number {
    return isSideways(file.rotation ?? 0) ? 1 / aspect : aspect;
}

/** Natural size as drawn (swapped for a sideways turn). */
export function turnedSize(rotation: number, w: number, h: number): [number, number] {
    return isSideways(rotation) ? [h, w] : [w, h];
}

/** On the box a turned picture fills: it must have a definite size. */
export const TURN_BOX: CSSProperties = { position: "relative", overflow: "hidden", containerType: "size" };

/** On the picture (img / video) inside a TURN_BOX. */
export function turnedFill(rotation: number, fit: "cover" | "contain" = "cover"): CSSProperties {
    const side = isSideways(rotation);
    return {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: side ? "100cqh" : "100%",
        height: side ? "100cqw" : "100%",
        maxWidth: "none",
        maxHeight: "none",
        objectFit: fit,
        display: "block",
        transform: `translate(-50%, -50%) rotate(${-90 * rotation}deg)`,
    };
}

/**
 * An <img> drawn turned. Unturned it's the plain <img> with `className`, as
 * before. Turned, a box takes `className` (its size) and the picture turns
 * inside it; `object-contain` in `className` picks contain, else cover.
 */
export const TurnedImg = forwardRef<
    HTMLImageElement,
    ImgHTMLAttributes<HTMLImageElement> & { rotation: number }
>(function TurnedImg({ rotation, className, style, ...img }, ref) {
    if (!rotation) return <img ref={ref} className={className} style={style} {...img} />;
    const fit = className?.includes("object-contain") ? "contain" : "cover";
    return (
        <span className={className} style={{ ...TURN_BOX, display: "block", ...style }}>
            <img ref={ref} style={turnedFill(rotation, fit)} {...img} />
        </span>
    );
});
