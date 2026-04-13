import { getDb } from "./db";
import type { DbFile } from "./db";

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
            .map(() => "f.path LIKE ?")
            .join(" OR ");
        conditions.push(`(${folderConds})`);
        params.push(...folderPrefixes.map((p) => `${p}%`));
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

    const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const file = db
        .prepare(
            `SELECT f.* FROM files f ${whereClause} ORDER BY RANDOM() LIMIT 1`,
        )
        .get(...params) as DbFile | undefined;

    return file ?? null;
}
