import {
    createContext,
    ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import type { DbFile } from "@renderer/shared/types/types";
import ConfirmDialog from "@renderer/components/ConfirmDialog";
import { useFolders } from "./FolderContext";

/**
 * A change that touches files the user may want to look at first (moving
 * into a folder with noes, a folder tag or no, a batch yes/no, a tag link).
 * It always asks first: Confirm · Cancel · Manage…. Manage docks the change
 * on the right with a live list of the files it touches; files fixed
 * meanwhile drop off. One pending change at a time.
 */

/** One file the change touches, and what happens to it. */
export interface PendingItem {
    fileId: number;
    detail: string;
}

/** A folder rule the change touches, shown in that collection's header. */
export interface PendingFolder {
    /** The folder's path (= its collection). */
    path: string;
    detail: string;
}

/** What the change would do right now (worked out fresh each time). */
export interface PendingState {
    items: PendingItem[];
    folders?: PendingFolder[];
    /** Effects that aren't about one file (a folder rule coming off…). */
    lines?: string[];
    /** Own tags the change would remove in all, for button text. */
    removes?: number;
    /** Own noes the change would clear in all, for button text. */
    clears?: number;
}

export interface PendingAction {
    /** Button text, from what the change would do right now. */
    label: (live: PendingState) => string;
    danger?: boolean;
    /** Not offered right now (e.g. no file would be moved). */
    disabled?: (live: PendingState) => boolean;
    /** Makes the change (one undo step) and refreshes what it affects. */
    run: () => Promise<unknown>;
}

export interface PendingChangeSpec {
    title: string;
    /** The modal's text (at request time). */
    message: ReactNode;
    /** The dock's header, e.g. "Move pending: 6 files → Pets". */
    dockTitle: string;
    /** What the confirm found (the caller already previewed). */
    initial: PendingState;
    /** Works it out again; the dock calls it after every change. */
    load: () => Promise<PendingState>;
    /** Absent for a plain list (Coverage conflicts): nothing to confirm. */
    confirm?: PendingAction;
    secondary?: PendingAction;
    /** Shown when nothing is affected any more. */
    emptyText?: string;
    /** A folder the change is about (a move's target): the dock's header
     *  opens it in Browse, to change its rules instead of each file. */
    headerFolder?: string;
    /** One flat list, each file saying where it is now ("from Beach"),
     *  instead of grouping by collection (a move: they're leaving it). */
    byOrigin?: boolean;
}

interface Current {
    spec: PendingChangeSpec;
    docked: boolean;
    resolve: (ran: boolean) => void;
}

interface PendingChangeValue {
    /** Asks; resolves true once an action ran, false when cancelled. */
    requestChange: (spec: PendingChangeSpec) => Promise<boolean>;
    /** Docks a list straight away (no confirm), replacing any docked list;
     *  a docked change asks to be discarded first. */
    showList: (spec: PendingChangeSpec) => void;
    /** The docked change, if any. */
    docked: Current | null;
    finish: (action: "confirm" | "secondary" | null) => Promise<void>;
    /** A file opened from the dock (shown in place of the view). */
    openFile: DbFile | null;
    setOpenFile: (file: DbFile | null) => void;
}

const PendingChangeContext = createContext<PendingChangeValue | null>(null);

export function PendingChangeProvider({ children }: { children: ReactNode }): JSX.Element {
    const [current, setCurrent] = useState<Current | null>(null);
    // A new change asked for while one is docked: discard that one first?
    const [waiting, setWaiting] = useState<{
        spec: PendingChangeSpec;
        resolve: (ran: boolean) => void;
    } | null>(null);
    const [openFile, setOpenFile] = useState<DbFile | null>(null);
    const [busy, setBusy] = useState(false);
    const currentRef = useRef(current);
    currentRef.current = current;

    const requestChange = useCallback(
        (spec: PendingChangeSpec) =>
            new Promise<boolean>((resolve) => {
                const cur = currentRef.current;
                if (cur?.docked && cur.spec.confirm) setWaiting({ spec, resolve });
                else {
                    cur?.resolve(false);
                    setOpenFile(null);
                    setCurrent({ spec, docked: !spec.confirm, resolve });
                }
            }),
        [],
    );

    const showList = useCallback(
        (spec: PendingChangeSpec) => void requestChange({ ...spec, confirm: undefined }),
        [requestChange],
    );

    const finish = useCallback(async (action: "confirm" | "secondary" | null) => {
        const cur = currentRef.current;
        if (!cur) return;
        if (action) {
            const act = action === "confirm" ? cur.spec.confirm : cur.spec.secondary;
            if (!act) return;
            setBusy(true);
            try {
                await act.run();
            } finally {
                setBusy(false);
            }
        }
        setCurrent(null);
        setOpenFile(null);
        cur.resolve(action !== null);
    }, []);

    // Switching library cancels.
    const { rootPath } = useFolders();
    useEffect(() => {
        void finish(null);
        setWaiting(null);
    }, [rootPath, finish]);

    const modal = current && !current.docked && current.spec.confirm ? current : null;
    const modalConfirm = modal?.spec.confirm;

    return (
        <PendingChangeContext.Provider
            value={{
                requestChange,
                showList,
                docked: current?.docked ? current : null,
                finish,
                openFile,
                setOpenFile,
            }}
        >
            {children}
            {modal && (
                <ConfirmDialog
                    title={modal.spec.title}
                    message={modal.spec.message}
                    confirmText={modalConfirm?.label(modal.spec.initial) ?? ""}
                    danger={modalConfirm?.danger ?? true}
                    onConfirm={() => {
                        if (!busy) void finish("confirm");
                    }}
                    onCancel={() => void finish(null)}
                    secondary={
                        modal.spec.secondary &&
                        !modal.spec.secondary.disabled?.(modal.spec.initial)
                            ? {
                                  text: modal.spec.secondary.label(modal.spec.initial),
                                  danger: modal.spec.secondary.danger,
                                  onClick: () => {
                                      if (!busy) void finish("secondary");
                                  },
                              }
                            : undefined
                    }
                    extra={{
                        text: "Manage…",
                        onClick: () => setCurrent({ ...modal, docked: true }),
                    }}
                />
            )}
            {waiting && (
                <ConfirmDialog
                    title="Discard the pending change?"
                    message={`"${current?.spec.dockTitle ?? "A change"}" is still open in the side panel. Only one change can be pending at a time.`}
                    confirmText="Discard it"
                    onCancel={() => {
                        waiting.resolve(false);
                        setWaiting(null);
                    }}
                    onConfirm={() => {
                        const next = waiting;
                        setWaiting(null);
                        currentRef.current?.resolve(false);
                        setOpenFile(null);
                        setCurrent({
                            spec: next.spec,
                            docked: !next.spec.confirm,
                            resolve: next.resolve,
                        });
                    }}
                />
            )}
        </PendingChangeContext.Provider>
    );
}

export function usePendingChange(): PendingChangeValue {
    const ctx = useContext(PendingChangeContext);
    if (!ctx) throw new Error("usePendingChange must be used inside PendingChangeProvider");
    return ctx;
}
