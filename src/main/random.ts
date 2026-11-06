import { getDb, folderLikePattern } from "./db";
import type { DbFile } from "./db";
import { tagFilterSql } from "./tagFilter";

export function getRandomFile(
    folderPrefixes: string[] | null,
    tagList: number[] | null,
    tagMode: "and" | "or" = "or",
    excludeIds: number[] = [],
): DbFile | null {
    const db = getDb();

    const conditions: string[] = [`f.status = 'active'`];
    const params: unknown[] = [];

    if (excludeIds.length > 0) {
        const placeholders = excludeIds.map(() => "?").join(", ");
        conditions.push(`f.id NOT IN (${placeholders})`);
        params.push(...excludeIds);
    }

    if (folderPrefixes && folderPrefixes.length > 0) {
        const folderConds = folderPrefixes
            .map(() => "f.path LIKE ? ESCAPE '\\'")
            .join(" OR ");
        conditions.push(`(${folderConds})`);
        params.push(...folderPrefixes.map(folderLikePattern));
    }

    const tagFilter = tagFilterSql(tagList, tagMode);
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
