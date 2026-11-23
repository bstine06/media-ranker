import { useEffect, useState } from "react";
import type { DbFolder, FilterNode } from "@renderer/shared/types/types";
import { useTags } from "@renderer/contexts/TagsContext";
import { pruneFilter } from "@renderer/lib/tagFilters";
import ThumbnailImage from "@renderer/shared/components/ThumbnailImage";
import { FolderIcon } from "./icons/FolderIcon";

// A read-only picture of a set of files: which collections, and which tag
// filter, drawn the way the sidebar and the filter tree draw them, so it
// looks the same as where it was set. Used where a number or a job depends
// on the selection (Coverage's Selection view, the pass lobby).

export function ScopeSummary({
    folderPrefixes,
    filter,
    feedName = null,
    files = null,
}: {
    /** Collections (relative paths); null = all of them. */
    folderPrefixes: string[] | null;
    filter: FilterNode | null;
    /** The saved feed the filter came from, if it's unedited. */
    feedName?: string | null;
    /** Files in the scope, if known. */
    files?: number | null;
}): JSX.Element {
    const tree = pruneFilter(filter);
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
                {folderPrefixes && folderPrefixes.length === 0 ? (
                    <span className="rounded-full bg-amber-950/60 px-2.5 py-1 text-xs text-amber-200">
                        No collections selected
                    </span>
                ) : folderPrefixes ? (
                    folderPrefixes.map((p) => <CollectionChip key={p} path={p} />)
                ) : (
                    <span className="rounded-full bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300">
                        All collections
                    </span>
                )}
                {files != null && (
                    <span className="ml-1 text-xs text-neutral-500 tabular-nums">
                        {files.toLocaleString()} file{files === 1 ? "" : "s"}
                    </span>
                )}
            </div>
            {tree && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {feedName && (
                        <span className="text-[11px] font-medium text-neutral-400">{feedName}:</span>
                    )}
                    <FilterView node={tree} top />
                </div>
            )}
        </div>
    );
}

function CollectionChip({ path }: { path: string }): JSX.Element {
    const [folder, setFolder] = useState<DbFolder | null>(null);
    useEffect(() => {
        let gone = false;
        if (path === "") return;
        window.api
            .getFolder(path)
            .then((f) => {
                if (!gone) setFolder(f);
            })
            .catch(() => {});
        return () => {
            gone = true;
        };
    }, [path]);
    const name = path === "" ? "Unsorted" : folder?.name ?? path.split("/").pop() ?? path;
    return (
        <span className="flex items-center gap-1.5 rounded-full bg-neutral-800 py-0.5 pl-0.5 pr-2.5 text-xs text-neutral-200">
            {folder?.profile_image_hash ? (
                <ThumbnailImage contentHash={folder.profile_image_hash} className="h-5 w-5 rounded-full" />
            ) : (
                <span className="rounded-full bg-neutral-700">
                    <FolderIcon className="m-0.5 h-4 w-4 text-neutral-500" />
                </span>
            )}
            {name}
        </span>
    );
}

const Without = () => (
    <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">WITHOUT</span>
);

function FilterView({ node, top = false }: { node: FilterNode; top?: boolean }): JSX.Element {
    const { tagMap, allCategories } = useTags();

    if (node.kind === "tag") {
        const tag = tagMap.get(node.id);
        return (
            <span className="flex items-center gap-1">
                {node.without && <Without />}
                <span className="flex items-center gap-1 rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-900">
                    {tag?.category && (
                        <span
                            className="rounded-full bg-neutral-900 px-1 py-0.5 text-[10px] leading-none"
                            style={{ color: tag.category.color ?? undefined }}
                        >
                            {tag.category.icon}
                        </span>
                    )}
                    {tag?.name ?? "deleted tag"}
                </span>
            </span>
        );
    }

    if (node.kind === "count") {
        const cat = typeof node.from === "number" ? allCategories.find((c) => c.id === node.from) : null;
        const from =
            node.from === "all"
                ? "all categories"
                : node.from === "uncategorized"
                  ? "uncategorized"
                  : cat
                    ? `${cat.icon ?? ""} ${cat.name}`.trim()
                    : "deleted category";
        return (
            <span className="flex items-center gap-1 text-xs text-neutral-300">
                {node.without && <Without />}
                <span className="tabular-nums">
                    {node.op} {node.n}
                </span>
                <span className="text-neutral-500">tags from</span>
                <span>{from}</span>
            </span>
        );
    }

    const items = node.items.flatMap((item, i) => [
        ...(i > 0
            ? [
                  <span key={`op${i}`} className="text-[10px] font-semibold text-neutral-500">
                      {node.op.toUpperCase()}
                  </span>,
              ]
            : []),
        <FilterView key={i} node={item} />,
    ]);
    if (top && !node.without) return <>{items}</>;
    return (
        <span className="flex items-center gap-1">
            {node.without && <Without />}
            <span className="flex flex-wrap items-center gap-1.5 rounded-md border-x-2 border-neutral-600 px-1.5 py-0.5">
                {items}
            </span>
        </span>
    );
}
