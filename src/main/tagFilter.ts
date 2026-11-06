// main/tagFilter.ts
// The tag part of a file filter (Browse, Compare, Discover), as SQL.
//
// A filter is a list of tag ids. Two kinds of negative id stand for special
// filters, so they travel through the same plumbing as ordinary tags (the
// renderer's lib/tagFilters.ts makes them):
//   -1       UNTAGGED: files with no tags at all
//   -1 - c   files with no tag from category c
// Tags are a file's effective tags: its own plus its folder's.

export const UNTAGGED = -1;

function condition(id: number, fileCol: string): { sql: string; params: number[] } {
    if (id === UNTAGGED) {
        return {
            sql: `${fileCol} NOT IN (SELECT file_id FROM file_effective_tags)`,
            params: [],
        };
    }
    if (id < UNTAGGED) {
        return {
            sql: `${fileCol} NOT IN (
                SELECT eft.file_id FROM file_effective_tags eft
                JOIN tags t ON t.id = eft.tag_id
                WHERE t.category_id = ?)`,
            params: [UNTAGGED - id],
        };
    }
    return {
        sql: `${fileCol} IN (SELECT file_id FROM file_effective_tags WHERE tag_id = ?)`,
        params: [id],
    };
}

/**
 * A WHERE fragment matching files that pass the tag filter (all of the ids
 * for "and", any for "or"), or null when there's no tag filter.
 * `fileCol` is the file id column of the outer query.
 */
export function tagFilterSql(
    tagIds: number[] | null | undefined,
    mode: "and" | "or",
    fileCol = "f.id",
): { sql: string; params: number[] } | null {
    if (!tagIds || tagIds.length === 0) return null;
    const parts = tagIds.map((id) => condition(id, fileCol));
    return {
        sql: `(${parts.map((p) => p.sql).join(mode === "and" ? " AND " : " OR ")})`,
        params: parts.flatMap((p) => p.params),
    };
}
