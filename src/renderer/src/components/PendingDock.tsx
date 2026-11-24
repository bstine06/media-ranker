import { useEffect, useMemo, useState } from "react";
import type { DbFile } from "@renderer/shared/types/types";
import {
    PendingChangeSpec,
    PendingFolder,
    PendingState,
    usePendingChange,
} from "@renderer/contexts/PendingChangeContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import HoverPreview from "@renderer/browse/components/HoverPreview";
import { useHoverPreview } from "@renderer/browse/hooks/useHoverPreview";

/** A file's collection: its top-level folder, or Unsorted. */
const collectionOf = (path: string) => (path.includes("/") ? path.split("/")[0] : "Unsorted");

type Row = { fileId: number; file: DbFile | null; detail: string };

/**
 * The docked pending change (see PendingChangeContext): what it would do
 * right now, recomputed after every change; files that stop being
 * affected drop off. Takes the undo history's place while open.
 */
export function PendingDock({
    onOpenFolder,
}: {
    /** Opens a folder (by path) in Browse. */
    onOpenFolder: (path: string) => void;
}): JSX.Element | null {
    const { docked, finish, setOpenFile } = usePendingChange();
    if (!docked) return null;
    return (
        <DockBody
            key={docked.spec.dockTitle}
            spec={docked.spec}
            finish={finish}
            onOpen={setOpenFile}
            onOpenFolder={onOpenFolder}
        />
    );
}

function DockBody({
    spec,
    finish,
    onOpen,
    onOpenFolder,
}: {
    spec: PendingChangeSpec;
    finish: (action: "confirm" | "secondary" | null) => Promise<void>;
    onOpen: (file: DbFile) => void;
    onOpenFolder: (path: string) => void;
}): JSX.Element {
    const [live, setLive] = useState<PendingState>(spec.initial);
    const [files, setFiles] = useState<Map<number, DbFile>>(new Map());
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState<Set<string>>(new Set());

    useEffect(() => {
        let alive = true;
        const reload = async () => {
            const next = await spec.load();
            if (!alive) return;
            setLive(next);
        };
        void reload();
        // After any change in the app, and when the watcher sees files
        // change outside it (a Finder move can fix or cause a clash).
        let timer: ReturnType<typeof setTimeout> | null = null;
        const soon = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void reload(), 150);
        };
        const offs = [
            window.api.onHistoryChanged(() => void reload()),
            window.api.onMediaAdded(soon),
            window.api.onMediaRemoved(soon),
            window.api.onMediaRenamed(soon),
            window.api.onFolderRenamed(soon),
        ];
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
            offs.forEach((off) => off());
        };
    }, [spec]);

    // The files themselves (paths change when one is moved or renamed).
    useEffect(() => {
        let alive = true;
        const list = live.items.map((i) => i.fileId);
        window.api.getFilesByIds(list).then((got: DbFile[]) => {
            if (alive) setFiles(new Map(got.map((f) => [f.id, f])));
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live]);

    const rows: Row[] = live.items.map((i) => ({
        fileId: i.fileId,
        file: files.get(i.fileId) ?? null,
        detail: i.detail,
    }));
    // Per collection: its files, and what the change does to the folder
    // itself (shown in the collection's header).
    const folderList = live.folders ?? [];
    const groups = useMemo(() => {
        const m = new Map<string, { rows: Row[]; folders: PendingFolder[] }>();
        const at = (key: string) => {
            let g = m.get(key);
            if (!g) m.set(key, (g = { rows: [], folders: [] }));
            return g;
        };
        for (const f of folderList) at(collectionOf(f.path)).folders.push(f);
        for (const r of rows) {
            at(r.file ? collectionOf(r.file.path) : "Not in the library").rows.push(r);
        }
        return [...m].sort((a, b) => a[0].localeCompare(b[0]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        rows.map((r) => `${r.fileId}:${r.file?.path}`).join("|"),
        folderList.map((f) => `${f.path}:${f.detail}`).join("|"),
    ]);

    const run = async (action: "confirm" | "secondary") => {
        if (busy) return;
        setBusy(true);
        try {
            await finish(action);
        } finally {
            setBusy(false);
        }
    };

    const pending = live.items.length;
    const pendingFolders = new Set(folderList.map((f) => f.path)).size;
    const flat = groups.length <= 1;
    const summary = [
        pendingFolders > 0 ? `${pendingFolders} folder${pendingFolders === 1 ? "" : "s"}` : null,
        pending > 0 ? `${pending} file${pending === 1 ? "" : "s"}` : null,
    ]
        .filter(Boolean)
        .join(" and ");

    return (
        <aside className="flex w-72 shrink-0 flex-col border-l border-neutral-800 bg-neutral-900">
            <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 py-1.5 pl-3 pr-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-amber-300/90">
                    {spec.dockTitle}
                </span>
                <button
                    onClick={() => void finish(null)}
                    title={spec.confirm ? "Cancel this change" : "Close"}
                    className="rounded px-1.5 py-0.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                >
                    ✕
                </button>
            </div>

            <div className="flex-1 overflow-y-auto py-1 text-xs">
                {live.lines && live.lines.length > 0 && (
                    <ul className="flex flex-col gap-1 border-b border-neutral-800/70 px-3 py-2 text-neutral-400">
                        {live.lines.map((l) => (
                            <li key={l}>{l}</li>
                        ))}
                    </ul>
                )}
                <p className="px-3 py-2 text-[11px] text-neutral-500">
                    {summary === ""
                        ? spec.emptyText ?? "Nothing clashes any more."
                        : `${summary} affected · click one to open it`}
                </p>
                {groups.map(([name, { rows: list, folders }]) => {
                    const left = list.length;
                    const expanded = flat || open.has(name);
                    const toggle = () =>
                        setOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(name)) next.delete(name);
                            else next.add(name);
                            return next;
                        });
                    return (
                        <div key={name}>
                            {(!flat || folders.length > 0) && (
                                <div
                                    className={
                                        folders.length > 0
                                            ? "border-y border-neutral-800/70 bg-neutral-800/30 py-1"
                                            : ""
                                    }
                                >
                                    {left > 0 && !flat ? (
                                        <button
                                            onClick={toggle}
                                            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-neutral-300 hover:bg-neutral-800/60"
                                        >
                                            <span className="w-3 text-neutral-500">
                                                {expanded ? "▾" : "▸"}
                                            </span>
                                            <span className="truncate">
                                                {left} file{left === 1 ? "" : "s"} in {name}
                                            </span>
                                        </button>
                                    ) : (
                                        <p className="truncate px-3 py-1.5 text-neutral-300">
                                            {left > 0
                                                ? `${left} file${left === 1 ? "" : "s"} in ${name}`
                                                : name}
                                        </p>
                                    )}
                                    {folders.map((f) => (
                                        <button
                                            key={`${f.path}:${f.detail}`}
                                            onClick={() => onOpenFolder(f.path)}
                                            title={`Open "${name}" in Browse`}
                                            className="flex w-full flex-col px-3 py-1 text-left transition-colors hover:bg-neutral-800"
                                        >
                                            <span className="text-[11px] text-neutral-500">
                                                On the folder
                                            </span>
                                            <span className="text-[11px] text-red-300/80">
                                                {f.detail}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {expanded &&
                                list.map((r) => (
                                    <DockRow key={r.fileId} row={r} onOpen={onOpen} />
                                ))}
                        </div>
                    );
                })}
            </div>

            <div className="flex shrink-0 flex-col gap-1.5 border-t border-neutral-800 p-2">
                {spec.confirm && (
                <button
                    disabled={busy}
                    onClick={() => void run("confirm")}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        (spec.confirm.danger ?? true)
                            ? "bg-red-900/60 text-red-200 hover:bg-red-800 hover:text-white"
                            : "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                    }`}
                >
                    {spec.confirm.label(live)}
                </button>
                )}
                {spec.secondary && (
                    <button
                        disabled={busy || spec.secondary.disabled?.(live) === true}
                        onClick={() => void run("secondary")}
                        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                            spec.secondary.danger
                                ? "bg-red-900/60 text-red-200 hover:bg-red-800 hover:text-white"
                                : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
                        }`}
                    >
                        {spec.secondary.label(live)}
                    </button>
                )}
                <button
                    disabled={busy}
                    onClick={() => void finish(null)}
                    className="rounded px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                >
                    {spec.confirm ? "Cancel" : "Close"}
                </button>
            </div>
        </aside>
    );
}

function DockRow({ row, onOpen }: { row: Row; onOpen: (file: DbFile) => void }): JSX.Element {
    const { rootPath } = useFolders();
    const { file } = row;
    const [thumb, setThumb] = useState<string | null>(null);
    const { elementRef, preview, layout, handleMouseEnter, handleMouseLeave, handleNaturalSize } =
        useHoverPreview();

    useEffect(() => {
        if (!file) return;
        window.api.getThumbnailPath(file.content_hash).then((abs) => {
            if (abs) setThumb(toThumbnailUrl(abs));
        });
    }, [file?.content_hash]);

    return (
        <>
            <button
                disabled={!file}
                onClick={() => file && onOpen(file)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-neutral-800 disabled:hover:bg-transparent"
            >
                <div
                    ref={elementRef as React.RefObject<HTMLDivElement>}
                    onMouseEnter={file ? handleMouseEnter : undefined}
                    onMouseLeave={handleMouseLeave}
                    className="h-9 w-9 shrink-0 overflow-hidden rounded bg-neutral-800"
                >
                    {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-neutral-200">
                        {file?.filename ?? "Removed file"}
                    </span>
                    <span className="truncate text-[11px] text-red-300/80">{row.detail}</span>
                </div>
            </button>
            {preview && layout && file && rootPath && (
                <HoverPreview
                    file={file}
                    fullUrl={toMediaUrl(rootPath, file.path, file.content_hash)}
                    x={layout.x}
                    y={layout.y}
                    width={layout.width}
                    height={layout.height}
                    onNaturalSize={handleNaturalSize}
                />
            )}
        </>
    );
}
