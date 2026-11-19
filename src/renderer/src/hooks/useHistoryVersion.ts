import { useSyncExternalStore } from "react";

// Bumps each time an undo or redo is applied (from any view), so anything
// that loaded library data refetches it: an undo can change data that no
// event reports (tags, noes, folder rules, tag definitions, feeds…).

let version = 0;
const subscribers = new Set<() => void>();

window.api.onHistoryApplied(() => {
    version++;
    subscribers.forEach((s) => s());
});

function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

/** A number that changes after every undo/redo: add it to the
 *  dependencies of an effect that loads library data. */
export function useHistoryVersion(): number {
    return useSyncExternalStore(subscribe, () => version);
}
