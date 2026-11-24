import { useCallback } from "react";
import { PendingState, usePendingChange } from "@renderer/contexts/PendingChangeContext";
import { AffectedPills, Effect, FolderRef } from "@renderer/components/InlineRefs";
import { affectedDetail, plural } from "@renderer/lib/pending";

type MoveResult = { moved: number; errors: string[] };
type Clash = {
    absPath: string;
    fileId: number;
    filename: string;
    /** Own tags the folder's noes rule out. */
    tags: string[];
    /** Own noes on tags the folder gives. */
    cleared: string[];
};

const stateOf = (clashes: Clash[]): PendingState => ({
    items: clashes.map((c) => ({
        fileId: c.fileId,
        detail: affectedDetail({ loses: c.tags, cleared: c.cleared }),
        loses: c.tags,
        cleared: c.cleared,
    })),
    removes: clashes.reduce((n, c) => n + c.tags.length, 0),
    clears: clashes.reduce((n, c) => n + c.cleared.length, 0),
});

/**
 * Moving files into a folder, checked against the folder's rules first.
 * Files that clash with them (own tags its noes rule out, or own noes on
 * tags it gives) make it ask (Confirm · Cancel · Manage…, see
 * PendingChangeContext): move all with the folder's rules winning (those
 * tags come off, those noes are cleared), move only the files that don't
 * clash, or cancel. Otherwise it just moves.
 */
export function useGuardedMove(): {
    guardedMove: (absPaths: string[], target: string) => Promise<MoveResult | null>;
    /** Kept so callers don't change: the dialog now lives app-wide. */
    moveDialog: JSX.Element | null;
} {
    const { requestChange } = usePendingChange();

    const guardedMove = useCallback(
        async (absPaths: string[], target: string): Promise<MoveResult | null> => {
            const clashes = await window.api.previewMoveIntoFolder(absPaths, target);
            if (clashes.length === 0) return window.api.moveIntoFolder(absPaths, target);

            const folderName = target.split("/").pop() ?? target;
            const total = absPaths.length;
            let result: MoveResult | null = null;
            const ran = await requestChange({
                title: (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                        Some files clash with <FolderRef path={target} />
                    </span>
                ),
                message: (
                    <div className="flex flex-col gap-2">
                        <Effect>
                            {clashes.length === 1 ? "1 file clashes" : `${clashes.length} files clash`} with
                            <FolderRef path={target} />
                        </Effect>
                        <ul className="max-h-48 overflow-y-auto flex flex-col gap-1.5">
                            {clashes.map((c) => (
                                <li key={c.absPath} className="flex flex-col gap-0.5">
                                    <span className="truncate text-neutral-300">{c.filename}</span>
                                    <span className="pl-2 text-red-300/80">
                                        <AffectedPills loses={c.tags} cleared={c.cleared} />
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                ),
                dockTitle: `Move pending: ${plural(total, "file")} → ${folderName}`,
                headerFolder: target,
                byOrigin: true,
                initial: stateOf(clashes),
                load: async () => stateOf(await window.api.previewMoveIntoFolder(absPaths, target)),
                confirm: {
                    label: (live) => {
                        const parts = [
                            live.removes ? plural(live.removes, "tag") : null,
                            live.clears ? plural(live.clears, "no").replace(/nos$/, "noes") : null,
                        ].filter(Boolean);
                        return parts.length > 0
                            ? `Move ${plural(total, "file")} · removes ${parts.join(" and ")}`
                            : `Move ${plural(total, "file")}`;
                    },
                    run: async () => {
                        result = await window.api.moveIntoFolder(absPaths, target, true);
                    },
                },
                secondary: {
                    label: (live) =>
                        `Move only the ${(total - live.items.length).toLocaleString()} that don't clash`,
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
