// main/placement.ts
// Placement matches: a file with fewer than `matches` comparisons is kept on
// screen in Compare until it has had that many, so new files get a real
// score on intake instead of sitting at the starting 1000.
//
// Opponents are picked like a binary search over the ranking. The file's
// possible position is a range of the opponent pool, as fractions of it
// from the top (0 = best, 1 = worst). Each match is against the file at the
// middle of the range; a win keeps the better half, a loss the worse half.
// Ten matches narrow it to about 1 in 1000.
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

/**
 * The files a placement is measured against, best first: the pool minus the
 * file itself, and only files that have finished placement when there are
 * enough of them (unplaced files all sit near 1000 and would skew it).
 */
function rankedOpponents(pool: PoolFilter, fileId: number, matches: number): DbFile[] {
    const others = filesIn(pool).filter((f) => f.id !== fileId);
    const placed = others.filter((f) => f.comparison_count >= matches);
    return (placed.length >= 2 ? placed : others).sort(
        (a, b) => b.elo_score - a.elo_score,
    );
}

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
 * other side's pool.
 */
export function getPlacementCandidate(
    laneA: PoolFilter,
    laneB: PoolFilter,
    matches: number,
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
    const opponents = filesIn(pick.side === "a" ? laneB : laneA).filter(
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
 * The opponent at the middle of the file's range, skipping recent ones
 * (the range can get narrower than one file) by stepping outward.
 */
export function getPlacementOpponent(
    fileId: number,
    pool: PoolFilter,
    matches: number,
    bounds: PlacementBounds,
    recentIds: number[],
): DbFile | null {
    const ranked = rankedOpponents(pool, fileId, matches);
    if (ranked.length === 0) return null;
    const target = Math.round(((bounds.lo + bounds.hi) / 2) * (ranked.length - 1));
    const recent = new Set(recentIds);
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

    const mid = (bounds.lo + bounds.hi) / 2;
    const next: PlacementBounds = placingWon
        ? { lo: bounds.lo, hi: mid }
        : { lo: mid, hi: bounds.hi };
    const ranked = rankedOpponents(pool, placingId, matches);

    // The opponent's side of a normal Elo update.
    const elo = placingWon
        ? computeEloUpdate(placing, opponent)
        : computeEloUpdate(opponent, placing);
    const opponentScore = placingWon ? elo.newLoserScore : elo.newWinnerScore;

    let placedScore = scoreAt(ranked, (next.lo + next.hi) / 2);
    // Never lost (range still touches the top): above everyone, even though
    // its wins lowered the scores of the files it beat. Likewise never won.
    const scoresAfter = ranked.map((f) =>
        f.id === opponentId ? opponentScore : f.elo_score,
    );
    if (scoresAfter.length > 0 && next.lo === 0) {
        placedScore = Math.max(placedScore, Math.max(...scoresAfter) + 1);
    }
    if (scoresAfter.length > 0 && next.hi === 1) {
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
