// main/tagFilter.ts
// The tag part of a file filter (Browse, Compare, Sweep), as SQL.
//
// A filter is a tree, mirrored in the renderer's shared types:
//   group  items joined by AND or OR (one word per group; mixing needs a
//          nested group)
//   tag    files that have the tag
//   count  files with < / = / > N tags, from all categories, one category
//          or uncategorized tags
// Any node can be WITHOUT, which inverts it. Tags are a file's effective
// tags: its own, its folder's and implied ones (file_effective_tags).
// Empty groups are ignored; an empty tree is no filter.

export type CountFrom = "all" | "uncategorized" | number;

export type FilterNode =
    | { kind: "group"; op: "and" | "or"; items: FilterNode[]; without?: boolean }
    | { kind: "tag"; id: number; without?: boolean }
    | { kind: "count"; op: "<" | "=" | ">"; n: number; from: CountFrom; without?: boolean };

type Sql = { sql: string; params: unknown[] };

const MAX_DEPTH = 20;
const MAX_NODES = 500;

/**
 * A filter tree from the renderer, checked: right shape, integer ids and
 * counts, bounded size. Unknown keys are dropped. Throws when malformed;
 * null/undefined is no filter.
 */
export function validateFilter(value: unknown): FilterNode | null {
    if (value == null) return null;
    let nodes = 0;
    const walk = (v: unknown, depth: number): FilterNode => {
        if (++nodes > MAX_NODES) throw new Error("Filter is too large");
        if (depth > MAX_DEPTH) throw new Error("Filter is nested too deeply");
        if (typeof v !== "object" || v === null) throw new Error("Bad filter node");
        const o = v as Record<string, unknown>;
        const without = o.without === true ? { without: true } : {};
        if (o.kind === "group") {
            if (o.op !== "and" && o.op !== "or") throw new Error("Bad group op");
            if (!Array.isArray(o.items)) throw new Error("Bad group items");
            return {
                kind: "group",
                op: o.op,
                items: o.items.map((i) => walk(i, depth + 1)),
                ...without,
            };
        }
        if (o.kind === "tag") {
            if (!Number.isInteger(o.id)) throw new Error("Bad tag id");
            return { kind: "tag", id: o.id as number, ...without };
        }
        if (o.kind === "count") {
            if (o.op !== "<" && o.op !== "=" && o.op !== ">") throw new Error("Bad count op");
            if (!Number.isInteger(o.n) || (o.n as number) < 0) throw new Error("Bad count");
            const from = o.from;
            if (from !== "all" && from !== "uncategorized" && !Number.isInteger(from)) {
                throw new Error("Bad count category");
            }
            return { kind: "count", op: o.op, n: o.n as number, from: from as CountFrom, ...without };
        }
        throw new Error("Bad filter node");
    };
    return walk(value, 0);
}

/** Files whose tag count (in scope) passes `having`, e.g. ">= 3". */
function countedFiles(from: CountFrom, having: string, n: number): Sql {
    const scope =
        from === "all" ? "" : from === "uncategorized" ? "WHERE t.category_id IS NULL" : "WHERE t.category_id = ?";
    return {
        sql: `SELECT eft.file_id FROM file_effective_tags eft
              JOIN tags t ON t.id = eft.tag_id
              ${scope}
              GROUP BY eft.file_id
              HAVING COUNT(DISTINCT eft.tag_id) ${having} ?`,
        params: [...(typeof from === "number" ? [from] : []), n],
    };
}

// Files with no tags in scope have no rows to count, so "< n" and "= 0"
// are built as NOT IN the opposite set: that way they include them.
function countSql(node: Extract<FilterNode, { kind: "count" }>, fileCol: string): Sql {
    const { op, n, from } = node;
    let inSet: Sql;
    let negate: boolean;
    if (op === ">") {
        inSet = countedFiles(from, ">", n);
        negate = false;
    } else if (op === "<") {
        if (n <= 0) return { sql: "0", params: [] };
        inSet = countedFiles(from, ">=", n);
        negate = true;
    } else if (n === 0) {
        inSet = countedFiles(from, ">=", 1);
        negate = true;
    } else {
        inSet = countedFiles(from, "=", n);
        negate = false;
    }
    return { sql: `${fileCol} ${negate ? "NOT IN" : "IN"} (${inSet.sql})`, params: inSet.params };
}

function nodeSql(node: FilterNode, fileCol: string): Sql | null {
    let out: Sql | null;
    if (node.kind === "tag") {
        out = {
            sql: `${fileCol} IN (SELECT file_id FROM file_effective_tags WHERE tag_id = ?)`,
            params: [node.id],
        };
    } else if (node.kind === "count") {
        out = countSql(node, fileCol);
    } else {
        const parts = node.items
            .map((i) => nodeSql(i, fileCol))
            .filter((p): p is Sql => p !== null);
        out =
            parts.length === 0
                ? null
                : {
                      sql: `(${parts.map((p) => p.sql).join(node.op === "and" ? " AND " : " OR ")})`,
                      params: parts.flatMap((p) => p.params),
                  };
    }
    if (out && node.without) out = { sql: `NOT (${out.sql})`, params: out.params };
    return out;
}

/**
 * A WHERE fragment matching files that pass the filter, or null when there's
 * no filter (null, or only empty groups). `fileCol` is the file id column
 * of the outer query.
 */
export function filterSql(filter: FilterNode | null | undefined, fileCol = "f.id"): Sql | null {
    return filter ? nodeSql(filter, fileCol) : null;
}

/** Tag and category ids a filter refers to. */
export function filterRefs(filter: FilterNode | null): { tagIds: Set<number>; categoryIds: Set<number> } {
    const tagIds = new Set<number>();
    const categoryIds = new Set<number>();
    const walk = (n: FilterNode) => {
        if (n.kind === "tag") tagIds.add(n.id);
        else if (n.kind === "count") {
            if (typeof n.from === "number") categoryIds.add(n.from);
        } else n.items.forEach(walk);
    };
    if (filter) walk(filter);
    return { tagIds, categoryIds };
}

/** The filter with tag `from` replaced by `to` (a tag merge). */
export function replaceTagInFilter(filter: FilterNode, from: number, to: number): FilterNode {
    if (filter.kind === "tag") return filter.id === from ? { ...filter, id: to } : filter;
    if (filter.kind === "count") return filter;
    return { ...filter, items: filter.items.map((i) => replaceTagInFilter(i, from, to)) };
}
