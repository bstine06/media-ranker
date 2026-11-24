import { useSyncExternalStore } from "react";

// Bumps each time an undo or redo is applied (from any view), so anything
// that loaded library data refetches it: an undo can change data that no
// event reports (tags, noes, folder rules, tag definitions, feeds…).

let version = 0;
const subscribers = new Set<() => void>();

window.api.onHistoryApplied((a) => {
    // The filter and the selection aren't library data: nothing to refetch.
    if (a.meta?.kind === "filter" || a.meta?.kind === "selection") return;
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

// Bumps on every undo/redo AND every new change, wherever it was made. For
// views that stay mounted while hidden and show rules another view can
// change (Browse's folder panel after a tag link made in Tag Manager).
let dataVersion = 0;
const dataSubscribers = new Set<() => void>();
const bumpData = () => {
    dataVersion++;
    dataSubscribers.forEach((s) => s());
};
subscribe(bumpData);
window.api.onLibraryChanged(bumpData);

export function useDataVersion(): number {
    return useSyncExternalStore(
        (fn) => {
            dataSubscribers.add(fn);
            return () => dataSubscribers.delete(fn);
        },
        () => dataVersion,
    );
}
