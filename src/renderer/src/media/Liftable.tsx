import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLiftAbove } from "./MediaLayer";

// A view's pieces that sit on its media (Compare's card top, Pass's no-ring
// and pointer) normally live in the view. While a file view is up over the
// view, a player flies past them, floating above the app; so meanwhile they
// are drawn in the media layer's lift box instead, laid exactly over the same
// place, at the given opacity (they fade out as the view dims and back in on
// the way home). The real pieces move (a portal), no copy.

/** Lifted while `fade` is set, else in place. */
export function Liftable({
    over,
    fade,
    children,
}: {
    /** The element the pieces are laid out in (lifted: drawn over it). */
    over: RefObject<HTMLElement>;
    fade: { opacity: number; ms: number } | null;
    children: ReactNode;
}): JSX.Element {
    const lift = useLiftAbove();
    if (!fade || !lift) return <>{children}</>;
    return createPortal(
        <LiftedOver over={over} fade={fade}>
            {children}
        </LiftedOver>,
        lift,
    );
}

/** Pieces drawn in the lift box, laid exactly over `over`; never take the
 *  mouse (a file view is up). */
function LiftedOver({
    over,
    fade,
    children,
}: {
    over: RefObject<HTMLElement>;
    fade: { opacity: number; ms: number };
    children: ReactNode;
}): JSX.Element {
    const [r, setR] = useState<DOMRect | null>(() => over.current?.getBoundingClientRect() ?? null);
    useLayoutEffect(() => {
        const el = over.current;
        if (!el) return;
        const measure = () => setR(el.getBoundingClientRect());
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        window.addEventListener("resize", measure);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [over]);
    return (
        <div
            className="pointer-events-none fixed overflow-hidden [&_*]:!pointer-events-none"
            style={{
                left: r?.left ?? 0,
                top: r?.top ?? 0,
                width: r?.width ?? 0,
                height: r?.height ?? 0,
                opacity: fade.opacity,
                transition: `opacity ${fade.ms}ms ease-out`,
            }}
        >
            {children}
        </div>
    );
}

