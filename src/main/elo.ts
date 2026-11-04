import { getDb, folderLikePattern } from "./db";
import type { DbFile } from "./db";

const K_LOW = 32; // fewer than 10 comparisons
const K_MID = 16; // 10–30 comparisons
const K_HIGH = 8; // 30+ comparisons

function kFactor(comparisonCount: number): number {
    if (comparisonCount < 10) return K_LOW;
    if (comparisonCount < 30) return K_MID;
    return K_HIGH;
}

function expectedScore(ratingA: number, ratingB: number): number {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export function computeEloUpdate(
    winner: DbFile,
    loser: DbFile,
): { newWinnerScore: number; newLoserScore: number } {
    const expectedWinner = expectedScore(winner.elo_score, loser.elo_score);
    const expectedLoser = expectedScore(loser.elo_score, winner.elo_score);

    const kWinner = kFactor(winner.comparison_count);
    const kLoser = kFactor(loser.comparison_count);

    const newWinnerScore = winner.elo_score + kWinner * (1 - expectedWinner);
    const newLoserScore = loser.elo_score + kLoser * (0 - expectedLoser);

    return { newWinnerScore, newLoserScore };
}

function getFilteredFiles(
    folderPrefixes: string[] | null,
    tagList: number[] | null,
    tagMode: "and" | "or",
): DbFile[] {
    const db = getDb();

    const conditions: string[] = [`f.status = 'active'`];
    const params: unknown[] = [];

    if (folderPrefixes && folderPrefixes.length > 0) {
        const folderConds = folderPrefixes
            .map(() => "f.path LIKE ? ESCAPE '\\'")
            .join(" OR ");
        conditions.push(`(${folderConds})`);
        params.push(...folderPrefixes.map(folderLikePattern));
    }

    if (tagList && tagList.length > 0) {
        if (tagMode === "or") {
            const placeholders = tagList.map(() => "?").join(", ");
            conditions.push(`
    f.id IN (
        SELECT ft.file_id FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id
        WHERE t.id IN (${placeholders})
    )
`);
            params.push(...tagList);
        } else {
            tagList.forEach((tag) => {
                conditions.push(`
    f.id IN (
        SELECT ft.file_id FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id
        WHERE t.id = ?
    )
`);
                params.push(tag);
            });
        }
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    // Alias the table so tag subqueries can reference it unambiguously
    return db
        .prepare(`SELECT f.* FROM files f ${whereClause}`)
        .all(...params) as DbFile[];
}

// Picks an opponent for fileA from `others` (which must not contain fileA).
// Usually someone with a similar score; occasionally anyone at all.
function pickOpponent(
    fileA: DbFile,
    others: DbFile[],
    nearChance: number,
): DbFile {
    if (Math.random() < nearChance) {
        const sorted = [...others].sort(
            (a, b) =>
                Math.abs(a.elo_score - fileA.elo_score) -
                Math.abs(b.elo_score - fileA.elo_score),
        );
        const pool = sorted.slice(
            0,
            Math.max(1, Math.floor(sorted.length * 0.2)),
        );
        return pool[Math.floor(Math.random() * pool.length)];
    }
    return others[Math.floor(Math.random() * others.length)];
}

export function getWeightedPair(
    folderPrefixes: string[] | null,
    tagList: number[] | null,
    tagMode: "and" | "or" = "or",
): [DbFile, DbFile] | null {
    const allFiles = getFilteredFiles(folderPrefixes, tagList, tagMode);
    if (allFiles.length < 2) return null;

    let fileA: DbFile;
    if (Math.random() < 0.3) {
        const sorted = [...allFiles].sort(
            (a, b) => a.comparison_count - b.comparison_count,
        );
        const pool = sorted.slice(
            0,
            Math.max(2, Math.floor(sorted.length * 0.3)),
        );
        fileA = pool[Math.floor(Math.random() * pool.length)];
    } else {
        fileA = allFiles[Math.floor(Math.random() * allFiles.length)];
    }

    const others = allFiles.filter((f) => f.id !== fileA.id);
    return [fileA, pickOpponent(fileA, others, 0.8)];
}

// What one side of Compare draws from. Same shape as the global filter so a
// lane can narrow by folder now and by tags later.
export interface PoolFilter {
    folderPrefixes: string[] | null;
    tagList: number[] | null;
    tagMode: "and" | "or";
}

// A pair with each side drawn from its own pool. One side (chosen at random,
// so neither lane is favored) is picked the usual way; the other side then
// gets a similar-scored opponent from its pool. Pools may overlap; a file
// never faces itself.
export function getLanePair(
    laneA: PoolFilter,
    laneB: PoolFilter,
): [DbFile, DbFile] | null {
    const poolA = getFilteredFiles(
        laneA.folderPrefixes,
        laneA.tagList,
        laneA.tagMode,
    );
    const poolB = getFilteredFiles(
        laneB.folderPrefixes,
        laneB.tagList,
        laneB.tagMode,
    );
    if (poolA.length === 0 || poolB.length === 0) return null;

    const anchorIsA = Math.random() < 0.5;
    const anchorPool = anchorIsA ? poolA : poolB;
    const otherPool = anchorIsA ? poolB : poolA;

    // Anchors that have at least one possible opponent.
    const otherIds = new Set(otherPool.map((f) => f.id));
    const viable = anchorPool.filter(
        (f) => otherIds.size > 1 || !otherIds.has(f.id),
    );
    if (viable.length === 0) return null;

    let anchor: DbFile;
    if (Math.random() < 0.3) {
        const sorted = [...viable].sort(
            (a, b) => a.comparison_count - b.comparison_count,
        );
        const pool = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.3)));
        anchor = pool[Math.floor(Math.random() * pool.length)];
    } else {
        anchor = viable[Math.floor(Math.random() * viable.length)];
    }

    const opponent = pickOpponent(
        anchor,
        otherPool.filter((f) => f.id !== anchor.id),
        0.8,
    );
    return anchorIsA ? [anchor, opponent] : [opponent, anchor];
}

// After the filters change: keep each side of the current pair that still
// fits its side's filter, and replace only the side(s) that don't. A king is
// exempt (it stays whatever the filters say). Returns null if a side can't
// be filled.
export function refitPair(
    ids: [number, number],
    laneA: PoolFilter,
    laneB: PoolFilter,
    kingSide: "a" | "b" | null,
    recentIds: number[] = [],
): [DbFile, DbFile] | null {
    const db = getDb();
    const byId = (id: number): DbFile | undefined =>
        db
            .prepare(`SELECT * FROM files WHERE id = ? AND status = 'active'`)
            .get(id) as DbFile | undefined;
    const pools = [laneA, laneB].map((l) =>
        getFilteredFiles(l.folderPrefixes, l.tagList, l.tagMode),
    );
    const current = ids.map(byId);
    const fits = [0, 1].map((i) => {
        const f = current[i];
        if (!f) return false;
        if (kingSide === (i === 0 ? "a" : "b")) return true;
        return pools[i].some((p) => p.id === f.id);
    });

    if (fits[0] && fits[1]) return [current[0]!, current[1]!];
    if (!fits[0] && !fits[1]) return getLanePair(laneA, laneB);

    const keep = fits[0] ? 0 : 1;
    const replace = 1 - keep;
    const kept = current[keep]!;
    const candidates = pools[replace].filter((f) => f.id !== kept.id);
    if (candidates.length === 0) return null;
    // A king's challenger skips recent opponents when it can.
    const recent = new Set(kingSide ? recentIds : []);
    const fresh = candidates.filter((f) => !recent.has(f.id));
    const replacement = pickOpponent(
        kept,
        fresh.length > 0 ? fresh : candidates,
        0.8,
    );
    return keep === 0 ? [kept, replacement] : [replacement, kept];
}

// King of the Hill: find a challenger for a fixed file. Challengers come from
// the current filters (the king itself may be outside them). Recently-faced
// challengers are skipped when possible so the king doesn't see repeats.
export function getChallenger(
    kingId: number,
    folderPrefixes: string[] | null,
    tagList: number[] | null,
    tagMode: "and" | "or" = "or",
    recentIds: number[] = [],
): DbFile | null {
    const king = getDb()
        .prepare(`SELECT * FROM files WHERE id = ? AND status = 'active'`)
        .get(kingId) as DbFile | undefined;
    if (!king) return null;

    const candidates = getFilteredFiles(folderPrefixes, tagList, tagMode).filter(
        (f) => f.id !== kingId,
    );
    if (candidates.length === 0) return null;

    const recent = new Set(recentIds);
    const fresh = candidates.filter((f) => !recent.has(f.id));
    return pickOpponent(king, fresh.length > 0 ? fresh : candidates, 0.8);
}
