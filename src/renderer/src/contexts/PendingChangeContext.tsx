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
    // A second change that asks first, while one is docked: it gets its own
    // confirm (no Manage: the side panel is taken). The docked one stays,
    // and its list refreshes if this one fixes some of its files.
    const [second, setSecond] = useState<{
        spec: PendingChangeSpec;
        resolve: (ran: boolean) => void;
    } | null>(null);
    // A list for the side panel (Coverage's conflicts) while a change is
    // docked: the panel holds one thing, so ask before replacing it.
    const [replacing, setReplacing] = useState<{
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
                if (cur?.docked && cur.spec.confirm && spec.confirm) setSecond({ spec, resolve });
                else if (cur?.docked && cur.spec.confirm) setReplacing({ spec, resolve });
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
        setSecond((w) => {
            w?.resolve(false);
            return null;
        });
        setReplacing((w) => {
            w?.resolve(false);
            return null;
        });
    }, [rootPath, finish]);

    const finishSecond = useCallback(
        async (action: "confirm" | "secondary" | null) => {
            const w = second;
            if (!w) return;
            if (action) {
                const act = action === "confirm" ? w.spec.confirm : w.spec.secondary;
                if (!act) return;
                setBusy(true);
                try {
                    await act.run();
                } finally {
                    setBusy(false);
                }
            }
            setSecond(null);
            w.resolve(action !== null);
        },
        [second],
    );

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
            {replacing && (
                <ConfirmDialog
                    title={`Show "${replacing.spec.dockTitle ?? replacing.spec.title}"?`}
                    message={`The side panel shows one thing at a time. "${current?.spec.dockTitle ?? "A change"}" is open there and hasn't been confirmed: showing this drops it (nothing changes).`}
                    confirmText="Drop it and show this"
                    danger={false}
                    onCancel={() => {
                        replacing.resolve(false);
                        setReplacing(null);
                    }}
                    onConfirm={() => {
                        const next = replacing;
                        setReplacing(null);
                        currentRef.current?.resolve(false);
                        setOpenFile(null);
                        setCurrent({ spec: next.spec, docked: true, resolve: next.resolve });
                    }}
                />
            )}
            {second && (
                <ConfirmDialog
                    title={second.spec.title}
                    message={second.spec.message}
                    confirmText={second.spec.confirm?.label(second.spec.initial) ?? ""}
                    danger={second.spec.confirm?.danger ?? true}
                    onConfirm={() => {
                        if (!busy) void finishSecond("confirm");
                    }}
                    onCancel={() => void finishSecond(null)}
                    secondary={
                        second.spec.secondary &&
                        !second.spec.secondary.disabled?.(second.spec.initial)
                            ? {
                                  text: second.spec.secondary.label(second.spec.initial),
                                  danger: second.spec.secondary.danger,
                                  onClick: () => {
                                      if (!busy) void finishSecond("secondary");
                                  },
                              }
                            : undefined
                    }
                    extra={{
                        text: "Manage…",
                        onClick: () => {},
                        disabledReason:
                            "Conflicts can't be managed here while another change is being managed in the side panel.",
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
