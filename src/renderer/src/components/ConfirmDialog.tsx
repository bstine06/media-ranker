import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Centered confirm over the whole window, styled like the Settings modal.
 * Esc or clicking outside cancels; Cancel has focus so Enter is safe.
 * `danger` (the default) colors the confirm button red; turn it off for
 * actions that aren't destructive, like merging. `secondary` adds a second
 * choice between Cancel and the confirm button. `extra` adds a quiet
 * button on the left (Manage… on confirms that list files).
 */
function ConfirmDialog({
    title,
    message,
    confirmText,
    onConfirm,
    onCancel,
    danger = true,
    secondary,
    extra,
}: {
    title: string;
    message: ReactNode;
    confirmText: string;
    onConfirm: () => void;
    onCancel?: () => void;
    danger?: boolean;
    secondary?: { text: string; onClick: () => void; danger?: boolean };
    extra?: { text: string; onClick: () => void };
}): JSX.Element {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        (cancelRef.current ?? confirmRef.current)?.focus();
    }, []);

    // Keys belong to the dialog while it's open, so Esc here doesn't also
    // clear a Browse selection or close the Settings modal underneath.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Escape") {
                e.preventDefault();
                onCancel?.();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onCancel]);

    return createPortal(
        <div
            data-modal
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onCancel?.();
            }}
        >
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
                className="w-[24rem] max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-2xl"
            >
                <h2
                    id="confirm-dialog-title"
                    className="text-sm font-semibold text-neutral-200"
                >
                    {title}
                </h2>
                <div className="mt-2 text-xs leading-relaxed text-neutral-400">
                    {message}
                </div>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    {extra && (
                        <button
                            onClick={extra.onClick}
                            className="mr-auto rounded px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 transition-colors"
                        >
                            {extra.text}
                        </button>
                    )}
                    {onCancel && (
                        <button
                            ref={cancelRef}
                            onClick={onCancel}
                            className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 transition-colors"
                        >
                            Cancel
                        </button>
                    )}
                    {secondary && (
                        <button
                            onClick={secondary.onClick}
                            className={`rounded px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-1 transition-colors ${
                                secondary.danger
                                    ? "bg-red-900/60 text-red-200 hover:bg-red-800 hover:text-white focus-visible:ring-red-500"
                                    : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600 focus-visible:ring-neutral-400"
                            }`}
                        >
                            {secondary.text}
                        </button>
                    )}
                    <button
                        ref={confirmRef}
                        onClick={onConfirm}
                        className={`rounded px-3 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-1 transition-colors ${
                            danger
                                ? "bg-red-900/60 text-red-200 hover:bg-red-800 hover:text-white focus-visible:ring-red-500"
                                : "bg-neutral-200 text-neutral-900 hover:bg-neutral-400 focus-visible:ring-neutral-400"
                        }`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

export default ConfirmDialog;
