import { useCallback, useEffect, useRef, useState } from "react";
import { DbFile } from "@renderer/shared/types/types";
import { useSettings } from "@renderer/contexts/SettingsContext";

export type SlotResolver = (dir: "up" | "down", cursor: number) => Promise<DbFile | null>;

export interface ScrollSlotsState {
    slotFiles: [DbFile | null, DbFile | null];
    slotTransforms: [string, string];
    slotTransitions: [string, string];
    frontSlot: 0 | 1;
    videoRef0: React.RefObject<HTMLVideoElement>;
    videoRef1: React.RefObject<HTMLVideoElement>;
    currentFile: DbFile | null;
    cursor: number;
    setCursor: (i: number) => void;
    handleWheel: (e: React.WheelEvent) => void;
    navigate: (dir: "up" | "down") => void;
    /** Swap in a fresh record for a file already showing (e.g. after a rotate). */
    replaceFile: (file: DbFile) => void;
}

function computeSlope(history: { delta: number; time: number }[]): number {
    const n = history.length;
    if (n < 2) return 0;
    const meanX = history.reduce((s, p) => s + p.time, 0) / n;
    const meanY = history.reduce((s, p) => s + p.delta, 0) / n;
    const num = history.reduce((s, p) => s + (p.time - meanX) * (p.delta - meanY), 0);
    const den = history.reduce((s, p) => s + (p.time - meanX) ** 2, 0);
    return den === 0 ? 0 : num / den;
}

export function useScrollSlots({
    initialFile,
    resolver,
    active,
}: {
    initialFile: DbFile | null;
    resolver: SlotResolver;
    active: boolean;
}): ScrollSlotsState {
    const { scrollTime } = useSettings();
    const scrollTimeRef = useRef(scrollTime);
    useEffect(() => { scrollTimeRef.current = scrollTime; }, [scrollTime]);

    const lockedRef = useRef(false);
    const [cursor, setCursor] = useState(0);
    const [frontSlot, setFrontSlot] = useState<0 | 1>(0);
    const [slotFiles, setSlotFiles] = useState<[DbFile | null, DbFile | null]>(
        [initialFile, null]
    );
    const [slotTransforms, setSlotTransforms] = useState<[string, string]>(
        ["translateY(0)", "translateY(100%)"]
    );
    const [slotTransitions, setSlotTransitions] = useState<[string, string]>(
        ["none", "none"]
    );

    const videoRef0 = useRef<HTMLVideoElement>(null);
    const videoRef1 = useRef<HTMLVideoElement>(null);
    const videoRefs = [videoRef0, videoRef1];

    const navigate = useCallback(async (dir: "up" | "down") => {
        if (lockedRef.current) return;

        lockedRef.current = true;
        videoRefs[frontSlot].current?.pause();

        const incoming = await resolver(dir, cursor);
        if (!incoming) {
            lockedRef.current = false;
            return;
        }

        const backSlot = frontSlot === 0 ? 1 : 0;
        const offScreenY = dir === "down" ? "translateY(100%)" : "translateY(-100%)";
        const exitY = dir === "down" ? "translateY(-100%)" : "translateY(100%)";

        setSlotFiles((prev) => {
            const next = [...prev] as [DbFile | null, DbFile | null];
            next[backSlot] = incoming;
            return next;
        });
        setSlotTransitions(["none", "none"]);
        setSlotTransforms((prev) => {
            const next = [...prev] as [string, string];
            next[backSlot] = offScreenY;
            return next;
        });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setSlotTransitions([
                    `transform ${scrollTimeRef.current}ms cubic-bezier(0.4,0,0.2,1)`,
                    `transform ${scrollTimeRef.current}ms cubic-bezier(0.4,0,0.2,1)`,
                ]);
                setSlotTransforms((prev) => {
                    const next = [...prev] as [string, string];
                    next[frontSlot] = exitY;
                    next[backSlot] = "translateY(0)";
                    return next;
                });
                setTimeout(() => {
                    setFrontSlot(backSlot as 0 | 1);
                    setSlotTransitions(["none", "none"]);
                    videoRefs[backSlot].current?.play();
                    lockedRef.current = false;
                    setCursor((c) => dir === "down" ? c + 1 : c - 1);
                }, scrollTimeRef.current + 20);
            });
        });
    }, [frontSlot, resolver]);

    // Keyboard
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") navigate("down");
            if (e.key === "ArrowUp") navigate("up");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, navigate]);

    // Play/pause on active
    useEffect(() => {
        if (active) videoRefs.forEach((r) => r.current?.play());
        else videoRefs.forEach((r) => r.current?.pause());
    }, [active]);

    // Wheel
    const wheelLatchRef = useRef(false);
    const wheelCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wheelHistoryRef = useRef<{ delta: number; time: number }[]>([]);
    // While latched: the biggest delta seen since the last fire, and whether
    // deltas have since dropped off (momentum decaying). Only a swipe that
    // ramps up *after* that drop counts as a new swipe.
    const wheelPeakRef = useRef(0);
    const wheelArmedRef = useRef(false);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        const absDelta = Math.abs(e.deltaY);
        if (absDelta < 10) return;
        // Keep the gesture alive even while a slide is animating; otherwise
        // the cooldown expires mid-animation and leftover momentum after it
        // can fire a second scroll.
        if (wheelCooldownRef.current) clearTimeout(wheelCooldownRef.current);
        wheelCooldownRef.current = setTimeout(() => {
            wheelLatchRef.current = false;
            wheelHistoryRef.current = [];
        }, 60);

        const now = performance.now();
        wheelHistoryRef.current.push({ delta: absDelta, time: now });
        wheelHistoryRef.current = wheelHistoryRef.current.filter((p) => now - p.time < 120);

        const fire = () => {
            wheelLatchRef.current = true;
            wheelPeakRef.current = absDelta;
            wheelArmedRef.current = false;
            wheelHistoryRef.current = [];
        };

        if (wheelLatchRef.current) {
            // Momentum from the last swipe (or a new swipe on top of it).
            wheelPeakRef.current = Math.max(wheelPeakRef.current, absDelta);
            if (absDelta < wheelPeakRef.current * 0.7) wheelArmedRef.current = true;
            if (lockedRef.current || !wheelArmedRef.current) return;
            if (wheelHistoryRef.current.length < 3) return;
            if (computeSlope(wheelHistoryRef.current) < 0.5) return;
            // Deltas dropped off and are now ramping up again: new swipe.
            fire();
            navigate(e.deltaY > 0 ? "down" : "up");
            return;
        }

        if (lockedRef.current) {
            // A swipe that starts mid-animation is consumed, not queued.
            fire();
            return;
        }
        if (computeSlope(wheelHistoryRef.current) < 0.5) return;
        fire();
        navigate(e.deltaY > 0 ? "down" : "up");
    }, [navigate]);

    const replaceFile = useCallback((file: DbFile) => {
        setSlotFiles((prev) => [
            prev[0]?.id === file.id ? file : prev[0],
            prev[1]?.id === file.id ? file : prev[1],
        ]);
    }, []);

    return {
        replaceFile,
        slotFiles,
        slotTransforms,
        slotTransitions,
        frontSlot,
        videoRef0,
        videoRef1,
        currentFile: slotFiles[frontSlot],
        cursor,
        setCursor,
        handleWheel,
        navigate,
    };
}