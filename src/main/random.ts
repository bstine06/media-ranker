import { getDb, folderScopeSql } from "./db";
import type { DbFile } from "./db";
import { filterSql, type FilterNode } from "./tagFilter";

export function getRandomFile(
    folderPrefixes: string[] | null,
    filter: FilterNode | null,
    excludeIds: number[] = [],
    /** Sweep: only files without a firm answer for this tag: not tagged
     *  (own or inherited), no hard no (taken off), no pass no. */
    withoutTagId: number | null = null,
): DbFile | null {
    const db = getDb();

    const conditions: string[] = [`f.status = 'active'`];
    const params: unknown[] = [];

    if (excludeIds.length > 0) {
        const placeholders = excludeIds.map(() => "?").join(", ");
        conditions.push(`f.id NOT IN (${placeholders})`);
        params.push(...excludeIds);
    }

    const inFolders = folderScopeSql(folderPrefixes);
    if (inFolders) {
        conditions.push(inFolders.sql);
        params.push(...inFolders.params);
    }

    if (withoutTagId != null) {
        conditions.push(
            `f.id NOT IN (SELECT file_id FROM file_effective_tags WHERE tag_id = ?)`,
            `f.id NOT IN (SELECT file_id FROM tag_checks
                          WHERE tag_id = ? AND (rejected = 1 OR passed = 1))`,
            `f.id NOT IN (SELECT file_id FROM file_folder_noes WHERE tag_id = ?)`,
        );
        params.push(withoutTagId, withoutTagId, withoutTagId);
    }

    const tagFilter = filterSql(filter);
    if (tagFilter) {
        conditions.push(tagFilter.sql);
        params.push(...tagFilter.params);
    }

    const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const file = db
        .prepare(
            `SELECT f.* FROM files f ${whereClause} ORDER BY RANDOM() LIMIT 1`,
        )
        .get(...params) as DbFile | undefined;

    return file ?? null;
}
