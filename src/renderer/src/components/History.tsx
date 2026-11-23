import { useEffect, useRef, useState } from "react";
import { undoOverride } from "@renderer/lib/undoOverride";
import type { HistoryItem } from "../shared/types/types";
import { useSettings } from "../contexts/SettingsContext";

// ── App-wide undo (see main/undo.ts) ────────────────────────────────────────

function isEditable(el: Element | null): boolean {
    if (!el) return false;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "range", "button", "submit", "color", "file"].includes(type);
}

/**
 * ⌘Z / ⇧⌘Z (Edit ▸ Undo / Redo): in a text field they undo typing;
 * anywhere else they step the app's history. Each step shows a short toast
 * naming what was undone or redone; nothing navigates.
 */
export function UndoToast(): JSX.Element | null {
    const [toast, setToast] = useState<{ text: string; error: boolean; key: number } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = (text: string, error = false) => {
        if (timer.current) clearTimeout(timer.current);
        // Rapid presses update one toast rather than stacking.
        setToast((t) => ({ text, error, key: (t?.key ?? 0) + 1 }));
        timer.current = setTimeout(() => setToast(null), error ? 5000 : 2200);
    };

    useEffect(() => {
        const offKey = window.api.onHistoryKey(async (action) => {
            // Something with its own undo is open (the filter builder):
            // the app's history is off limits meanwhile.
            const own = undoOverride();
            if (own) {
                const res = own(action);
                if (res === "pass") document.execCommand(action);
                else if (res === "empty") show(action === "undo" ? "Nothing to undo" : "Nothing to redo");
                return;
            }
            if (isEditable(document.activeElement)) {
                document.execCommand(action);
                return;
            }
            const res =
                action === "undo" ? await window.api.historyUndo() : await window.api.historyRedo();
            if (!res) show(action === "undo" ? "Nothing to undo" : "Nothing to redo");
        });
        const offApplied = window.api.onHistoryApplied((applied) => {
            const verb = applied.direction === "undo" ? "Undid" : "Redid";
            if (applied.error) {
                show(
                    `Couldn't ${applied.direction}: ${applied.label}. ${applied.error}` +
                        (applied.direction === "undo" ? " Older steps can't be undone." : ""),
                    true,
                );
            } else {
                show(`${verb}: ${applied.label}`);
            }
        });
        return () => {
            offKey();
            offApplied();
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);

    if (!toast) return null;
    return (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
            <div
                key={toast.key}
                className={`max-w-xl truncate rounded-full border px-4 py-1.5 text-xs shadow-lg ${
                    toast.error
                        ? "border-red-900 bg-red-950/95 text-red-200"
                        : "border-neutral-700 bg-neutral-900/95 text-neutral-200"
                }`}
            >
                {toast.text}
            </div>
        </div>
    );
}

/**
 * The undo history, docked on the right while "Show undo history" is on.
 * A read-only log: newest first under the "now" line; undone steps (which
 * ⇧⌘Z can redo) dimmed above it. × turns the setting off.
 */
export function HistoryDrawer(): JSX.Element | null {
    const { showHistory, toggleShowHistory } = useSettings();
    const [items, setItems] = useState<HistoryItem[]>([]);

    useEffect(() => {
        let live = true;
        window.api.historyList().then((list) => {
            if (live) setItems(list);
        });
        const off = window.api.onHistoryChanged(setItems);
        return () => {
            live = false;
            off();
        };
    }, []);

    if (!showHistory) return null;

    // From main: done steps oldest → newest, then undone ones next-to-redo
    // first. Shown top to bottom: furthest redo … next redo, now, newest …
    const done = items.filter((i) => !i.undone).reverse();
    const redoable = items.filter((i) => i.undone).reverse();

    return (
        <aside className="flex w-64 shrink-0 flex-col border-l border-neutral-800 bg-neutral-900">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-800 pl-3 pr-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    History
                </span>
                <button
                    onClick={toggleShowHistory}
                    title="Hide history (turn back on in Settings)"
                    className="rounded px-1.5 py-0.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                >
                    ✕
                </button>
            </div>
            <div className="flex-1 overflow-y-auto py-1 text-xs">
                {redoable.map((i) => (
                    <div key={i.id} className="border-b border-neutral-800/70 px-3 py-1.5 text-neutral-600" title={i.label}>
                        <span className="line-clamp-2 break-words">{i.label}</span>
                    </div>
                ))}
                <div className="flex items-center gap-2 px-3 py-1">
                    <div className="h-px flex-1 bg-sky-500/60" />
                    <span className="text-[10px] uppercase tracking-wide text-sky-400/80">Now</span>
                    <div className="h-px flex-1 bg-sky-500/60" />
                </div>
                {done.map((i) => (
                    <div key={i.id} className="border-b border-neutral-800/70 px-3 py-1.5 text-neutral-300" title={i.label}>
                        <span className="line-clamp-2 break-words">{i.label}</span>
                    </div>
                ))}
                {items.length === 0 && (
                    <p className="px-3 py-2 text-neutral-600">
                        Changes made this session show up here.
                    </p>
                )}
            </div>
            <div className="shrink-0 border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
                ⌘Z undo · ⇧⌘Z redo · kept until the app quits
            </div>
        </aside>
    );
}
