import { useEffect, useMemo, useRef, useState } from "react";
import type {
    DbTagWithCategory,
    TagCoverage,
    TagCoverageRaw,
} from "@renderer/shared/types/types";
import { useTags } from "@renderer/contexts/TagsContext";
import { useSettings } from "@renderer/contexts/SettingsContext";
import { SliderInput } from "./Sidebar";

// Tag coverage: how much of the library has been checked for each tag.
// A file is checked for a tag when it's a yes (has the tag) or a no (the
// tag was taken off it, or it sat on screen in Sweep long enough with the
// tag up — the seconds are a setting). Share = checked ÷ library files.

/** Offered in Sweep: on itself, and its category (if any) is on too. */
export function inSweep(t: DbTagWithCategory): boolean {
    return !!t.sweep && (!t.category || !!t.category.sweep);
}

/** Coverage for every tag at the current seconds threshold. Read while
 *  `active` (and again when the tags change); the threshold is applied
 *  here, so moving it updates straight away. Null until the first read. */
export function useTagCoverage(active: boolean): TagCoverage | null {
    const { coverageSeconds } = useSettings();
    const { allTags } = useTags();
    const [raw, setRaw] = useState<TagCoverageRaw | null>(null);
    useEffect(() => {
        if (!active) return;
        let gone = false;
        window.api
            .getTagCoverage()
            .then((c) => {
                if (!gone) setRaw(c);
            })
            .catch(() => {});
        return () => {
            gone = true;
        };
    }, [active, allTags]);
    return useMemo(() => {
        if (!raw) return null;
        return {
            files: raw.files,
            tags: raw.tags.map((t) => ({
                tagId: t.tagId,
                yes: t.yes,
                no:
                    t.rejected +
                    t.seen.reduce((s, [sec, n]) => (sec >= coverageSeconds ? s + n : s), 0),
            })),
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

function Bar({ share, className = "" }: { share: number; className?: string }) {
    return (
        <div className={`relative h-1.5 rounded bg-neutral-800 ${className}`}>
            <div
                className="absolute inset-y-0 left-0 rounded bg-neutral-300"
                style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%` }}
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
                            share={coverage.files ? (row.yes + row.no) / coverage.files : 0}
                            className="flex-1"
                        />
                        <span className="text-sm text-neutral-200 tabular-nums">
                            {pctText(row.yes + row.no, coverage.files)} checked
                        </span>
                    </div>
                    <p className="text-[11px] text-neutral-500 tabular-nums">
                        {num(row.yes)} tagged · {num(row.no)} no ·{" "}
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
    no: number;
    checked: number;
};

const GRID = "grid grid-cols-[minmax(8rem,14rem)_minmax(6rem,1fr)_3rem_4.5rem_4.5rem_7rem] items-center gap-x-4";

export default function TagCoverageView({
    coverage,
    onEditTag,
    onSweepTag,
}: {
    coverage: TagCoverage | null;
    onEditTag: (tagId: number) => void;
    onSweepTag: (tagId: number) => void;
}) {
    const { allTags } = useTags();
    const { coverageSeconds, setCoverageSeconds } = useSettings();
    // Lowest coverage first unless flipped.
    const [lowestFirst, setLowestFirst] = useState(true);
    // The row whose menu is open.
    const [menuFor, setMenuFor] = useState<number | null>(null);

    const files = coverage?.files ?? 0;

    const { swept, off, total } = useMemo(() => {
        const byId = new Map((coverage?.tags ?? []).map((r) => [r.tagId, r]));
        const rows: Row[] = allTags.map((tag) => {
            const r = byId.get(tag.id);
            const yes = r?.yes ?? 0;
            const no = r?.no ?? 0;
            return { tag, yes, no, checked: yes + no };
        });
        const dir = lowestFirst ? 1 : -1;
        rows.sort((a, b) => dir * (a.checked - b.checked) || a.tag.name.localeCompare(b.tag.name));
        const swept = rows.filter((r) => inSweep(r.tag));
        const off = rows.filter((r) => !inSweep(r.tag));
        // Library total: every checked file/tag pair over every pair, Sweep
        // tags only (the average of their shares).
        const checked = swept.reduce((s, r) => s + r.checked, 0);
        const pairs = swept.length * files;
        return { swept, off, total: { checked, pairs } };
    }, [allTags, coverage, lowestFirst, files]);

    if (!coverage) {
        return <div className="p-5 text-sm text-neutral-600">Counting…</div>;
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
            onSweep={() => {
                setMenuFor(null);
                onSweepTag(r.tag.id);
            }}
        />
    );

    return (
        <div className="flex flex-1 flex-col overflow-y-auto">
            <div className="px-5 pt-5 pb-4 border-b border-neutral-800">
                <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                        Library coverage
                    </span>
                    <span className="text-2xl font-semibold text-neutral-100 tabular-nums">
                        {pctText(total.checked, total.pairs)}
                    </span>
                </div>
                <Bar
                    share={total.pairs ? total.checked / total.pairs : 0}
                    className="mt-2 h-2"
                />
                <p className="mt-2 text-[11px] text-neutral-600 tabular-nums">
                    {num(swept.length)} Sweep tag{swept.length === 1 ? "" : "s"} ×{" "}
                    {num(files)} file{files === 1 ? "" : "s"}
                </p>
                <SliderInput
                    name="Seconds on screen in Sweep to count as a no"
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
                    <button
                        onClick={() => setLowestFirst((v) => !v)}
                        title="Sort by coverage"
                        className="text-left uppercase tracking-wider hover:text-neutral-300 transition-colors"
                    >
                        Coverage {lowestFirst ? "↑" : "↓"}
                    </button>
                    <span className="text-right">%</span>
                    <span className="text-right">Tagged</span>
                    <span className="text-right">No</span>
                    <span className="text-right">Not checked</span>
                </div>

                {swept.length === 0 && (
                    <p className="px-2 py-2 text-xs text-neutral-600">No tags are on in Sweep.</p>
                )}
                {swept.map(renderRow)}

                {off.length > 0 && (
                    <>
                        <div className="mt-5 px-2 pb-1 flex items-baseline gap-2 border-b border-neutral-800">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                                Off in Sweep
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
    onSweep,
}: {
    row: Row;
    files: number;
    menuOpen: boolean;
    onToggleMenu: () => void;
    onCloseMenu: () => void;
    onEdit: () => void;
    onSweep: () => void;
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

    const { tag, yes, no, checked } = row;
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
                <Bar share={files ? checked / files : 0} />
                <span className="text-right text-neutral-200 tabular-nums">
                    {pctText(checked, files)}
                </span>
                <span className="text-right text-neutral-500 tabular-nums">{num(yes)}</span>
                <span className="text-right text-neutral-500 tabular-nums">{num(no)}</span>
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
                        onClick={onSweep}
                        className="px-3 py-1 text-left text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                        Sweep with this tag
                    </button>
                </div>
            )}
        </div>
    );
}
