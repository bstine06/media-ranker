// main/feeds.ts
// Saved tag filters ("feeds"), recent filters, and the live match count the
// filter builder shows. Trees are stored as JSON (see tagFilter.ts); they're
// validated on the way in and on the way out.

import { getDb, folderLikePattern } from "./db";
import { filterSql, filterRefs, validateFilter, type FilterNode } from "./tagFilter";

export interface Feed {
    id: number;
    name: string;
    tree: FilterNode;
}

export interface FeedHistoryEntry {
    id: number;
    /** Set when the entry is a saved feed: its name and tree are the feed's current ones. */
    feedId: number | null;
    name: string | null;
    tree: FilterNode;
}

/** Recent filters kept per library. */
const HISTORY_LIMIT = 20;

function parseTree(json: string): FilterNode | null {
    try {
        return validateFilter(JSON.parse(json));
    } catch {
        return null;
    }
}

/** A tree from the renderer as stored JSON, or an error. */
function treeJson(tree: unknown): string {
    const valid = validateFilter(tree);
    if (!valid) throw new Error("A feed needs a filter.");
    return JSON.stringify(valid);
}

export function listFeeds(): Feed[] {
    const rows = getDb()
        .prepare(`SELECT id, name, tree FROM feeds ORDER BY order_index, name COLLATE NOCASE`)
        .all() as { id: number; name: string; tree: string }[];
    return rows.flatMap((r) => {
        const tree = parseTree(r.tree);
        return tree ? [{ id: r.id, name: r.name, tree }] : [];
    });
}

type FeedResult = { feed: Feed } | { error: string };

function nameError(name: string, exceptId: number | null): string | null {
    if (!name) return "A feed needs a name.";
    const clash = getDb()
        .prepare(`SELECT id FROM feeds WHERE name = ? COLLATE NOCASE AND id IS NOT ?`)
        .get(name, exceptId);
    return clash ? "A feed with that name already exists." : null;
}

export function createFeed(name: string, tree: unknown): FeedResult {
    const trimmed = name.trim();
    const err = nameError(trimmed, null);
    if (err) return { error: err };
    const json = treeJson(tree);
    const db = getDb();
    const { maxOrder } = db
        .prepare(`SELECT COALESCE(MAX(order_index), -1) AS maxOrder FROM feeds`)
        .get() as { maxOrder: number };
    const { lastInsertRowid } = db
        .prepare(`INSERT INTO feeds (name, tree, order_index) VALUES (?, ?, ?)`)
        .run(trimmed, json, maxOrder + 1);
    return { feed: { id: Number(lastInsertRowid), name: trimmed, tree: JSON.parse(json) } };
}

/** Overwrites a saved feed's filter. */
export function updateFeedTree(id: number, tree: unknown): void {
    getDb().prepare(`UPDATE feeds SET tree = ? WHERE id = ?`).run(treeJson(tree), id);
}

export function renameFeed(id: number, name: string): { ok: true } | { error: string } {
    const trimmed = name.trim();
    const err = nameError(trimmed, id);
    if (err) return { error: err };
    getDb().prepare(`UPDATE feeds SET name = ? WHERE id = ?`).run(trimmed, id);
    return { ok: true };
}

/** Deletes a feed; its history entries go with it (ON DELETE CASCADE). */
export function deleteFeed(id: number): void {
    getDb().prepare(`DELETE FROM feeds WHERE id = ?`).run(id);
}

export function getFeedHistory(): FeedHistoryEntry[] {
    const rows = getDb()
        .prepare(
            `SELECT h.id, h.feed_id, f.name, COALESCE(f.tree, h.tree) AS tree
             FROM feed_history h LEFT JOIN feeds f ON f.id = h.feed_id
             ORDER BY h.used_at DESC, h.id DESC`,
        )
        .all() as { id: number; feed_id: number | null; name: string | null; tree: string | null }[];
    return rows.flatMap((r) => {
        const tree = r.tree ? parseTree(r.tree) : null;
        return tree ? [{ id: r.id, feedId: r.feed_id, name: r.name, tree }] : [];
    });
}

/**
 * Puts a just-applied filter at the top of the history: a saved feed (by
 * id) or an unsaved tree. A matching entry moves up rather than repeating.
 */
export function pushFeedHistory(entry: { feedId: number } | { tree: unknown }): void {
    const db = getDb();
    db.transaction(() => {
        if ("feedId" in entry) {
            if (!Number.isInteger(entry.feedId)) return;
            db.prepare(`DELETE FROM feed_history WHERE feed_id = ?`).run(entry.feedId);
            db.prepare(`INSERT INTO feed_history (feed_id) VALUES (?)`).run(entry.feedId);
        } else {
            const json = treeJson(entry.tree);
            db.prepare(`DELETE FROM feed_history WHERE tree = ?`).run(json);
            db.prepare(`INSERT INTO feed_history (tree) VALUES (?)`).run(json);
        }
        db.prepare(
            `DELETE FROM feed_history WHERE id NOT IN (
                SELECT id FROM feed_history ORDER BY used_at DESC, id DESC LIMIT ?)`,
        ).run(HISTORY_LIMIT);
    })();
}

/** Names of saved feeds that use a tag or a category (warned about before deleting it). */
export function feedsUsing(ref: { tagId: number } | { categoryId: number }): string[] {
    return listFeeds()
        .filter((f) => {
            const refs = filterRefs(f.tree);
            return "tagId" in ref ? refs.tagIds.has(ref.tagId) : refs.categoryIds.has(ref.categoryId);
        })
        .map((f) => f.name);
}

/**
 * How many active files a filter matches: in the whole library, and within
 * the selected folders (null when none are selected).
 */
export function countFilter(
    tree: FilterNode | null,
    folderPrefixes: string[] | null,
): { matches: number; total: number; inFolders: number | null } {
    const db = getDb();
    const filter = filterSql(tree);
    const where = filter ? `AND ${filter.sql}` : "";
    const params = filter ? filter.params : [];
    const count = (extra: string, extraParams: unknown[]): number =>
        (
            db
                .prepare(`SELECT COUNT(*) AS n FROM files f WHERE f.status = 'active' ${extra}`)
                .get(...extraParams) as { n: number }
        ).n;

    const total = count("", []);
    const matches = filter ? count(where, params) : total;
    let inFolders: number | null = null;
    if (folderPrefixes && folderPrefixes.length > 0) {
        const folderSql = `AND (${folderPrefixes.map(() => "f.path LIKE ? ESCAPE '\\'").join(" OR ")})`;
        inFolders = count(`${folderSql} ${where}`, [...folderPrefixes.map(folderLikePattern), ...params]);
    }
    return { matches, total, inFolders };
}
