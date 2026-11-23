import { useEffect, useMemo, useState } from "react";
import type { DbFile } from "@renderer/shared/types/types";
import {
    PendingChangeSpec,
    PendingItem,
    PendingState,
    usePendingChange,
} from "@renderer/contexts/PendingChangeContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { toMediaUrl, toThumbnailUrl } from "@renderer/lib/media";
import HoverPreview from "@renderer/browse/components/HoverPreview";
import { useHoverPreview } from "@renderer/browse/hooks/useHoverPreview";

/** A file's collection: its top-level folder, or Unsorted. */
const collectionOf = (path: string) => (path.includes("/") ? path.split("/")[0] : "Unsorted");

type Row = { fileId: number; file: DbFile | null; detail: string; resolved: boolean };

/**
 * The docked pending change (see PendingChangeContext): what it would do
 * right now, recomputed after every change. Files that stop being affected
 * stay listed as resolved. Takes the undo history's place while open.
 */
export function PendingDock(): JSX.Element | null {
    const { docked, finish, setOpenFile } = usePendingChange();
    if (!docked) return null;
    return (
        <DockBody
            key={docked.spec.dockTitle}
            spec={docked.spec}
            finish={finish}
            onOpen={setOpenFile}
        />
    );
}

function DockBody({
    spec,
    finish,
    onOpen,
}: {
    spec: PendingChangeSpec;
    finish: (action: "confirm" | "secondary" | null) => Promise<void>;
    onOpen: (file: DbFile) => void;
}): JSX.Element {
    const [live, setLive] = useState<PendingState>(spec.initial);
    // Every file listed so far, in first-seen order, with its last detail
    // (kept for resolved ones).
    const [seen, setSeen] = useState<PendingItem[]>(spec.initial.items);
    const [files, setFiles] = useState<Map<number, DbFile>>(new Map());
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState<Set<string>>(new Set());

    useEffect(() => {
        let alive = true;
        const reload = async () => {
            const next = await spec.load();
            if (!alive) return;
            setLive(next);
            setSeen((prev) => {
                const byId = new Map(next.items.map((i) => [i.fileId, i]));
                const kept = prev.map((p) => byId.get(p.fileId) ?? p);
                const known = new Set(prev.map((p) => p.fileId));
                return [...kept, ...next.items.filter((i) => !known.has(i.fileId))];
            });
        };
        void reload();
        const off = window.api.onHistoryChanged(() => void reload());
        return () => {
            alive = false;
            off();
        };
    }, [spec]);

    // The files themselves (paths change when one is moved or renamed).
    const ids = seen.map((s) => s.fileId).join(",");
    useEffect(() => {
        let alive = true;
        const list = seen.map((s) => s.fileId);
        window.api.getFilesByIds(list).then((got: DbFile[]) => {
            if (alive) setFiles(new Map(got.map((f) => [f.id, f])));
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ids, live]);

    const liveIds = useMemo(() => new Set(live.items.map((i) => i.fileId)), [live]);
    const rows: Row[] = seen.map((s) => ({
        fileId: s.fileId,
        file: files.get(s.fileId) ?? null,
        detail: s.detail,
        resolved: !liveIds.has(s.fileId),
    }));
    const groups = useMemo(() => {
        const m = new Map<string, Row[]>();
        for (const r of rows) {
            const key = r.file ? collectionOf(r.file.path) : "Not in the library";
            m.set(key, [...(m.get(key) ?? []), r]);
        }
        return [...m].sort((a, b) => a[0].localeCompare(b[0]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.map((r) => `${r.fileId}:${r.file?.path}:${r.resolved}`).join("|")]);

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
    const resolvedCount = rows.filter((r) => r.resolved).length;
    const flat = groups.length <= 1;

    return (
        <aside className="flex w-72 shrink-0 flex-col border-l border-neutral-800 bg-neutral-900">
            <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 py-1.5 pl-3 pr-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-amber-300/90">
                    {spec.dockTitle}
                </span>
                <button
                    onClick={() => void finish(null)}
                    title="Cancel this change"
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
                    {pending === 0
                        ? "Nothing clashes any more."
                        : `${pending} file${pending === 1 ? "" : "s"} affected`}
                    {resolvedCount > 0 && ` · ${resolvedCount} resolved`}
                    {pending > 0 && " · click one to open it"}
                </p>
                {groups.map(([name, list]) => {
                    const left = list.filter((r) => !r.resolved).length;
                    const expanded = flat || open.has(name);
                    return (
                        <div key={name}>
                            {!flat && (
                                <button
                                    onClick={() =>
                                        setOpen((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(name)) next.delete(name);
                                            else next.add(name);
                                            return next;
                                        })
                                    }
                                    className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-neutral-300 hover:bg-neutral-800/60"
                                >
                                    <span className="w-3 text-neutral-500">{expanded ? "▾" : "▸"}</span>
                                    <span className="truncate">
                                        {left} file{left === 1 ? "" : "s"} in {name}
                                    </span>
                                    {list.length > left && (
                                        <span className="ml-auto shrink-0 text-[10px] text-emerald-400/70">
                                            {list.length - left} resolved
                                        </span>
                                    )}
                                </button>
                            )}
                            {expanded &&
                                list.map((r) => <DockRow key={r.fileId} row={r} onOpen={onOpen} />)}
                        </div>
                    );
                })}
            </div>

            <div className="flex shrink-0 flex-col gap-1.5 border-t border-neutral-800 p-2">
                <button
                    disabled={busy}
                    onClick={() => void run("confirm")}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        spec.confirm.danger ?? true
                            ? "bg-red-900/60 text-red-200 hover:bg-red-800 hover:text-white"
                            : "bg-neutral-200 text-neutral-900 hover:bg-neutral-400"
                    }`}
                >
                    {spec.confirm.label(live)}
                </button>
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
                    Cancel
                </button>
            </div>
        </aside>
    );
}

function DockRow({ row, onOpen }: { row: Row; onOpen: (file: DbFile) => void }): JSX.Element {
    const { rootPath } = useFolders();
    const { file, resolved } = row;
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
                className={`flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-neutral-800 disabled:hover:bg-transparent ${
                    resolved ? "opacity-60" : ""
                }`}
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
                    <span
                        className={`truncate text-[11px] ${
                            resolved ? "text-emerald-400/80" : "text-red-300/80"
                        }`}
                    >
                        {resolved
                            ? file
                                ? "Resolved · won't change"
                                : "No longer in the library"
                            : row.detail}
                    </span>
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
