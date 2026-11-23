/**
 * While something has its own undo (the filter builder's draft), ⌘Z and
 * ⇧⌘Z go to it instead of the app's history. One at a time.
 *
 * The handler returns "done" (it stepped), "empty" (nothing to step: the
 * toast says so) or "pass" (let the focused text box undo its typing).
 */
export type UndoResult = "done" | "empty" | "pass";
type Handler = (action: "undo" | "redo") => UndoResult;

let handler: Handler | null = null;

export function setUndoOverride(h: Handler): () => void {
    handler = h;
    return () => {
        if (handler === h) handler = null;
    };
}

export function undoOverride(): Handler | null {
    return handler;
}
