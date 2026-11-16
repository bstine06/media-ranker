// Sweep pass mode: which files a pass goes through for a tag.
//
// "needs-firm": files without a firm answer for the tag — not tagged (own
// or inherited), not taken off by hand (rejected), not stepped past in a
// pass (passed). Files with only Sweep seconds ARE included: a pass firms
// them up, so a finished pass can't be undone by moving the seconds
// threshold later. "all" (an audit): every file in scope.
import { getDb, scopeSql } from "./db";
import type { DbFile } from "./db";
import type { FilterNode } from "./tagFilter";

export type PassWhich = "needs-firm" | "all";

// Needs a firm answer for the tag; takes the tag id twice (positional).
const NEEDS_FIRM = `
    NOT EXISTS (SELECT 1 FROM file_effective_tags e
                WHERE e.file_id = f.id AND e.tag_id = ?)
    AND NOT EXISTS (SELECT 1 FROM tag_checks c
                    WHERE c.file_id = f.id AND c.tag_id = ?
                      AND (c.rejected = 1 OR c.passed = 1))`;

/** The files a pass goes through for a tag (unordered; the renderer
 *  orders them the way Browse does). */
export function getPassFiles(
    folderPrefixes: string[] | null,
    filter: FilterNode | null,
    tagId: number,
    which: PassWhich,
): DbFile[] {
    const scope = scopeSql(folderPrefixes, filter);
    const where = which === "all" ? scope.sql : `${scope.sql} AND ${NEEDS_FIRM}`;
    const params = which === "all" ? scope.params : [...scope.params, tagId, tagId];
    return getDb()
        .prepare(`SELECT f.* FROM files f WHERE ${where}`)
        .all(...params) as DbFile[];
}

/** How many files a pass would go through for each tag (the lobby's
 *  estimates). */
export function getPassCounts(
    folderPrefixes: string[] | null,
    filter: FilterNode | null,
    tagIds: number[],
    which: PassWhich,
): Record<number, number> {
    const db = getDb();
    const scope = scopeSql(folderPrefixes, filter);
    const out: Record<number, number> = {};
    if (which === "all") {
        const n = (
            db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${scope.sql}`).get(...scope.params) as {
                n: number;
            }
        ).n;
        for (const id of tagIds) out[id] = n;
        return out;
    }
    const stmt = db.prepare(
        `SELECT COUNT(*) AS n FROM files f WHERE ${scope.sql} AND ${NEEDS_FIRM}`,
    );
    for (const id of tagIds) {
        out[id] = (stmt.get(...scope.params, id, id) as { n: number }).n;
    }
    return out;
}

/** Of these files (in order), the ones that still need a firm answer for
 *  the tag: coming back to a tag after a reorder drops what other tags'
 *  work answered meanwhile (e.g. an implied yes). Order is kept. */
export function prunePassList(tagId: number, fileIds: number[]): number[] {
    if (fileIds.length === 0) return [];
    const stmt = getDb().prepare(`SELECT 1 FROM files f WHERE f.id = ? AND f.status = 'active' AND ${NEEDS_FIRM}`);
    return fileIds.filter((id) => stmt.get(id, tagId, tagId) !== undefined);
}

/** Active files in a scope (the lobby shows it beside the scope). */
export function countScope(folderPrefixes: string[] | null, filter: FilterNode | null): number {
    const scope = scopeSql(folderPrefixes, filter);
    return (
        getDb().prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${scope.sql}`).get(...scope.params) as {
            n: number;
        }
    ).n;
}

/** 3 in a pass: stepped past the file untagged, a firm no. Skipped if the
 *  file has the tag after all (yes wins), or is gone. */
export function setPassNo(fileId: number, tagId: number): void {
    getDb()
        .prepare(
            `INSERT INTO tag_checks (file_id, tag_id, passed)
             SELECT ?, ?, 1
             WHERE EXISTS (SELECT 1 FROM files WHERE id = ?)
               AND EXISTS (SELECT 1 FROM tags WHERE id = ?)
               AND NOT EXISTS (SELECT 1 FROM file_effective_tags e
                               WHERE e.file_id = ? AND e.tag_id = ?)
             ON CONFLICT (file_id, tag_id)
             DO UPDATE SET passed = 1, updated_at = datetime('now')`,
        )
        .run(fileId, tagId, fileId, tagId, fileId, tagId);
}

/** 2 in a pass (skip): no pass no for this file. A hard no (rejected) and
 *  Sweep seconds are left alone. */
export function clearPassNo(fileId: number, tagId: number): void {
    getDb()
        .prepare(
            `UPDATE tag_checks SET passed = 0, updated_at = datetime('now')
             WHERE file_id = ? AND tag_id = ? AND passed = 1`,
        )
        .run(fileId, tagId);
}

/** Of these files, the ones with a firm no for the tag (and not tagged:
 *  yes wins), and which kind: hard (taken off by hand), pass (stepped past
 *  in a pass), or both. For the run's "no" markers. */
export function getFirmNoes(
    tagId: number,
    fileIds: number[],
): { fileId: number; hard: boolean; pass: boolean }[] {
    if (fileIds.length === 0) return [];
    const rows = getDb()
        .prepare(
            `SELECT c.file_id AS fileId, c.rejected AS hard, c.passed AS pass
             FROM tag_checks c
             WHERE c.tag_id = ?
               AND c.file_id IN (SELECT value FROM json_each(?))
               AND (c.rejected = 1 OR c.passed = 1)
               AND NOT EXISTS (SELECT 1 FROM file_effective_tags e
                               WHERE e.file_id = c.file_id AND e.tag_id = c.tag_id)`,
        )
        .all(tagId, JSON.stringify(fileIds)) as { fileId: number; hard: number; pass: number }[];
    return rows.map((r) => ({ fileId: r.fileId, hard: r.hard === 1, pass: r.pass === 1 }));
}

/** Files by id (active ones; order not kept), to rebuild a saved run. */
export function getFilesByIds(fileIds: number[]): DbFile[] {
    if (fileIds.length === 0) return [];
    return getDb()
        .prepare(
            `SELECT f.* FROM files f
             WHERE f.status = 'active' AND f.id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(fileIds)) as DbFile[];
}

// The one unfinished run, saved as JSON (its shape is the renderer's).
export function loadPassRun(): string | null {
    const row = getDb().prepare(`SELECT state FROM pass_run WHERE id = 1`).get() as
        | { state: string }
        | undefined;
    return row?.state ?? null;
}

export function savePassRun(state: string): void {
    getDb()
        .prepare(
            `INSERT INTO pass_run (id, state) VALUES (1, ?)
             ON CONFLICT (id) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`,
        )
        .run(state);
}

export function clearPassRun(): void {
    getDb().prepare(`DELETE FROM pass_run WHERE id = 1`).run();
}
