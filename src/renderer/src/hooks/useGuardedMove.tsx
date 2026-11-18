import { useCallback, useState } from "react";
import ConfirmDialog from "@renderer/components/ConfirmDialog";

type MoveResult = { moved: number; errors: string[] };

type Pending = {
    absPaths: string[];
    target: string;
    losing: { absPath: string; filename: string; tags: string[] }[];
    resolve: (r: MoveResult | null) => void;
};

/**
 * Moving files into a folder, checked against the folder's noes first. If
 * some files would lose their own tags (the folder rules them out), a
 * dialog offers: move all and remove those tags, move only the files that
 * keep their tags, or cancel. Otherwise it just moves.
 * Render `moveDialog` somewhere in the component.
 */
export function useGuardedMove(): {
    guardedMove: (absPaths: string[], target: string) => Promise<MoveResult | null>;
    moveDialog: JSX.Element | null;
} {
    const [pending, setPending] = useState<Pending | null>(null);

    const guardedMove = useCallback(
        async (absPaths: string[], target: string): Promise<MoveResult | null> => {
            const losing = await window.api.previewMoveIntoFolder(absPaths, target);
            if (losing.length === 0) return window.api.moveIntoFolder(absPaths, target);
            return new Promise((resolve) => setPending({ absPaths, target, losing, resolve }));
        },
        [],
    );

    const finish = async (mode: "all" | "keepers" | null) => {
        if (!pending) return;
        const { absPaths, target, losing, resolve } = pending;
        setPending(null);
        if (mode === null) return resolve(null);
        if (mode === "all") return resolve(await window.api.moveIntoFolder(absPaths, target, true));
        const skip = new Set(losing.map((l) => l.absPath));
        const keepers = absPaths.filter((p) => !skip.has(p));
        resolve(keepers.length > 0 ? await window.api.moveIntoFolder(keepers, target) : { moved: 0, errors: [] });
    };

    const folderName = pending?.target.split("/").pop() ?? "";
    const keepers = pending ? pending.absPaths.length - pending.losing.length : 0;
    const moveDialog = pending ? (
        <ConfirmDialog
            title={`Some files would lose tags in ${folderName}`}
            message={
                <>
                    <p className="mb-2">
                        {pending.losing.length === 1
                            ? "1 file has tags"
                            : `${pending.losing.length} files have tags`}{" "}
                        that aren't allowed in {folderName}:
                    </p>
                    <ul className="max-h-40 overflow-y-auto space-y-0.5">
                        {pending.losing.map((l) => (
                            <li key={l.absPath} className="truncate">
                                <span className="text-neutral-300">{l.filename}</span>
                                <span className="text-red-300/80"> · {l.tags.join(", ")}</span>
                            </li>
                        ))}
                    </ul>
                </>
            }
            confirmText="Move all and remove tags"
            onConfirm={() => void finish("all")}
            onCancel={() => void finish(null)}
            secondary={
                keepers > 0
                    ? {
                          text: `Move only the ${keepers} that keep their tags`,
                          onClick: () => void finish("keepers"),
                          danger: false,
                      }
                    : undefined
            }
        />
    ) : null;

    return { guardedMove, moveDialog };
}
