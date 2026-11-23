import { useCallback } from "react";
import { PendingState, usePendingChange } from "@renderer/contexts/PendingChangeContext";
import { plural } from "@renderer/lib/pending";

type MoveResult = { moved: number; errors: string[] };
type Losing = { absPath: string; fileId: number; filename: string; tags: string[] };

const stateOf = (losing: Losing[]): PendingState => ({
    items: losing.map((l) => ({ fileId: l.fileId, detail: `loses ${l.tags.join(", ")}` })),
    removes: losing.reduce((n, l) => n + l.tags.length, 0),
});

/**
 * Moving files into a folder, checked against the folder's noes first. If
 * some files would lose their own tags (the folder rules them out), it asks
 * (Confirm · Cancel · Manage…, see PendingChangeContext): move all and
 * remove those tags, move only the files that keep their tags, or cancel.
 * Otherwise it just moves.
 */
export function useGuardedMove(): {
    guardedMove: (absPaths: string[], target: string) => Promise<MoveResult | null>;
    /** Kept so callers don't change: the dialog now lives app-wide. */
    moveDialog: JSX.Element | null;
} {
    const { requestChange } = usePendingChange();

    const guardedMove = useCallback(
        async (absPaths: string[], target: string): Promise<MoveResult | null> => {
            const losing = await window.api.previewMoveIntoFolder(absPaths, target);
            if (losing.length === 0) return window.api.moveIntoFolder(absPaths, target);

            const folderName = target.split("/").pop() ?? target;
            const total = absPaths.length;
            let result: MoveResult | null = null;
            const ran = await requestChange({
                title: `Some files would lose tags in ${folderName}`,
                message: (
                    <>
                        <p className="mb-2">
                            {losing.length === 1 ? "1 file has tags" : `${losing.length} files have tags`}{" "}
                            that aren't allowed in {folderName}:
                        </p>
                        <ul className="max-h-40 overflow-y-auto space-y-0.5">
                            {losing.map((l) => (
                                <li key={l.absPath} className="truncate">
                                    <span className="text-neutral-300">{l.filename}</span>
                                    <span className="text-red-300/80"> · {l.tags.join(", ")}</span>
                                </li>
                            ))}
                        </ul>
                    </>
                ),
                dockTitle: `Move pending: ${plural(total, "file")} → ${folderName}`,
                initial: stateOf(losing),
                load: async () => stateOf(await window.api.previewMoveIntoFolder(absPaths, target)),
                confirm: {
                    label: (live) =>
                        live.items.length > 0
                            ? `Move ${plural(total, "file")} · removes ${plural(live.removes ?? 0, "tag")}`
                            : `Move ${plural(total, "file")}`,
                    run: async () => {
                        result = await window.api.moveIntoFolder(absPaths, target, true);
                    },
                },
                secondary: {
                    label: (live) =>
                        `Move only the ${(total - live.items.length).toLocaleString()} that keep their tags`,
                    danger: false,
                    disabled: (live) => total - live.items.length === 0 || live.items.length === 0,
                    run: async () => {
                        const now = await window.api.previewMoveIntoFolder(absPaths, target);
                        const skip = new Set(now.map((l) => l.absPath));
                        const keepers = absPaths.filter((p) => !skip.has(p));
                        result =
                            keepers.length > 0
                                ? await window.api.moveIntoFolder(keepers, target)
                                : { moved: 0, errors: [] };
                    },
                },
            });
            return ran ? result : null;
        },
        [requestChange],
    );

    return { guardedMove, moveDialog: null };
}
