// Hold 4: the focused video plays faster (the factor is a setting), in every
// view. Kept here, app-wide, so moving to another file while 4 is still held
// carries it over (the newly focused player reads it). Letting go, or the
// window losing focus, goes back to normal speed.

import { isTyping } from "./keys";

type Listener = (held: boolean) => void;
const listeners = new Set<Listener>();
let held = false;
let installed = false;

function set(next: boolean): void {
    if (held === next) return;
    held = next;
    listeners.forEach((l) => l(held));
}

function install(): void {
    if (installed) return;
    installed = true;
    window.addEventListener("keydown", (e) => {
        if (e.code !== "Digit4" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
        if (document.querySelector("[data-modal]")) return;
        set(true);
    });
    window.addEventListener("keyup", (e) => {
        if (e.code === "Digit4") set(false);
    });
    window.addEventListener("blur", () => set(false));
}

/** Whether 4 is held now, and a subscription to changes. */
export function fastForwardHeld(): boolean {
    install();
    return held;
}
export function onFastForward(l: Listener): () => void {
    install();
    listeners.add(l);
    return () => void listeners.delete(l);
}
