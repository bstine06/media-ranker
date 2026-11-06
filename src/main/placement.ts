// main/placement.ts
// Placement matches: a file with fewer than `matches` comparisons is kept on
// screen in Compare until it has had that many, so new files get a real
// score on intake instead of sitting at the starting 1000.
//
// Opponents are picked like a binary search over the ranking. The file's
// possible position is a range of the opponent pool, as fractions of it
// from the top (0 = best, 1 = worst). Each match is against a random file
// from the middle of the range (not always the exact middle, so the same
// handful of files don't come up every time); a win keeps the part above
// that opponent, a loss the part below. Ten matches narrow it to well
// under 1% of the pool on average.
//
// Plain Elo would lag far behind that search (a new file beating your top
// file still only gains ~30 points), so during placement the file's score
// is set to the score at the middle of its narrowed range. The opponent's
// score updates by normal Elo. After placement it's ordinary Elo.

import { getDb } from "./db";
import type { DbFile } from "./db";
import { getFilteredFiles, recordComparison, computeEloUpdate, type PoolFilter } from "./elo";

/** Where the file being placed may rank in the pool: 0 = top, 1 = bottom. */
export interface PlacementBounds {
    lo: number;
    hi: number;
}

const filesIn = (pool: PoolFilter): DbFile[] =>
    getFilteredFiles(pool.folderPrefixes, pool.tagList, pool.tagMode);

/** Middle part of the range an opponent is drawn from (0.4 = the middle 40%). */
const PIVOT_WINDOW = 0.4;

/**
 * Share of placement matches played against a random never-compared file,
 * to get its stats going. Those files all sit at the starting score, so
 * the result doesn't steer the search; it's a normal Elo match for them.
 */
const UNCOMPARED_SHARE = 0.25;

/**
 * The files a placement is measured against, best first: the pool minus the
 * file itself, preferring files with an established score. Uncompared files
 * all sit near the starting score and would skew it. The bar drops (full
 * placement, then 5, 3, 1 comparisons) until enough files clear it: a strict
 * bar in a mostly-new library would leave a few files facing every match.
 */
function rankedOpponents(pool: PoolFilter, fileId: number, matches: number): DbFile[] {
    const others = filesIn(pool).filter((f) => f.id !== fileId);
    const enough = Math.max(2, Math.min(200, Math.ceil(others.length * 0.25)));
    let chosen = others;
    for (const bar of [matches, 5, 3, 1]) {
        const established = others.filter((f) => f.comparison_count >= bar);
        if (established.length >= enough) {
            chosen = established;
            break;
        }
    }
    if (chosen === others) {
        // Not enough anywhere: anything compared at all, if that's two or more.
        const compared = others.filter((f) => f.comparison_count > 0);
        if (compared.length >= 2) chosen = compared;
    }
    return [...chosen].sort((a, b) => b.elo_score - a.elo_score);
}

/** Position of index `i` in a best-first list of `n`, 0 = top, 1 = bottom. */
const fractionOf = (i: number, n: number): number => (n > 1 ? i / (n - 1) : 0.5);

/** The score at `fraction` of the way down a best-first list. */
function scoreAt(ranked: DbFile[], fraction: number): number {
    if (ranked.length === 0) return 1000;
    const pos = fraction * (ranked.length - 1);
    const i = Math.floor(pos);
    const j = Math.min(i + 1, ranked.length - 1);
    return ranked[i].elo_score + (ranked[j].elo_score - ranked[i].elo_score) * (pos - i);
}

/**
 * The next file to place: newest added first, from either side's pool.
 * `side` is the side it fits (a if both), so the opponent comes from the
 * other side's pool, or from `opponentPool` when given (placing one
 * collection's files against the whole library).
 */
export function getPlacementCandidate(
    laneA: PoolFilter,
    laneB: PoolFilter,
    matches: number,
    opponentPool?: PoolFilter,
): { file: DbFile; side: "a" | "b" } | null {
    const newestFirst = (files: DbFile[]) =>
        files
            .filter((f) => f.comparison_count < matches)
            .sort(
                (x, y) =>
                    y.date_indexed.localeCompare(x.date_indexed) || y.id - x.id,
            );
    const a = newestFirst(filesIn(laneA));
    const b = newestFirst(filesIn(laneB));
    const pick =
        a[0] && b[0]
            ? a[0].date_indexed >= b[0].date_indexed
                ? { file: a[0], side: "a" as const }
                : { file: b[0], side: "b" as const }
            : a[0]
              ? { file: a[0], side: "a" as const }
              : b[0]
                ? { file: b[0], side: "b" as const }
                : null;
    // Needs at least one possible opponent on the other side.
    if (!pick) return null;
    const opponents = filesIn(
        opponentPool ?? (pick.side === "a" ? laneB : laneA),
    ).filter(
        (f) => f.id !== pick.file.id,
    );
    return opponents.length > 0 ? pick : null;
}

/** How many files in either side's pool still need placement. */
export function countPlacementCandidates(
    laneA: PoolFilter,
    laneB: PoolFilter,
    matches: number,
): number {
    const ids = new Set<number>();
    for (const lane of [laneA, laneB]) {
        for (const f of filesIn(lane)) {
            if (f.comparison_count < matches) ids.add(f.id);
        }
    }
    return ids.size;
}

/**
 * Where to start searching for a file. A file with no comparisons could be
 * anywhere. One part-way through placement (e.g. the app was closed) has a
 * score that already reflects its earlier matches, so the search resumes
 * around it, narrowed by half per match it has had.
 */
export function initialPlacementBounds(
    fileId: number,
    pool: PoolFilter,
    matches: number,
): PlacementBounds {
    const file = getDb().prepare(`SELECT * FROM files WHERE id = ?`).get(fileId) as
        | DbFile
        | undefined;
    if (!file || file.comparison_count === 0) return { lo: 0, hi: 1 };
    const ranked = rankedOpponents(pool, fileId, matches);
    if (ranked.length < 2) return { lo: 0, hi: 1 };
    const above = ranked.filter((f) => f.elo_score > file.elo_score).length;
    const r = above / (ranked.length - 1);
    const width = Math.pow(0.5, file.comparison_count);
    const lo = Math.max(0, Math.min(1 - width, r - width / 2));
    return { lo, hi: Math.min(1, lo + width) };
}

/**
 * A random opponent from the middle of the file's range, skipping recent
 * ones (the range can get narrower than one file) by stepping outward.
 */
export function getPlacementOpponent(
    fileId: number,
    pool: PoolFilter,
    matches: number,
    bounds: PlacementBounds,
    recentIds: number[],
): DbFile | null {
    const ranked = rankedOpponents(pool, fileId, matches);
    const recent = new Set(recentIds);

    if (Math.random() < UNCOMPARED_SHARE) {
        const rankedIds = new Set(ranked.map((f) => f.id));
        const uncompared = filesIn(pool).filter(
            (f) =>
                f.id !== fileId &&
                f.comparison_count === 0 &&
                !rankedIds.has(f.id) &&
                !recent.has(f.id),
        );
        if (uncompared.length > 0) {
            return uncompared[Math.floor(Math.random() * uncompared.length)];
        }
    }

    if (ranked.length === 0) return null;
    const pivot =
        bounds.lo +
        (bounds.hi - bounds.lo) * (0.5 + (Math.random() - 0.5) * PIVOT_WINDOW);
    const target = Math.round(pivot * (ranked.length - 1));
    for (let step = 0; step < ranked.length; step++) {
        for (const i of [target - step, target + step]) {
            if (i >= 0 && i < ranked.length && !recent.has(ranked[i].id)) {
                return ranked[i];
            }
        }
    }
    return ranked[target];
}

/**
 * Records a placement match: narrows the range by the result, sets the
 * placed file's score to the middle of the new range, updates the opponent
 * by Elo. Returns the usual comparison result plus the new range.
 */
export function recordPlacement(
    placingId: number,
    opponentId: number,
    placingWon: boolean,
    pool: PoolFilter,
    matches: number,
    bounds: PlacementBounds,
    domainPath: string,
) {
    const db = getDb();
    const get = (id: number) =>
        db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as DbFile | undefined;
    const placing = get(placingId);
    const opponent = get(opponentId);
    if (!placing || !opponent) return null;

    const ranked = rankedOpponents(pool, placingId, matches);
    // Narrow at the opponent's own position (it was drawn at random from
    // the middle of the range). An opponent outside the ranked list (a
    // never-compared file, played to get its stats going) says nothing
    // about where this file belongs: the range stays as it was.
    const at = ranked.findIndex((f) => f.id === opponentId);
    let next: PlacementBounds = bounds;
    if (at >= 0) {
        const split = Math.min(
            bounds.hi,
            Math.max(bounds.lo, fractionOf(at, ranked.length)),
        );
        next = placingWon
            ? { lo: bounds.lo, hi: split }
            : { lo: split, hi: bounds.hi };
    }

    // The opponent's side of a normal Elo update.
    const elo = placingWon
        ? computeEloUpdate(placing, opponent)
        : computeEloUpdate(opponent, placing);
    const opponentScore = placingWon ? elo.newLoserScore : elo.newWinnerScore;

    let placedScore = scoreAt(ranked, (next.lo + next.hi) / 2);
    // Never lost (range still touches the top): above everyone, even though
    // its wins lowered the scores of the files it beat. Likewise never won.
    // Not while the range is still the whole pool (only side matches so
    // far): that's neither.
    const scoresAfter = ranked.map((f) =>
        f.id === opponentId ? opponentScore : f.elo_score,
    );
    if (scoresAfter.length > 0 && next.lo === 0 && next.hi < 1) {
        placedScore = Math.max(placedScore, Math.max(...scoresAfter) + 1);
    }
    if (scoresAfter.length > 0 && next.hi === 1 && next.lo > 0) {
        placedScore = Math.min(placedScore, Math.min(...scoresAfter) - 1);
    }

    const result = placingWon
        ? recordComparison(placingId, opponentId, domainPath, {
              newWinnerScore: placedScore,
              newLoserScore: opponentScore,
          })
        : recordComparison(opponentId, placingId, domainPath, {
              newWinnerScore: opponentScore,
              newLoserScore: placedScore,
          });
    return result ? { ...result, bounds: next } : null;
}
