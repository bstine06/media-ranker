import { useEffect, useMemo, useRef, useState } from "react";
import type {
    DbTagWithCategory,
    FilterNode,
    TagCoverage,
    TagCoverageRaw,
} from "@renderer/shared/types/types";
import { useTags } from "@renderer/contexts/TagsContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { useFolders } from "@renderer/contexts/FolderContext";
import { filterKey } from "@renderer/lib/tagFilters";
import { SliderInput } from "./Sidebar";
import { ScopeSummary } from "./ScopeSummary";
import { inTagPointer } from "@renderer/contexts/TagPointerContext";

// Tag coverage: how much of the library has been checked for each tag.
// A file is checked for a tag when it's a yes (has the tag) or a no: firm
// (the tag was taken off it, or it was stepped past in a pass) or seen (it
// sat on screen in Sweep long enough with the tag up — the seconds are a
// setting). Share = checked ÷ library files.


/** A set of files coverage can be limited to (null: the whole library). */
export type CoverageScope = { folderPrefixes: string[] | null; filter: FilterNode | null } | null;

/** Coverage for every tag at the current seconds threshold, over the
 *  library or a scope. Read while `active` (and again when the tags or the
 *  scope change); the threshold is applied here, so moving it updates
 *  straight away. Null until the first read. */
export function useTagCoverage(active: boolean, scope: CoverageScope = null): TagCoverage | null {
    const { coverageSeconds } = useSettings();
    const { allTags } = useTags();
    const [raw, setRaw] = useState<TagCoverageRaw | null>(null);
    const scopeKey = scope
        ? JSON.stringify([scope.folderPrefixes, filterKey(scope.filter)])
        : "";
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    useEffect(() => {
        if (!active) return;
        let gone = false;
        const sc = scopeRef.current;
        setRaw(null);
        window.api
            .getTagCoverage(sc?.folderPrefixes ?? null, sc?.filter ?? null)
            .then((c) => {
                if (!gone) setRaw(c);
            })
            .catch(() => {});
        return () => {
            gone = true;
        };
    }, [active, allTags, scopeKey]);
    return useMemo(() => {
        if (!raw) return null;
        return {
            files: raw.files,
            tags: raw.tags.map((t) => {
                const seen = t.seen.reduce(
                    (s, [sec, n]) => (sec >= coverageSeconds ? s + n : s),
                    0,
                );
                return { tagId: t.tagId, yes: t.yes, firmNo: t.firmNo, seen, no: t.firmNo + seen };
            }),
        };
    }, [raw, coverageSeconds]);
}

/** Whole percent, rounded down so it never says 100% before it is; a
 *  little coverage shows as "<1%" rather than 0%. */
function pctText(checked: number, files: number): string {
    if (files === 0) return "0%";
    const p = (checked / files) * 100;
    if (p > 0 && p < 1) return "<1%";
    return `${Math.floor(p)}%`;
}

const num = (n: number) => n.toLocaleString();

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Two shades: solid for firm answers (yes, or a firm no), lighter after
 *  it for seen (a no from Sweep time only). Shares of the whole. */
function Bar({
    firm,
    seen,
    className = "",
}: {
    firm: number;
    seen: number;
    className?: string;
}) {
    const f = clamp01(firm);
    const s = clamp01(Math.min(seen, 1 - f));
    return (
        <div className={`relative h-1.5 overflow-hidden rounded bg-neutral-800 ${className}`}>
            <div
                className="absolute inset-y-0 left-0 bg-neutral-300"
                style={{ width: `${f * 100}%` }}
            />
            <div
                className="absolute inset-y-0 bg-neutral-500"
                style={{ left: `${f * 100}%`, width: `${s * 100}%` }}
            />
        </div>
    );
}

// ─── In the tag editor ────────────────────────────────────────────────────────

export function TagCoverageSummary({
    tagId,
    coverage,
}: {
    tagId: number;
    coverage: TagCoverage | null;
}) {
    const row = coverage?.tags.find((r) => r.tagId === tagId);
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                Coverage
            </label>
            {!coverage || !row ? (
                <p className="text-[11px] text-neutral-600">…</p>
            ) : (
                <>
                    <div className="flex items-center gap-3">
                        <Bar
                            firm={coverage.files ? (row.yes + row.firmNo) / coverage.files : 0}
                            seen={coverage.files ? row.seen / coverage.files : 0}
                            className="flex-1"
                        />
                        <span className="text-sm text-neutral-200 tabular-nums">
                            {pctText(row.yes + row.no, coverage.files)} checked
                        </span>
                    </div>
                    <p className="text-[11px] text-neutral-500 tabular-nums">
                        {num(row.yes)} tagged · {num(row.firmNo)} no · {num(row.seen)} seen ·{" "}
                        {num(Math.max(0, coverage.files - row.yes - row.no))} not checked yet
                    </p>
                </>
            )}
        </div>
    );
}

// ─── The Coverage tab ─────────────────────────────────────────────────────────

type Row = {
    tag: DbTagWithCategory;
    yes: number;
    firmNo: number;
    seen: number;
    /** yes + firmNo + seen */
    checked: number;
    /** yes + firmNo */
    firm: number;
};

const GRID =
    "grid grid-cols-[minmax(8rem,14rem)_minmax(6rem,1fr)_3rem_4.5rem_4rem_4rem_7rem] items-center gap-x-4";

export default function TagCoverageView({
    coverage: libraryCoverage,
    onEditTag,
    onPassTag,
}: {
    /** The whole library's coverage (the Selection view reads its own). */
    coverage: TagCoverage | null;
    onEditTag: (tagId: number) => void;
    onPassTag: (tagId: number) => void;
}) {
    const { allTags, activeFilter, loadedFeed, filter } = useTags();
    const { folderPrefixes } = useFolders();
    const { coverageSeconds, setCoverageSeconds, coverageScope, setCoverageScope } = useSettings();
    // Selection = the current folders + tag filter. With neither, it's the
    // whole library, so the switch is off and Library shows.
    const hasSelection = folderPrefixes != null || activeFilter != null;
    const bySelection = coverageScope === "selection" && hasSelection;
    const selectionCoverage = useTagCoverage(
        bySelection,
        bySelection ? { folderPrefixes, filter: activeFilter } : null,
    );
    const coverage = bySelection ? selectionCoverage : libraryCoverage;
    const feedName =
        loadedFeed && filterKey(loadedFeed.tree) === filterKey(filter) ? loadedFeed.name : null;
    // Sorted by % checked (or % firm), lowest first unless flipped.
    const [sortBy, setSortBy] = useState<"checked" | "firm">("checked");
    const [lowestFirst, setLowestFirst] = useState(true);
    const sortOn = (by: "checked" | "firm") => {
        if (by === sortBy) setLowestFirst((v) => !v);
        else {
            setSortBy(by);
            setLowestFirst(true);
        }
    };
    // The row whose menu is open.
    const [menuFor, setMenuFor] = useState<number | null>(null);

    const files = coverage?.files ?? 0;

    const { swept, off, total } = useMemo(() => {
        const byId = new Map((coverage?.tags ?? []).map((r) => [r.tagId, r]));
        const rows: Row[] = allTags.map((tag) => {
            const r = byId.get(tag.id);
            const yes = r?.yes ?? 0;
            const firmNo = r?.firmNo ?? 0;
            const seen = r?.seen ?? 0;
            return { tag, yes, firmNo, seen, checked: yes + firmNo + seen, firm: yes + firmNo };
        });
        const dir = lowestFirst ? 1 : -1;
        rows.sort(
            (a, b) =>
                dir * (a[sortBy] - b[sortBy]) ||
                dir * (a.checked - b.checked) ||
                a.tag.name.localeCompare(b.tag.name),
        );
        const swept = rows.filter((r) => inTagPointer(r.tag));
        const off = rows.filter((r) => !inTagPointer(r.tag));
        // Total: every checked file/tag pair over every pair, tag pointer
        // tags only (the average of their shares).
        const checked = swept.reduce((s, r) => s + r.checked, 0);
        const firm = swept.reduce((s, r) => s + r.firm, 0);
        const pairs = swept.length * files;
        return { swept, off, total: { checked, firm, pairs } };
    }, [allTags, coverage, sortBy, lowestFirst, files]);

    const scopeSwitch = (
        <div className="flex items-center gap-1 rounded-md bg-neutral-900 p-0.5">
            {(["library", "selection"] as const).map((sc) => {
                const on = sc === "selection" ? bySelection : !bySelection;
                const disabled = sc === "selection" && !hasSelection;
                return (
                    <button
                        key={sc}
                        disabled={disabled}
                        onClick={() => setCoverageScope(sc)}
                        title={
                            disabled
                                ? "Select collections or turn on a tag filter to see coverage for them"
                                : undefined
                        }
                        className={`rounded px-2.5 py-0.5 text-xs font-medium transition-colors ${
                            on
                                ? "bg-neutral-700 text-neutral-100"
                                : disabled
                                  ? "cursor-default text-neutral-700"
                                  : "text-neutral-500 hover:text-neutral-300"
                        }`}
                    >
                        {sc === "library" ? "Library" : "Selection"}
                    </button>
                );
            })}
        </div>
    );

    if (!coverage) {
        return (
            <div className="flex flex-1 flex-col">
                <div className="px-5 pt-4">{scopeSwitch}</div>
                <div className="p-5 text-sm text-neutral-600">Counting…</div>
            </div>
        );
    }

    const renderRow = (r: Row) => (
        <CoverageRow
            key={r.tag.id}
            row={r}
            files={files}
            menuOpen={menuFor === r.tag.id}
            onToggleMenu={() => setMenuFor((m) => (m === r.tag.id ? null : r.tag.id))}
            onCloseMenu={() => setMenuFor(null)}
            onEdit={() => {
                setMenuFor(null);
                onEditTag(r.tag.id);
            }}
            onPass={() => {
                setMenuFor(null);
                onPassTag(r.tag.id);
            }}
        />
    );

    return (
        <div className="flex flex-1 flex-col overflow-y-auto">
            <div className="px-5 pt-4 pb-4 border-b border-neutral-800">
                <div className="mb-3">{scopeSwitch}</div>
                {bySelection && (
                    <div className="mb-3">
                        <ScopeSummary
                            folderPrefixes={folderPrefixes}
                            filter={activeFilter}
                            feedName={feedName}
                            files={files}
                        />
                    </div>
                )}
                <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                        {bySelection ? "Selection coverage" : "Library coverage"}
                    </span>
                    <span className="text-2xl font-semibold text-neutral-100 tabular-nums">
                        {pctText(total.checked, total.pairs)}
                    </span>
                </div>
                <Bar
                    firm={total.pairs ? total.firm / total.pairs : 0}
                    seen={total.pairs ? (total.checked - total.firm) / total.pairs : 0}
                    className="mt-2 h-2"
                />
                <p className="mt-2 text-[11px] text-neutral-600 tabular-nums">
                    {num(swept.length)} tag{swept.length === 1 ? "" : "s"} in the tag pointer ×{" "}
                    {num(files)} file{files === 1 ? "" : "s"}
                </p>
                <SliderInput
                    name="Seconds on screen to count as a no"
                    min={1}
                    max={30}
                    value={coverageSeconds}
                    unit="s"
                    onChange={setCoverageSeconds}
                />
            </div>

            <div className="px-3 py-2">
                <div
                    className={`${GRID} px-2 py-1.5 text-[10px] uppercase tracking-wider text-neutral-600`}
                >
                    <span>Tag</span>
                    <span className="flex items-center gap-3">
                        {(["checked", "firm"] as const).map((by) => (
                            <button
                                key={by}
                                onClick={() => sortOn(by)}
                                title={
                                    by === "checked"
                                        ? "Sort by % checked (firm answers + seen)"
                                        : "Sort by % firm (yes, or a firm no): what a pass would help most"
                                }
                                className={`uppercase tracking-wider transition-colors ${
                                    sortBy === by ? "text-neutral-300" : "hover:text-neutral-300"
                                }`}
                            >
                                {by === "checked" ? "Checked" : "Firm"}
                                {sortBy === by && (lowestFirst ? " ↑" : " ↓")}
                            </button>
                        ))}
                    </span>
                    <span className="text-right">%</span>
                    <span className="text-right">Tagged</span>
                    <span className="text-right" title="Firm noes: the tag was taken off, or stepped past in a pass">
                        No
                    </span>
                    <span className="text-right" title="On screen in Sweep long enough with the tag up (soft)">
                        Seen
                    </span>
                    <span className="text-right">Not checked</span>
                </div>

                {swept.length === 0 && (
                    <p className="px-2 py-2 text-xs text-neutral-600">No tags are on in the tag pointer.</p>
                )}
                {swept.map(renderRow)}

                {off.length > 0 && (
                    <>
                        <div className="mt-5 px-2 pb-1 flex items-baseline gap-2 border-b border-neutral-800">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                                Off in the tag pointer
                            </span>
                            <span className="text-[11px] text-neutral-600">
                                Not counted in the library total
                            </span>
                        </div>
                        <div className="mt-1">{off.map(renderRow)}</div>
                    </>
                )}
            </div>
        </div>
    );
}

function CoverageRow({
    row,
    files,
    menuOpen,
    onToggleMenu,
    onCloseMenu,
    onEdit,
    onPass,
}: {
    row: Row;
    files: number;
    menuOpen: boolean;
    onToggleMenu: () => void;
    onCloseMenu: () => void;
    onEdit: () => void;
    onPass: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    // Open menu: a click elsewhere or Escape closes it.
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) onCloseMenu();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                onCloseMenu();
            }
        };
        document.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown);
            window.removeEventListener("keydown", onKey, true);
        };
    }, [menuOpen, onCloseMenu]);

    const { tag, yes, firmNo, seen, checked, firm } = row;
    const color = tag.category?.color ?? "#888";
    return (
        <div ref={ref} className="relative">
            <button
                onClick={onToggleMenu}
                className={`${GRID} w-full px-2 py-1 rounded-md text-left text-xs transition-colors ${
                    menuOpen ? "bg-neutral-800" : "hover:bg-neutral-900"
                }`}
            >
                <span className="flex items-center gap-2 min-w-0 text-neutral-300">
                    <span className="text-[10px] leading-none flex-shrink-0" style={{ color }}>
                        {tag.category?.icon ?? "●"}
                    </span>
                    <span className="truncate">{tag.name}</span>
                </span>
                <Bar firm={files ? firm / files : 0} seen={files ? seen / files : 0} />
                <span className="text-right text-neutral-200 tabular-nums">
                    {pctText(checked, files)}
                </span>
                <span className="text-right text-neutral-500 tabular-nums">{num(yes)}</span>
                <span className="text-right text-neutral-500 tabular-nums">{num(firmNo)}</span>
                <span className="text-right text-neutral-500 tabular-nums">{num(seen)}</span>
                <span className="text-right text-neutral-500 tabular-nums">
                    {num(Math.max(0, files - checked))}
                </span>
            </button>
            {menuOpen && (
                <div className="absolute left-8 top-full z-20 mt-0.5 flex flex-col rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
                    <button
                        onClick={onEdit}
                        className="px-3 py-1 text-left text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                        Edit tag
                    </button>
                    <button
                        onClick={onPass}
                        className="px-3 py-1 text-left text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                        Pass with this tag
                    </button>
                </div>
            )}
        </div>
    );
}
