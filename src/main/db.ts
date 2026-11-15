import Database from "better-sqlite3";
import { basename, join } from "path";
import { statSync } from "fs";
import { filterSql, validateFilter, replaceTagInFilter, type FilterNode } from "./tagFilter";

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface DbFile {
    id: number;
    content_hash: string;
    path: string;
    filename: string;
    media_type: "photo" | "gif" | "video";
    elo_score: number;
    comparison_count: number;
    date_indexed: string;
    mtime: number;
    size: number;
    status: "active" | "missing";
    missing_since: string | null;
    folder_id?: number | null;
}

export interface DbFolder {
    id: number;
    path: string;
    name: string;
    profile_image_hash: string | null;
    date_added: string;
}

export interface DbTag {
    id: number;
    name: string;
    category_id: number | null;
    /** Position within its category (Tag Manager, quick tags). */
    order_index: number;
    /** 1: offered in Sweep (if its category is too). */
    sweep: number;
}

export interface DbTagCategory {
    id: number;
    name: string;
    color: string;
    icon: string;
    order_index: number;
    /** 1: its tags can be offered in Sweep (0 overrides theirs). */
    sweep: number;
}

export interface DbMetadataField {
    id: number;
    name: string;
    type: "string" | "number" | "date" | "url";
}

export interface DbFolderMetadata {
    id: number;
    folder_id: number;
    field_id: number;
    value: string;
}

export interface DbComparison {
    id: number;
    winner_id: number;
    loser_id: number;
    domain_path: string;
    timestamp: string;
    winner_score_before: number | null;
    loser_score_before: number | null;
}

export interface DbFolderMetadata {
    key: string;
    value: string;
    type: "string" | "number" | "date" | "url";
}

// ── Init ─────────────────────────────────────────────────────────────────────

let db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (!db) throw new Error("Database not initialized. Call initDb() first.");
    return db;
}

export function initDb(rootPath: string): Database.Database {
    const dbPath = join(rootPath, "_media_index.db");

    if (db && (db as any).name === dbPath) return db;
    if (db) {
        db.close();
        db = null;
    }

    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // ── Base schema ────────────────────────────────────────────────────────

    db.exec(`
        CREATE TABLE IF NOT EXISTS tag_categories (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT    NOT NULL UNIQUE,
            color TEXT   NOT NULL,
            icon  TEXT   NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL UNIQUE,
            category_id INTEGER REFERENCES tag_categories(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS metadata_fields (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT    NOT NULL UNIQUE,
            type TEXT    NOT NULL DEFAULT 'string'
                CHECK(type IN ('string', 'number', 'date', 'url'))
        );

        CREATE TABLE IF NOT EXISTS folders (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            path               TEXT    NOT NULL UNIQUE,
            name               TEXT    NOT NULL,
            profile_image_hash TEXT,
            date_added         TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS folder_metadata (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            field_id  INTEGER NOT NULL REFERENCES metadata_fields(id) ON DELETE CASCADE,
            value     TEXT    NOT NULL,
            UNIQUE (folder_id, field_id)
        );

        CREATE TABLE IF NOT EXISTS folder_tags (
            folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (folder_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS files (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash     TEXT    NOT NULL UNIQUE,
            path             TEXT    NOT NULL,
            filename         TEXT    NOT NULL,
            media_type       TEXT    NOT NULL CHECK(media_type IN ('photo', 'gif', 'video')),
            elo_score        REAL    NOT NULL DEFAULT 1000,
            comparison_count INTEGER NOT NULL DEFAULT 0,
            date_indexed     TEXT    NOT NULL DEFAULT (datetime('now')),
            mtime            INTEGER NOT NULL DEFAULT 0,
            size             INTEGER NOT NULL DEFAULT 0,
            status           TEXT    NOT NULL DEFAULT 'active'
                CHECK(status IN ('active', 'missing')),
            missing_since    TEXT,
            folder_id        INTEGER REFERENCES folders(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS file_tags (
            file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (file_id, tag_id)
        );

        -- "kitten" implies "cat": every file or folder tagged kitten also
        -- has cat (inherited). Never cyclic (checked when a link is added).
        CREATE TABLE IF NOT EXISTS tag_implications (
            tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            implies_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (tag_id, implies_id),
            CHECK (tag_id != implies_id)
        );

        -- Every tag each tag implies, through chains (kitten → cat → animal
        -- gives kitten: cat, animal). Derived from tag_implications by
        -- rebuildTagImplied(); never edited directly.
        CREATE TABLE IF NOT EXISTS tag_implied (
            tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            implied_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (tag_id, implied_id)
        );

        CREATE TABLE IF NOT EXISTS comparisons (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            winner_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            loser_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            domain_path TEXT    NOT NULL,
            timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        -- How much each file has been checked for each tag, for coverage.
        -- seconds: time on screen in Sweep with that tag up (the threshold
        -- for a "no" is applied when reading). rejected: the user removed
        -- that tag from the file. passed: stepped past it untagged in a
        -- Sweep pass. rejected and passed are firm noes; seconds are soft.
        -- A yes isn't stored: it's having the tag.
        CREATE TABLE IF NOT EXISTS tag_checks (
            file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            tag_id     INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
            seconds    REAL    NOT NULL DEFAULT 0,
            rejected   INTEGER NOT NULL DEFAULT 0,
            passed     INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (file_id, tag_id)
        );

        -- Saved tag filters ("feeds"), as JSON trees (see tagFilter.ts).
        CREATE TABLE IF NOT EXISTS feeds (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL UNIQUE,
            tree        TEXT    NOT NULL,
            order_index INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        -- Filters applied recently, newest first by used_at: either a saved
        -- feed (feed_id) or an unsaved tree. See feeds.ts.
        CREATE TABLE IF NOT EXISTS feed_history (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
            tree    TEXT,
            used_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_files_hash        ON files(content_hash);
        CREATE INDEX IF NOT EXISTS idx_files_path        ON files(path);
        CREATE INDEX IF NOT EXISTS idx_files_folder      ON files(folder_id);
        CREATE INDEX IF NOT EXISTS idx_file_tags_file    ON file_tags(file_id);
        CREATE INDEX IF NOT EXISTS idx_file_tags_tag     ON file_tags(tag_id);
        CREATE INDEX IF NOT EXISTS idx_folder_tags_folder ON folder_tags(folder_id);
        CREATE INDEX IF NOT EXISTS idx_folder_tags_tag   ON folder_tags(tag_id);
        CREATE INDEX IF NOT EXISTS idx_tags_category     ON tags(category_id);
        CREATE INDEX IF NOT EXISTS idx_tag_implications_implies ON tag_implications(implies_id);
        CREATE INDEX IF NOT EXISTS idx_tag_implied_implied ON tag_implied(implied_id);
        CREATE INDEX IF NOT EXISTS idx_tag_checks_tag    ON tag_checks(tag_id);
    `);

    // ── Migrations (safe to run on every startup) ──────────────────────────

    runMigrations(db);
    createViews(db);
    // Cheap, and repairs a stale table (an older version may have deleted a
    // tag in the middle of a chain).
    rebuildTagImplied();

    // Data migrations (see SCHEMA_VERSION). They delete rows, so the first
    // time they run the database is backed up first. If the backup can't be
    // written (e.g. a full disk), they wait for a later open: the library
    // still opens, and tag reads are correct either way.
    const version = db.pragma("user_version", { simple: true }) as number;
    const migrate =
        version >= SCHEMA_VERSION || backupDb(db, rootPath, "pre-migration");

    // Only top-level folders are collections. Older versions of the watcher
    // made rows for every subfolder; the empty ones are dropped. Ones that
    // carry tags, metadata or a profile image (older versions let you open a
    // subfolder and edit it) are kept untouched.
    db.exec(`
        DELETE FROM folders
        WHERE instr(path, '/') > 0
          AND profile_image_hash IS NULL
          AND id NOT IN (SELECT folder_id FROM folder_tags)
          AND id NOT IN (SELECT folder_id FROM folder_metadata)
    `);
    // Both idempotent and cheap, so they also run on every open to repair
    // anything that drifted (e.g. a subfolder moved in Finder).
    normalizeFolderIds();
    if (migrate) {
        // Version 2: tags differing only by case/spaces become one tag.
        if (version < 2) mergeCaseDuplicateTags(db);
        dropTagsCoveredByInheritance();
        if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }

    return db;
}

// Data migrations done so far (PRAGMA user_version). 1: inherited folder
// tags. 2: merged case-duplicate tags.
const SCHEMA_VERSION = 2;

// Copies the database next to it, before a migration that deletes data.
// Never overwrites an earlier backup. Returns false if it couldn't be made.
function backupDb(db: Database.Database, rootPath: string, label: string): boolean {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(rootPath, `_media_index.${label}.${stamp}.db`);
    try {
        db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        return true;
    } catch (err) {
        console.error("Database backup failed; migration postponed:", err);
        return false;
    }
}

// A file's tags are its own (file_tags), its folder's (folder_tags, through
// files.folder_id), and every tag those imply (tag_implied), combined at
// query time. A tag is never both the file's own and inherited: an own copy
// of an inherited tag is dropped (dropTagsCoveredByInheritance).
// `source`: 0 own, 1 from the folder, 2 implied by another tag. `inherited`
// is 1 for both kinds of inherited tag. A tag can appear more than once.
function createViews(db: Database.Database): void {
    db.exec(`
        DROP VIEW IF EXISTS file_effective_tags;
        CREATE VIEW file_effective_tags AS
            SELECT file_id, tag_id, 0 AS source, 0 AS inherited FROM file_tags
            UNION ALL
            SELECT f.id, ft.tag_id, 1, 1 FROM files f
            JOIN folder_tags ft ON ft.folder_id = f.folder_id
            UNION ALL
            SELECT ft.file_id, ti.implied_id, 2, 1 FROM file_tags ft
            JOIN tag_implied ti ON ti.tag_id = ft.tag_id
            UNION ALL
            SELECT f.id, ti.implied_id, 2, 1 FROM files f
            JOIN folder_tags fo ON fo.folder_id = f.folder_id
            JOIN tag_implied ti ON ti.tag_id = fo.tag_id;
    `);
}

// Every file belongs to its top-level folder ("cats/kittens/a.jpg" is in
// "cats"); files in the library root belong to none. Fixes any folder_id
// that disagrees, e.g. after a subfolder was moved between folders in Finder.
export function normalizeFolderIds(): void {
    const topFolder = `(
        SELECT fo.id FROM folders fo
        WHERE instr(files.path, '/') > 0
          AND fo.path = substr(files.path, 1, instr(files.path, '/') - 1)
    )`;
    getDb()
        .prepare(
            `UPDATE files SET folder_id = ${topFolder}
             WHERE folder_id IS NOT ${topFolder}`,
        )
        .run();
}

// The inheritance rule: a tag a file inherits (from its folder, or implied
// by another of its tags) is never also the file's own, so any own copy is
// deleted. Likewise a folder doesn't keep a tag its other tags imply.
// Pass a file or folder to only check that one (a folder: its files too).
export function dropTagsCoveredByInheritance(
    scope: { fileId?: number; folderId?: number } = {},
): void {
    const db = getDb();
    const fileScope =
        scope.fileId != null
            ? { sql: "AND file_tags.file_id = ?", params: [scope.fileId] }
            : scope.folderId != null
              ? {
                    sql: "AND file_tags.file_id IN (SELECT id FROM files WHERE folder_id = ?)",
                    params: [scope.folderId],
                }
              : { sql: "", params: [] };
    db.transaction(() => {
        db.prepare(
            `DELETE FROM file_tags
             WHERE (
                 EXISTS (
                     SELECT 1 FROM files f
                     JOIN folder_tags fo ON fo.folder_id = f.folder_id
                     WHERE f.id = file_tags.file_id AND fo.tag_id = file_tags.tag_id
                 )
                 OR EXISTS (
                     SELECT 1 FROM tag_implied ti
                     JOIN file_tags b ON b.tag_id = ti.tag_id
                     WHERE ti.implied_id = file_tags.tag_id
                       AND b.file_id = file_tags.file_id
                 )
                 OR EXISTS (
                     SELECT 1 FROM tag_implied ti
                     JOIN folder_tags fo ON fo.tag_id = ti.tag_id
                     JOIN files f ON f.folder_id = fo.folder_id
                     WHERE ti.implied_id = file_tags.tag_id
                       AND f.id = file_tags.file_id
                 )
             ) ${fileScope.sql}`,
        ).run(...fileScope.params);
        if (scope.fileId == null) {
            db.prepare(
                `DELETE FROM folder_tags
                 WHERE EXISTS (
                     SELECT 1 FROM tag_implied ti
                     JOIN folder_tags b ON b.tag_id = ti.tag_id
                     WHERE ti.implied_id = folder_tags.tag_id
                       AND b.folder_id = folder_tags.folder_id
                 ) ${scope.folderId != null ? "AND folder_tags.folder_id = ?" : ""}`,
            ).run(...(scope.folderId != null ? [scope.folderId] : []));
        }
    })();
}

function runMigrations(db: Database.Database): void {
    const tableNames = new Set(
        (
            db
                .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
                .all() as { name: string }[]
        ).map((r) => r.name),
    );

    // Migration 1: old string-based tags table → new id-based tags + file_tags
    //
    // Old schema had: tags (file_id INTEGER, tag TEXT, PRIMARY KEY (file_id, tag))
    // New schema has: tags (id, name, category_id) + file_tags (file_id, tag_id)
    //
    // We detect the old schema by checking for a 'tag' column on the tags table,
    // which does not exist in the new schema.
    if (tableNames.has("tags")) {
        const tagCols = new Set(
            (
                db.prepare(`PRAGMA table_info(tags)`).all() as {
                    name: string;
                }[]
            ).map((c) => c.name),
        );

        if (tagCols.has("tag") && !tagCols.has("name")) {
            db.transaction(() => {
                // Collect all distinct tag strings from the old table
                const oldTags = db
                    .prepare(`SELECT DISTINCT tag FROM tags`)
                    .all() as { tag: string }[];

                // Collect all old (file_id, tag) pairs
                const oldFileTags = db
                    .prepare(`SELECT file_id, tag FROM tags`)
                    .all() as { file_id: number; tag: string }[];

                // Drop old tags table and recreate under new schema
                db.exec(`DROP TABLE tags`);
                db.exec(`
                    CREATE TABLE tags (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        name        TEXT    NOT NULL UNIQUE,
                        category_id INTEGER REFERENCES tag_categories(id) ON DELETE SET NULL
                    );
                    CREATE TABLE IF NOT EXISTS file_tags (
                        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                        tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                        PRIMARY KEY (file_id, tag_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_file_tags_file ON file_tags(file_id);
                    CREATE INDEX IF NOT EXISTS idx_file_tags_tag  ON file_tags(tag_id);
                    CREATE INDEX IF NOT EXISTS idx_tags_category  ON tags(category_id);
                `);

                const insertTag = db.prepare(
                    `INSERT OR IGNORE INTO tags (name) VALUES (?)`,
                );
                const getTagId = db.prepare(
                    `SELECT id FROM tags WHERE name = ?`,
                );
                const insertFileTag = db.prepare(
                    `INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)`,
                );

                // Re-insert all distinct tag names
                for (const { tag } of oldTags) {
                    insertTag.run(tag);
                }

                // Re-insert all file→tag relationships
                for (const { file_id, tag } of oldFileTags) {
                    const row = getTagId.get(tag) as { id: number } | undefined;
                    if (row) insertFileTag.run(file_id, row.id);
                }
            })();
        }
    }

    // Migration 2: add folder_id to files if missing
    const fileCols = new Set(
        (
            db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[]
        ).map((c) => c.name),
    );

    if (!fileCols.has("folder_id")) {
        db.exec(
            `ALTER TABLE files ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL`,
        );
        db.exec(
            `CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)`,
        );
    }

    // Migration 3: add status/missing_since to files if missing (carried over
    // from previous migration logic)
    if (!fileCols.has("status")) {
        db.exec(
            `ALTER TABLE files ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'missing'))`,
        );
    }
    if (!fileCols.has("missing_since")) {
        db.exec(`ALTER TABLE files ADD COLUMN missing_since TEXT`);
    }

    if (!fileCols.has("folder_id")) {
        db.pragma("foreign_keys = OFF");
        db.exec(
            `ALTER TABLE files ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL`,
        );
        db.exec(
            `CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)`,
        );
        db.pragma("foreign_keys = ON");
    }

    // Migration 4: add composite indexes for tag usage queries
    const existingIndexes = new Set(
        (
            db
                .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
                .all() as { name: string }[]
        ).map((r) => r.name),
    );

    if (!existingIndexes.has("idx_files_folder_status")) {
        db.exec(
            `CREATE INDEX idx_files_folder_status ON files(folder_id, status)`,
        );
    }
    if (!existingIndexes.has("idx_files_status")) {
        db.exec(`CREATE INDEX idx_files_status ON files(status)`);
    }

    // Migration 5: add color and icon columns to tag_categories if missing
    const tagCategoryCols = new Set(
        (
            db.prepare(`PRAGMA table_info(tag_categories)`).all() as {
                name: string;
            }[]
        ).map((c) => c.name),
    );

    if (!tagCategoryCols.has("color")) {
        db.exec(`ALTER TABLE tag_categories ADD COLUMN color TEXT`);
    }
    if (!tagCategoryCols.has("icon")) {
        db.exec(`ALTER TABLE tag_categories ADD COLUMN icon TEXT`);
    }

    // Migration 6: add order_index to tag_categories if missing
    const tagCategoryCols2 = new Set(
        (
            db.prepare(`PRAGMA table_info(tag_categories)`).all() as {
                name: string;
            }[]
        ).map((c) => c.name),
    );
    if (!tagCategoryCols2.has("order_index")) {
        // Fixed: was checking tagCategoryCols and "icon"
        db.exec(
            `ALTER TABLE tag_categories ADD COLUMN order_index INTEGER DEFAULT 0`,
        );
        // Initialize order_index based on existing IDs for deterministic ordering
        db.exec(
            `UPDATE tag_categories SET order_index = id WHERE order_index = 0`,
        );
    }

    // Migration 6b: quick tags. Categories can be left out of the quick tag
    // bar, and tags get an order within their category (the bar's hotkeys
    // follow it). Existing tags start alphabetical, the order they showed in.
    const categoryCols3 = new Set(
        (
            db.prepare(`PRAGMA table_info(tag_categories)`).all() as {
                name: string;
            }[]
        ).map((c) => c.name),
    );
    // quick_tags is no longer used (Quick tags was removed); the column stays
    // so older libraries open unchanged.
    if (!categoryCols3.has("quick_tags")) {
        db.exec(
            `ALTER TABLE tag_categories ADD COLUMN quick_tags INTEGER NOT NULL DEFAULT 1`,
        );
    }
    const tagCols2 = new Set(
        (
            db.prepare(`PRAGMA table_info(tags)`).all() as { name: string }[]
        ).map((c) => c.name),
    );
    if (!tagCols2.has("order_index")) {
        db.transaction(() => {
            db.exec(
                `ALTER TABLE tags ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0`,
            );
            db.exec(
                `UPDATE tags SET order_index = (
                    SELECT COUNT(*) FROM tags t2
                    WHERE t2.category_id IS tags.category_id AND t2.name < tags.name
                )`,
            );
        })();
    }

    // Migration 6c: tags and categories can be left out of Sweep (its random
    // picks and tag list). Everything starts in.
    if (!new Set(
        (db.prepare(`PRAGMA table_info(tags)`).all() as { name: string }[]).map((c) => c.name),
    ).has("sweep")) {
        db.exec(`ALTER TABLE tags ADD COLUMN sweep INTEGER NOT NULL DEFAULT 1`);
    }
    if (!new Set(
        (db.prepare(`PRAGMA table_info(tag_categories)`).all() as { name: string }[]).map((c) => c.name),
    ).has("sweep")) {
        db.exec(`ALTER TABLE tag_categories ADD COLUMN sweep INTEGER NOT NULL DEFAULT 1`);
    }

    // Migration 7: remember each file's score before a comparison, so the
    // comparison can be undone. Older rows leave these NULL (not undoable).
    const comparisonCols = new Set(
        (
            db.prepare(`PRAGMA table_info(comparisons)`).all() as {
                name: string;
            }[]
        ).map((c) => c.name),
    );
    if (!comparisonCols.has("winner_score_before")) {
        db.exec(`ALTER TABLE comparisons ADD COLUMN winner_score_before REAL`);
    }
    if (!comparisonCols.has("loser_score_before")) {
        db.exec(`ALTER TABLE comparisons ADD COLUMN loser_score_before REAL`);
    }

    // Migration 8: a third kind of check, the pass no (stepped past a file
    // untagged in a Sweep pass). Kept apart from rejected so it can be
    // counted differently later without losing anything.
    if (!new Set(
        (db.prepare(`PRAGMA table_info(tag_checks)`).all() as { name: string }[]).map((c) => c.name),
    ).has("passed")) {
        db.exec(`ALTER TABLE tag_checks ADD COLUMN passed INTEGER NOT NULL DEFAULT 0`);
    }
}

export function closeDb(): void {
    if (db) {
        db.close();
        db = null;
    }
}

// ── Folder queries ───────────────────────────────────────────────────────────

export function upsertFolder(path: string, name: string): DbFolder {
    const db = getDb();
    db.prepare(
        `INSERT INTO folders (path, name) VALUES (?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name`,
    ).run(path, name);
    return db
        .prepare(`SELECT * FROM folders WHERE path = ?`)
        .get(path) as DbFolder;
}

export function getFolderByPath(path: string): DbFolder | undefined {
    return getDb().prepare(`SELECT * FROM folders WHERE path = ?`).get(path) as
        | DbFolder
        | undefined;
}

export function getAllFolders(): DbFolder[] {
    return getDb()
        .prepare(`SELECT * FROM folders ORDER BY path`)
        .all() as DbFolder[];
}

export function setFolderProfileImage(
    folderId: number,
    hash: string | null,
): void {
    getDb()
        .prepare(`UPDATE folders SET profile_image_hash = ? WHERE id = ?`)
        .run(hash, folderId);
}

export function deleteFolderByPath(path: string): void {
    getDb().prepare(`DELETE FROM folders WHERE path = ?`).run(path);
}

// A deleted folder's rows, and any left for its subfolders: its tags,
// metadata and profile image go with them (cascade).
export function deleteFolderTree(path: string): void {
    getDb()
        .prepare(`DELETE FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\\'`)
        .run(path, folderLikePattern(path));
}

export function renameFolderPath(oldPath: string, newPath: string): void {
    const db = getDb();
    db.transaction(() => {
        // Folder rows outlive their directory (so tags survive a folder being
        // moved out and back). A leftover row at the new path belongs to a
        // folder that's gone; the renamed folder replaces it.
        db.prepare(`DELETE FROM folders WHERE path = ? AND path != ?`).run(
            newPath,
            oldPath,
        );
        db.prepare(`UPDATE folders SET path = ?, name = ? WHERE path = ?`).run(
            newPath,
            basename(newPath),
            oldPath,
        );
    })();
}

// ── Folder tag queries ───────────────────────────────────────────────────────

// A folder's tags: its own, then the ones they imply (`inherited`, with
// `inheritedVia` naming an own tag that implies it).
export function getTagsForFolder(folderId: number): FileTag[] {
    const db = getDb();
    const own = db
        .prepare(
            `SELECT t.* FROM tags t
             JOIN folder_tags ft ON ft.tag_id = t.id
             WHERE ft.folder_id = ?`,
        )
        .all(folderId) as DbTag[];
    const implied = db
        .prepare(
            `SELECT t.*, MIN(via.name) AS inheritedVia FROM folder_tags fo
             JOIN tag_implied ti ON ti.tag_id = fo.tag_id
             JOIN tags t ON t.id = ti.implied_id
             JOIN tags via ON via.id = fo.tag_id
             WHERE fo.folder_id = ?
               AND ti.implied_id NOT IN (SELECT tag_id FROM folder_tags WHERE folder_id = ?)
             GROUP BY t.id`,
        )
        .all(folderId, folderId) as (DbTag & { inheritedVia: string })[];
    return [
        ...own.map((t) => ({ ...t, inherited: false })),
        ...implied.map((t) => ({ ...t, inherited: true })),
    ];
}

// No-op when the folder's other tags already imply it. Files in the folder
// now inherit the tag (and whatever it implies), so their own copies go.
export function addTagToFolder(folderId: number, tagId: number): void {
    const db = getDb();
    db.transaction(() => {
        db.prepare(
            `INSERT OR IGNORE INTO folder_tags (folder_id, tag_id)
             SELECT ?, ?
             WHERE NOT EXISTS (
                 SELECT 1 FROM folder_tags fo
                 JOIN tag_implied ti ON ti.tag_id = fo.tag_id
                 WHERE fo.folder_id = ? AND ti.implied_id = ?
             )`,
        ).run(folderId, tagId, folderId, tagId);
        dropTagsCoveredByInheritance({ folderId });
    })();
}

export function removeTagFromFolder(folderId: number, tagId: number): void {
    getDb()
        .prepare(`DELETE FROM folder_tags WHERE folder_id = ? AND tag_id = ?`)
        .run(folderId, tagId);
}

export function getTagsForFolderByPath(folderPath: string): FileTag[] {
    const folder = getFolderByPath(folderPath);
    if (!folder) return [];
    return getTagsForFolder(folder.id);
}

export function removeTagFromFolderByPath(
    folderPath: string,
    tagName: string,
): void {
    const folder = getFolderByPath(folderPath);
    if (!folder) return;
    const tag = getTagByName(tagName);
    if (!tag) return;
    removeTagFromFolder(folder.id, tag.id);
}

// Counts only tags applied by hand (own or folder): implied ones would crowd
// suggestions with tags that never need clicking.
export function getMostUsedTags(folderId?: number): DbTag[] {
    const query =
        folderId != null
            ? `
            SELECT t.id, t.name, t.category_id, COUNT(DISTINCT f.id) as usage_count
            FROM tags t
            JOIN file_effective_tags ft ON ft.tag_id = t.id
            JOIN files f ON f.id = ft.file_id
            WHERE f.status = 'active'
              AND ft.source < 2
              AND f.folder_id = ?
            GROUP BY t.id
            ORDER BY usage_count DESC
          `
            : `
            SELECT t.id, t.name, t.category_id, COUNT(DISTINCT f.id) as usage_count
            FROM tags t
            JOIN file_effective_tags ft ON ft.tag_id = t.id
            JOIN files f ON f.id = ft.file_id
            WHERE f.status = 'active'
              AND ft.source < 2
            GROUP BY t.id
            ORDER BY usage_count DESC
          `;

    return getDb()
        .prepare(query)
        .all(folderId != null ? [folderId] : []) as DbTag[];
}

// Move a tracked file to a new path/folder in one go (used for in-app moves;
// the watcher is told to ignore the filesystem events). It now inherits the
// new folder's tags, and loses the old one's.
export function moveFileRecord(
    fileId: number,
    newRelativePath: string,
    newFilename: string,
    folderId: number | null,
): void {
    getDb()
        .prepare(
            `UPDATE files SET path = ?, filename = ?, folder_id = ? WHERE id = ?`,
        )
        .run(newRelativePath, newFilename, folderId, fileId);
    dropTagsCoveredByInheritance({ fileId });
}

// ── Folder metadata queries ──────────────────────────────────────────────────

export function setFolderMetadata(
    folderId: number,
    fieldId: number,
    value: string,
): void {
    getDb()
        .prepare(
            `INSERT INTO folder_metadata (folder_id, field_id, value) VALUES (?, ?, ?)
             ON CONFLICT(folder_id, field_id) DO UPDATE SET value = excluded.value`,
        )
        .run(folderId, fieldId, value);
}

export function getFolderMetadata(
    folderId: number,
): (DbFolderMetadata & { field_name: string; field_type: string })[] {
    return getDb()
        .prepare(
            `SELECT fm.*, mf.name AS field_name, mf.type AS field_type
             FROM folder_metadata fm
             JOIN metadata_fields mf ON mf.id = fm.field_id
             WHERE fm.folder_id = ?`,
        )
        .all(folderId) as (DbFolderMetadata & {
        field_name: string;
        field_type: string;
    })[];
}

export function deleteFolderMetadata(folderId: number, fieldId: number): void {
    getDb()
        .prepare(
            `DELETE FROM folder_metadata WHERE folder_id = ? AND field_id = ?`,
        )
        .run(folderId, fieldId);
}

// ── Metadata field queries ───────────────────────────────────────────────────

export function upsertMetadataField(
    name: string,
    type: DbMetadataField["type"],
): DbMetadataField {
    const db = getDb();
    db.prepare(
        `INSERT INTO metadata_fields (name, type) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET type = excluded.type`,
    ).run(name, type);
    return db
        .prepare(`SELECT * FROM metadata_fields WHERE name = ?`)
        .get(name) as DbMetadataField;
}

export function getAllMetadataFields(): DbMetadataField[] {
    return getDb()
        .prepare(`SELECT * FROM metadata_fields ORDER BY name`)
        .all() as DbMetadataField[];
}

// Path-based wrappers for IPC layer
export function getFolderMetadataByPath(
    folderPath: string,
): { key: string; value: string; type: string }[] {
    const folder = getFolderByPath(folderPath);
    if (!folder) return [];
    return getFolderMetadata(folder.id).map((f) => ({
        key: f.field_name,
        value: f.value,
        type: f.field_type,
    }));
}

export function setFolderMetadataField(
    folderPath: string,
    key: string,
    value: string,
    type: DbMetadataField["type"] = "string",
): void {
    const folder = upsertFolder(folderPath, basename(folderPath));
    const field = upsertMetadataField(key, type);
    setFolderMetadata(folder.id, field.id, value);
}

export function deleteFolderMetadataField(
    folderPath: string,
    key: string,
): void {
    const folder = getFolderByPath(folderPath);
    if (!folder) return;
    const field = getDb()
        .prepare(`SELECT * FROM metadata_fields WHERE name = ?`)
        .get(key) as DbMetadataField | undefined;
    if (!field) return;
    deleteFolderMetadata(folder.id, field.id);
}

export function getAllMetadataFieldNames(): string[] {
    return getAllMetadataFields().map((f) => f.name);
}

export function setFolderProfileImageByPath(
    folderPath: string,
    hash: string | null,
): void {
    const folder = getFolderByPath(folderPath);
    if (!folder) return;
    setFolderProfileImage(folder.id, hash);
}

// ── Tag queries ──────────────────────────────────────────────────────────────

// Tag names are compared lowercased and trimmed ("Cat " is "cat").
export function normalizeTagName(name: string): string {
    return name.trim().toLowerCase();
}

// The order_index that puts a tag last in category `?`.
const nextTagOrder = `(SELECT COALESCE(MAX(order_index), -1) + 1 FROM tags WHERE category_id IS ?)`;

export function upsertTag(name: string, categoryId?: number | null): DbTag {
    const db = getDb();
    name = normalizeTagName(name);

    const existing = db
        .prepare(`SELECT * FROM tags WHERE name = ?`)
        .get(name) as DbTag | undefined;
    if (existing) {
        if (categoryId !== undefined && categoryId !== existing.category_id) {
            setTagCategory(existing.id, categoryId);
        }
    } else {
        // New tags go last in their category.
        db.prepare(
            `INSERT INTO tags (name, category_id, order_index)
             VALUES (?, ?, ${nextTagOrder})`,
        ).run(name, categoryId ?? null, categoryId ?? null);
    }

    return db.prepare(`SELECT * FROM tags WHERE name = ?`).get(name) as DbTag;
}

export type UpdateTagResult =
    | { ok: true; tag: DbTag }
    // Another tag already has that name: nothing was changed. The renderer
    // asks whether to merge (they may not mean the same thing).
    | { ok: false; conflict: DbTag & TagUsage };

export function updateTag(
    id: number,
    name: string,
    categoryId: number | null,
): UpdateTagResult {
    const db = getDb();
    name = normalizeTagName(name);
    const other = db
        .prepare(`SELECT * FROM tags WHERE name = ? AND id != ?`)
        .get(name, id) as DbTag | undefined;
    if (other) return { ok: false, conflict: { ...other, ...getTagUsage(other.id) } };

    db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(name, id);
    setTagCategory(id, categoryId);
    const tag = db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as DbTag;
    return { ok: true, tag };
}

export interface TagUsage {
    /** Active files that have the tag (their own or from their folder). */
    files: number;
    /** Folders that give the tag to their files. */
    folders: number;
}

export function getTagUsage(tagId: number): TagUsage {
    const db = getDb();
    const files = (
        db
            .prepare(
                `SELECT COUNT(DISTINCT eft.file_id) AS n FROM file_effective_tags eft
                 JOIN files f ON f.id = eft.file_id
                 WHERE eft.tag_id = ? AND f.status = 'active'`,
            )
            .get(tagId) as { n: number }
    ).n;
    const folders = (
        db
            .prepare(`SELECT COUNT(*) AS n FROM folder_tags WHERE tag_id = ?`)
            .get(tagId) as { n: number }
    ).n;
    return { files, folders };
}

export type MergeTagsResult = { ok: true } | { ok: false; error: string };

// Every file and folder tagged `sourceId` gets `targetId` instead, and the
// source tag is deleted. The target keeps its name and category, and takes
// over the source's links. Refused (nothing changes) when the links would
// then go round in a circle.
export function mergeTags(sourceId: number, targetId: number): MergeTagsResult {
    if (sourceId === targetId) return { ok: true };
    const db = getDb();
    // A chain between the two through some other tag (source → x → target)
    // would become target → x → target. A direct link just disappears.
    const between = db
        .prepare(
            `SELECT t.name FROM tag_implied a
             JOIN tag_implied b ON b.tag_id = a.implied_id
             JOIN tags t ON t.id = a.implied_id
             WHERE (a.tag_id = ? AND b.implied_id = ?)
                OR (a.tag_id = ? AND b.implied_id = ?)
             LIMIT 1`,
        )
        .get(sourceId, targetId, targetId, sourceId) as
        | { name: string }
        | undefined;
    if (between) {
        return {
            ok: false,
            error:
                `They're linked through "${between.name}", so merging them ` +
                `would make a tag imply itself. Remove one of those links first.`,
        };
    }
    db.transaction(() => {
        db.prepare(
            `INSERT OR IGNORE INTO tag_implications (tag_id, implies_id)
             SELECT ?, implies_id FROM tag_implications
             WHERE tag_id = ? AND implies_id != ?`,
        ).run(targetId, sourceId, targetId);
        db.prepare(
            `INSERT OR IGNORE INTO tag_implications (tag_id, implies_id)
             SELECT tag_id, ? FROM tag_implications
             WHERE implies_id = ? AND tag_id != ?`,
        ).run(targetId, sourceId, targetId);
        db.prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT file_id, ? FROM file_tags WHERE tag_id = ?`,
        ).run(targetId, sourceId);
        db.prepare(
            `INSERT OR IGNORE INTO folder_tags (folder_id, tag_id)
             SELECT folder_id, ? FROM folder_tags WHERE tag_id = ?`,
        ).run(targetId, sourceId);
        // Checks move too; where both have one, the larger counts (a merge
        // shouldn't add up to a "no" nobody made).
        db.prepare(
            `INSERT INTO tag_checks (file_id, tag_id, seconds, rejected, passed, updated_at)
             SELECT file_id, ?, seconds, rejected, passed, updated_at
             FROM tag_checks WHERE tag_id = ?
             ON CONFLICT (file_id, tag_id) DO UPDATE SET
                 seconds  = max(seconds, excluded.seconds),
                 rejected = max(rejected, excluded.rejected),
                 passed   = max(passed, excluded.passed)`,
        ).run(targetId, sourceId);
        // Saved and recent filters follow the merge.
        rewriteFilterTag(db, sourceId, targetId);
        db.prepare(`DELETE FROM tags WHERE id = ?`).run(sourceId); // cascades
        rebuildTagImplied();
        // A file may now have the target both as its own and inherited.
        dropTagsCoveredByInheritance();
    })();
    return { ok: true };
}

// Older versions could create tags differing only by case or spaces ("Cat",
// "cat "). Merges each such group into one tag with the normalized name:
// the one already named that way if there is one, else the oldest. It keeps
// its category, or takes the first one in the group that has one.
function mergeCaseDuplicateTags(db: Database.Database): void {
    const tags = db
        .prepare(`SELECT * FROM tags ORDER BY id`)
        .all() as DbTag[];
    const groups = new Map<string, DbTag[]>();
    for (const t of tags) {
        const key = normalizeTagName(t.name);
        groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    db.transaction(() => {
        for (const [name, group] of groups) {
            const keep = group.find((t) => t.name === name) ?? group[0];
            for (const t of group) if (t.id !== keep.id) mergeTags(t.id, keep.id);
            const categoryId =
                keep.category_id ??
                group.find((t) => t.category_id != null)?.category_id ??
                null;
            if (keep.name !== name || keep.category_id !== categoryId) {
                db.prepare(
                    `UPDATE tags SET name = ?, category_id = ? WHERE id = ?`,
                ).run(name, categoryId, keep.id);
            }
        }
    })();
}

export function getTagByName(name: string): DbTag | undefined {
    return getDb()
        .prepare(`SELECT * FROM tags WHERE name = ?`)
        .get(normalizeTagName(name)) as DbTag | undefined;
}

export function getAllTags(): DbTag[] {
    return getDb().prepare(`SELECT * FROM tags ORDER BY name`).all() as DbTag[];
}

// Moving to another category puts the tag last there.
export function setTagCategory(tagId: number, categoryId: number | null): void {
    getDb()
        .prepare(
            `UPDATE tags SET category_id = @categoryId,
                order_index = ${nextTagOrder.replace("?", "@categoryId")}
             WHERE id = @tagId AND category_id IS NOT @categoryId`,
        )
        .run({ categoryId, tagId });
}

// Whether a tag is offered in Sweep.
export function setTagSweep(tagId: number, on: boolean): void {
    getDb().prepare(`UPDATE tags SET sweep = ? WHERE id = ?`).run(on ? 1 : 0, tagId);
}

// Every tag in a category in or out of Sweep at once.
export function setCategoryTagsSweep(categoryId: number, on: boolean): void {
    getDb()
        .prepare(`UPDATE tags SET sweep = ? WHERE category_id = ?`)
        .run(on ? 1 : 0, categoryId);
}

// Puts a category's tags in this order (any tags not listed keep their
// place after them). Tags listed from another category move into it.
export function reorderTags(categoryId: number | null, tagIds: number[]): void {
    const db = getDb();
    db.transaction(() => {
        const set = db.prepare(
            `UPDATE tags SET category_id = ?, order_index = ? WHERE id = ?`,
        );
        tagIds.forEach((id, i) => set.run(categoryId, i, id));
        const rest = db
            .prepare(
                `SELECT id FROM tags WHERE category_id IS ?
                 ORDER BY order_index, name`,
            )
            .all(categoryId) as { id: number }[];
        const listed = new Set(tagIds);
        let i = tagIds.length;
        for (const { id } of rest) {
            if (!listed.has(id)) set.run(categoryId, i++, id);
        }
    })();
}

// Tag `from` becomes `to` in every saved feed and recent filter (a merge).
function rewriteFilterTag(db: Database.Database, from: number, to: number): void {
    for (const table of ["feeds", "feed_history"]) {
        const rows = db
            .prepare(`SELECT id, tree FROM ${table} WHERE tree IS NOT NULL`)
            .all() as { id: number; tree: string }[];
        for (const r of rows) {
            let tree: FilterNode | null;
            try {
                tree = validateFilter(JSON.parse(r.tree));
            } catch {
                continue;
            }
            if (!tree) continue;
            const next = JSON.stringify(replaceTagInFilter(tree, from, to));
            if (next !== r.tree) {
                db.prepare(`UPDATE ${table} SET tree = ? WHERE id = ?`).run(next, r.id);
            }
        }
    }
}

export function deleteTag(tagId: number): void {
    const db = getDb();
    db.transaction(() => {
        db.prepare(`DELETE FROM tags WHERE id = ?`).run(tagId);
        // Chains through it (kitten → it → animal) are broken now.
        rebuildTagImplied();
    })();
}

// ── Tag implication queries ──────────────────────────────────────────────────
// "kitten" implies "cat": anything tagged kitten inherits cat (see
// file_effective_tags and dropTagsCoveredByInheritance).

export interface TagImplication {
    tag_id: number;
    implies_id: number;
}

export function getTagImplications(): TagImplication[] {
    return getDb()
        .prepare(`SELECT tag_id, implies_id FROM tag_implications`)
        .all() as TagImplication[];
}

// Refills tag_implied from tag_implications. Links that go round in a
// circle can't be added, but if one ever exists its links are dropped
// rather than let every tag in it inherit (and so delete) the others.
export function rebuildTagImplied(): void {
    const db = getDb();
    const links = getTagImplications();
    const next = new Map<number, number[]>();
    for (const { tag_id, implies_id } of links) {
        next.set(tag_id, [...(next.get(tag_id) ?? []), implies_id]);
    }
    const reach = (from: number): Set<number> => {
        const seen = new Set<number>();
        const stack = [...(next.get(from) ?? [])];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            stack.push(...(next.get(id) ?? []));
        }
        return seen;
    };
    db.transaction(() => {
        const inCycle = links.filter((l) => reach(l.implies_id).has(l.tag_id));
        if (inCycle.length > 0) {
            console.error("Dropping tag links that form a cycle:", inCycle);
            const del = db.prepare(
                `DELETE FROM tag_implications WHERE tag_id = ? AND implies_id = ?`,
            );
            for (const l of inCycle) {
                del.run(l.tag_id, l.implies_id);
                next.set(
                    l.tag_id,
                    (next.get(l.tag_id) ?? []).filter((id) => id !== l.implies_id),
                );
            }
        }
        db.prepare(`DELETE FROM tag_implied`).run();
        const insert = db.prepare(
            `INSERT INTO tag_implied (tag_id, implied_id) VALUES (?, ?)`,
        );
        for (const tagId of next.keys()) {
            for (const implied of reach(tagId)) insert.run(tagId, implied);
        }
    })();
}

export type TagImplicationResult = { ok: true } | { ok: false; error: string };

function tagName(id: number): string | undefined {
    return (
        getDb().prepare(`SELECT name FROM tags WHERE id = ?`).get(id) as
            | { name: string }
            | undefined
    )?.name;
}

// Why `tagId` can't imply `impliesId`, or null if it can.
function implicationError(tagId: number, impliesId: number): string | null {
    const tag = tagName(tagId);
    const implies = tagName(impliesId);
    if (tag === undefined || implies === undefined) return "That tag no longer exists.";
    if (tagId === impliesId) return "A tag can't imply itself.";
    const circular = getDb()
        .prepare(`SELECT 1 FROM tag_implied WHERE tag_id = ? AND implied_id = ?`)
        .get(impliesId, tagId);
    if (circular) {
        return `"${implies}" already implies "${tag}", so "${tag}" can't imply "${implies}".`;
    }
    return null;
}

function linkTags(tagId: number, impliesId: number): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO tag_implications (tag_id, implies_id) VALUES (?, ?)`,
        )
        .run(tagId, impliesId);
    rebuildTagImplied();
    dropTagsCoveredByInheritance();
}

function unlinkTags(tagId: number, impliesId: number): void {
    getDb()
        .prepare(`DELETE FROM tag_implications WHERE tag_id = ? AND implies_id = ?`)
        .run(tagId, impliesId);
    rebuildTagImplied();
}

export function addTagImplication(
    tagId: number,
    impliesId: number,
): TagImplicationResult {
    const error = implicationError(tagId, impliesId);
    if (error) return { ok: false, error };
    const db = getDb();
    db.transaction(() => linkTags(tagId, impliesId))();
    return { ok: true };
}

export function removeTagImplication(tagId: number, impliesId: number): void {
    const db = getDb();
    db.transaction(() => unlinkTags(tagId, impliesId))();
}

// What adding (or removing) a link would do, for the confirm dialog. Found
// by making the change and rolling it back, so it can't disagree with what
// actually happens.
export interface TagImplicationPreview {
    /** Active files that gain the implied tag (negative: lose it). */
    files: number;
    /** Active files whose own copy becomes inherited (adding only). */
    convertedFiles: number;
    /** Folders whose own copy becomes inherited (adding only). */
    convertedFolders: number;
}

export function previewTagImplication(
    tagId: number,
    impliesId: number,
    action: "add" | "remove",
): TagImplicationPreview | { error: string } {
    if (action === "add") {
        const error = implicationError(tagId, impliesId);
        if (error) return { error };
    }
    const db = getDb();
    const count = (sql: string): number =>
        (db.prepare(sql).get(impliesId) as { n: number }).n;
    const measure = () => ({
        files: count(
            `SELECT COUNT(DISTINCT e.file_id) AS n FROM file_effective_tags e
             JOIN files f ON f.id = e.file_id
             WHERE e.tag_id = ? AND f.status = 'active'`,
        ),
        ownFiles: count(
            `SELECT COUNT(*) AS n FROM file_tags ft
             JOIN files f ON f.id = ft.file_id
             WHERE ft.tag_id = ? AND f.status = 'active'`,
        ),
        ownFolders: count(`SELECT COUNT(*) AS n FROM folder_tags WHERE tag_id = ?`),
    });
    const before = measure();
    let after = before;
    db.exec("SAVEPOINT preview_tag_implication");
    try {
        if (action === "add") linkTags(tagId, impliesId);
        else unlinkTags(tagId, impliesId);
        after = measure();
    } finally {
        db.exec("ROLLBACK TO preview_tag_implication");
        db.exec("RELEASE preview_tag_implication");
    }
    return {
        files: after.files - before.files,
        convertedFiles: before.ownFiles - after.ownFiles,
        convertedFolders: before.ownFolders - after.ownFolders,
    };
}

// ── Tag category queries ─────────────────────────────────────────────────────

export function upsertTagCategory(
    name: string,
    color: string,
    icon: string,
): DbTagCategory {
    const db = getDb();

    db.prepare(
        `
        INSERT INTO tag_categories (name, color, icon)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            color = excluded.color,
            icon = excluded.icon
    `,
    ).run(name, color, icon);

    return db
        .prepare(`SELECT * FROM tag_categories WHERE name = ?`)
        .get(name) as DbTagCategory;
}

export function getAllTagCategories(): DbTagCategory[] {
    return getDb()
        .prepare(`SELECT * FROM tag_categories ORDER BY order_index ASC, id ASC`)
        .all() as DbTagCategory[];
}

export function deleteTagCategory(categoryId: number): void {
    // Tags in this category become uncategorized via ON DELETE NULL
    getDb().prepare(`DELETE FROM tag_categories WHERE id = ?`).run(categoryId);
}

export function updateTagCategory(
    id: number,
    updates: {
        name?: string;
        color?: string | null;
        icon?: string | null;
        order_index?: number;
        sweep?: number;
    },
): DbTagCategory {
    const db = getDb();
    // Only known columns (the keys become SQL).
    const allowed = new Set(["name", "color", "icon", "order_index", "sweep"]);
    updates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowed.has(k)),
    );

    const fields = Object.entries(updates)
        .filter(([_, v]) => v !== undefined)
        .map(([k]) => `${k} = ?`);
    const values = Object.entries(updates)
        .filter(([_, v]) => v !== undefined)
        .map(([_, v]) => v);

    if (fields.length === 0)
        return db
            .prepare(`SELECT * FROM tag_categories WHERE id = ?`)
            .get(id) as DbTagCategory;

    return db
        .prepare(
            `
        UPDATE tag_categories
        SET ${fields.join(", ")}
        WHERE id = ?
        RETURNING *
    `,
        )
        .get([...values, id]) as DbTagCategory;
}

// ── File tag queries ─────────────────────────────────────────────────────────

// A tag on a file's (or folder's) tag list. `inherited`: it comes from the
// folder or is implied by another tag, so it's shown dimmed and can only be
// removed at its source. `inheritedVia`: the tag implying it, when it isn't
// from the folder.
export type FileTag = DbTag & { inherited: boolean; inheritedVia?: string };

export function getTagsForFile(fileId: number): FileTag[] {
    const db = getDb();
    const rows = db
        .prepare(
            `SELECT t.*, MAX(ft.inherited) AS inherited,
                    MIN(CASE WHEN ft.source > 0 THEN ft.source END) AS source
             FROM tags t
             JOIN file_effective_tags ft ON ft.tag_id = t.id
             WHERE ft.file_id = ?
             GROUP BY t.id`,
        )
        .all(fileId) as (DbTag & { inherited: number; source: number | null })[];
    // For implied tags: the file's own or folder tag that implies it.
    const via = new Map(
        (
            db
                .prepare(
                    `SELECT ti.implied_id AS id, MIN(t.name) AS name
                     FROM tag_implied ti
                     JOIN tags t ON t.id = ti.tag_id
                     WHERE ti.tag_id IN (
                         SELECT tag_id FROM file_tags WHERE file_id = ?
                         UNION
                         SELECT fo.tag_id FROM files f
                         JOIN folder_tags fo ON fo.folder_id = f.folder_id
                         WHERE f.id = ?
                     )
                     GROUP BY ti.implied_id`,
                )
                .all(fileId, fileId) as { id: number; name: string }[]
        ).map((r) => [r.id, r.name]),
    );
    return rows.map(({ source, ...r }) => ({
        ...r,
        inherited: r.inherited === 1,
        ...(source === 2 && via.has(r.id) ? { inheritedVia: via.get(r.id) } : {}),
    }));
}

// No-op when the file already inherits the tag. Tags the new one implies
// become inherited, so the file's own copies of them go.
export function addTagToFile(fileId: number, tagId: number): void {
    const db = getDb();
    db.transaction(() => {
        db.prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT @fileId, @tagId
             WHERE NOT EXISTS (
                 SELECT 1 FROM files f
                 JOIN folder_tags fo ON fo.folder_id = f.folder_id
                 LEFT JOIN tag_implied ti ON ti.tag_id = fo.tag_id
                 WHERE f.id = @fileId AND @tagId IN (fo.tag_id, ti.implied_id)
             )
             AND NOT EXISTS (
                 SELECT 1 FROM file_tags b
                 JOIN tag_implied ti ON ti.tag_id = b.tag_id
                 WHERE b.file_id = @fileId AND ti.implied_id = @tagId
             )`,
        ).run({ fileId, tagId });
        dropTagsCoveredByInheritance({ fileId });
    })();
}

// Removes the file's own copy of a tag (inherited tags can't be removed
// here). Taking a tag off is a deliberate "no", so it's recorded as one.
export function removeTagFromFile(fileId: number, tagId: number): void {
    const db = getDb();
    db.transaction(() => {
        const { changes } = db
            .prepare(`DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?`)
            .run(fileId, tagId);
        if (changes > 0) {
            db.prepare(
                `INSERT INTO tag_checks (file_id, tag_id, rejected) VALUES (?, ?, 1)
                 ON CONFLICT (file_id, tag_id)
                 DO UPDATE SET rejected = 1, updated_at = datetime('now')`,
            ).run(fileId, tagId);
        }
    })();
}

// Tags that often appear on the same files as `tagId` (own or inherited,
// active files only), best first. Ranked by shared² ÷ the tag's own count,
// so a tag that's on nearly everything doesn't top every list.
export function getRelatedTags(tagId: number, limit = 30): { id: number; n: number }[] {
    return getDb()
        .prepare(
            `WITH et AS (
                 SELECT DISTINCT e.file_id, e.tag_id FROM file_effective_tags e
                 JOIN files f ON f.id = e.file_id AND f.status = 'active'
             ),
             totals AS (SELECT tag_id, COUNT(*) AS total FROM et GROUP BY tag_id)
             SELECT b.tag_id AS id, COUNT(*) AS n
             FROM et a
             JOIN et b ON b.file_id = a.file_id AND b.tag_id != a.tag_id
             JOIN totals t ON t.tag_id = b.tag_id
             WHERE a.tag_id = ?
             GROUP BY b.tag_id
             ORDER BY (COUNT(*) * COUNT(*) * 1.0 / MAX(t.total)) DESC, n DESC
             LIMIT ?`,
        )
        .all(tagId, limit) as { id: number; n: number }[];
}

// Sweep: adds time each file spent on screen while this tag was up.
// Files or tags deleted meanwhile are skipped.
export function addTagCheckSeconds(
    tagId: number,
    entries: { fileId: number; seconds: number }[],
): void {
    const db = getDb();
    const upsert = db.prepare(
        `INSERT INTO tag_checks (file_id, tag_id, seconds)
         SELECT @fileId, @tagId, @seconds
         WHERE EXISTS (SELECT 1 FROM files WHERE id = @fileId)
           AND EXISTS (SELECT 1 FROM tags WHERE id = @tagId)
         ON CONFLICT (file_id, tag_id)
         DO UPDATE SET seconds = seconds + excluded.seconds,
                       updated_at = datetime('now')`,
    );
    db.transaction(() => {
        for (const { fileId, seconds } of entries) {
            if (seconds > 0) upsert.run({ fileId, tagId, seconds });
        }
    })();
}

// Conditions limiting files (alias f) to a scope: folders and/or a tag
// filter, as Sweep and Browse use them. Active files only.
export function scopeSql(
    folderPrefixes: string[] | null,
    filter: FilterNode | null,
): { sql: string; params: unknown[] } {
    const conds = [`f.status = 'active'`];
    const params: unknown[] = [];
    if (folderPrefixes && folderPrefixes.length > 0) {
        conds.push(`(${folderPrefixes.map(() => "f.path LIKE ? ESCAPE '\\'").join(" OR ")})`);
        params.push(...folderPrefixes.map(folderLikePattern));
    }
    const tagFilter = filterSql(filter);
    if (tagFilter) {
        conds.push(tagFilter.sql);
        params.push(...tagFilter.params);
    }
    return { sql: conds.join(" AND "), params };
}

// Coverage: for each tag, what's needed to count files settled yes or no,
// over the library or a scope (folders and/or a tag filter). Yes: the file
// has the tag (own or inherited). Firm no: the user took the tag off the
// file, or stepped past it untagged in a pass. Seen (a soft no): neither,
// but it was on screen in Sweep with the tag up for at least the threshold
// (a setting, 1–30 s). The threshold is applied in the renderer, so Sweep
// time comes grouped by whole second (capped at 30): a file counts as seen
// at threshold T when its bucket is ≥ T. Yes beats no; firm beats seen.
export function getTagCoverage(
    folderPrefixes: string[] | null = null,
    filter: FilterNode | null = null,
): {
    files: number;
    tags: { tagId: number; yes: number; firmNo: number; seen: [number, number][] }[];
} {
    const db = getDb();
    const scope = scopeSql(folderPrefixes, filter);
    const files = (
        db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${scope.sql}`).get(...scope.params) as {
            n: number;
        }
    ).n;
    const yes = db
        .prepare(
            `SELECT e.tag_id AS tagId, COUNT(DISTINCT e.file_id) AS n
             FROM file_effective_tags e
             JOIN files f ON f.id = e.file_id
             WHERE ${scope.sql}
             GROUP BY e.tag_id`,
        )
        .all(...scope.params) as { tagId: number; n: number }[];
    // Untagged checks: firm noes, else bucketed by seconds.
    const checks = db
        .prepare(
            `SELECT c.tag_id AS tagId,
                    CASE WHEN c.rejected = 1 OR c.passed = 1 THEN -1
                         ELSE CAST(MIN(c.seconds, 30) AS INTEGER) END AS bucket,
                    COUNT(*) AS n
             FROM tag_checks c
             JOIN files f ON f.id = c.file_id
             WHERE ${scope.sql}
               AND (c.rejected = 1 OR c.passed = 1 OR c.seconds >= 1)
               AND NOT EXISTS (
                   SELECT 1 FROM file_effective_tags e
                   WHERE e.file_id = c.file_id AND e.tag_id = c.tag_id)
             GROUP BY c.tag_id, bucket`,
        )
        .all(...scope.params) as { tagId: number; bucket: number; n: number }[];
    const yesBy = new Map(yes.map((r) => [r.tagId, r.n]));
    const firmNoBy = new Map<number, number>();
    const seenBy = new Map<number, [number, number][]>();
    for (const r of checks) {
        if (r.bucket < 0) firmNoBy.set(r.tagId, r.n);
        else seenBy.set(r.tagId, [...(seenBy.get(r.tagId) ?? []), [r.bucket, r.n]]);
    }
    const tagIds = (db.prepare(`SELECT id FROM tags`).all() as { id: number }[]).map(
        (r) => r.id,
    );
    return {
        files,
        tags: tagIds.map((tagId) => ({
            tagId,
            yes: yesBy.get(tagId) ?? 0,
            firmNo: firmNoBy.get(tagId) ?? 0,
            seen: seenBy.get(tagId) ?? [],
        })),
    };
}

// Ids of files passing a tag filter (see tagFilter.ts), any status.
export function getFileIdsByFilter(tree: FilterNode | null): number[] {
    const filter = filterSql(tree);
    if (!filter) return [];
    const rows = getDb()
        .prepare(`SELECT f.id FROM files f WHERE ${filter.sql}`)
        .all(...filter.params) as { id: number }[];
    return rows.map((r) => r.id);
}

// ── File queries ─────────────────────────────────────────────────────────────

export function upsertFile(
    file: Omit<
        DbFile,
        "id" | "elo_score" | "comparison_count" | "date_indexed"
    >,
): DbFile {
    const db = getDb();
    const existing = db
        .prepare(`SELECT * FROM files WHERE content_hash = ?`)
        .get(file.content_hash) as DbFile | undefined;

    if (existing) {
        if (
            existing.path !== file.path ||
            existing.filename !== file.filename ||
            existing.mtime !== file.mtime ||
            existing.size !== file.size ||
            existing.status !== file.status ||
            existing.folder_id !== file.folder_id
        ) {
            db.prepare(
                `UPDATE files
                 SET path = ?, filename = ?, mtime = ?, size = ?,
                     status = ?, missing_since = ?, folder_id = ?
                 WHERE content_hash = ?`,
            ).run(
                file.path,
                file.filename,
                file.mtime,
                file.size,
                file.status,
                file.missing_since,
                file.folder_id,
                file.content_hash,
            );
        }

        // It may have moved into a folder that now gives it some tags.
        dropTagsCoveredByInheritance({ fileId: existing.id });

        return { ...existing, ...file };
    }

    const result = db
        .prepare(
            `INSERT INTO files (content_hash, path, filename, media_type, mtime, size, folder_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            file.content_hash,
            file.path,
            file.filename,
            file.media_type,
            file.mtime,
            file.size,
            file.folder_id,
        );

    const inserted = db
        .prepare(`SELECT * FROM files WHERE id = ?`)
        .get(result.lastInsertRowid) as DbFile;

    return inserted;
}

export function getFileByPath(relativePath: string): DbFile | undefined {
    return getDb()
        .prepare(`SELECT * FROM files WHERE path = ? AND status = 'active'`)
        .get(relativePath) as DbFile | undefined;
}

export function getFileByHash(hash: string): DbFile | undefined {
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE content_hash = ? AND status = 'active'`,
        )
        .get(hash) as DbFile | undefined;
}

export function getFileById(fileId: number): DbFile | undefined {
    return getDb()
        .prepare(`SELECT * FROM files WHERE id = ?`)
        .get(fileId) as DbFile | undefined;
}

export function getFileByPathAny(relativePath: string): DbFile | undefined {
    return getDb()
        .prepare(`SELECT * FROM files WHERE path = ?`)
        .get(relativePath) as DbFile | undefined;
}

export function getFileByHashAny(hash: string): DbFile | undefined {
    return getDb()
        .prepare(`SELECT * FROM files WHERE content_hash = ?`)
        .get(hash) as DbFile | undefined;
}

export function updateFilePath(
    hash: string,
    newRelativePath: string,
    newFilename: string,
    mtime: number,
): void {
    getDb()
        .prepare(
            `UPDATE files SET path = ?, filename = ?, mtime = ? WHERE content_hash = ?`,
        )
        .run(newRelativePath, newFilename, mtime, hash);
}

export function getAllFiles(): DbFile[] {
    return getDb()
        .prepare(`SELECT * FROM files ORDER BY elo_score DESC`)
        .all() as DbFile[];
}

// Files sitting directly in the library folder (not in any subfolder).
export function getRootFiles(): DbFile[] {
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE status = 'active' AND instr(path, '/') = 0
             ORDER BY elo_score DESC`,
        )
        .all() as DbFile[];
}

export function countRootFiles(): number {
    return (
        getDb()
            .prepare(
                `SELECT COUNT(*) AS n FROM files WHERE status = 'active' AND instr(path, '/') = 0`,
            )
            .get() as { n: number }
    ).n;
}

export function getAllActiveFiles(): DbFile[] {
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE status = 'active' ORDER BY elo_score DESC`,
        )
        .all() as DbFile[];
}

// LIKE pattern matching everything inside a folder (not sibling folders that
// merely share a name prefix, e.g. "cats" must not match "cats2/…").
// Use with `ESCAPE '\\'`.
export function folderLikePattern(folderRelPath: string): string {
    const escaped = folderRelPath.replace(/[\\%_]/g, (c) => `\\${c}`);
    return `${escaped}/%`;
}

export function getFilesByFolder(folderRelPath: string): DbFile[] {
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE path LIKE ? ESCAPE '\\' AND status = 'active' ORDER BY elo_score DESC`,
        )
        .all(
            folderLikePattern(folderRelPath),
        ) as DbFile[];
}

export function getFilesByPathPrefix(prefix: string): DbFile[] {
    return getDb()
        .prepare(
            `SELECT * FROM files
             WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND status = 'active'`,
        )
        .all(prefix, folderLikePattern(prefix)) as DbFile[];
}

export function getUnindexedCount(): number {
    const result = getDb()
        .prepare(
            `SELECT COUNT(*) as count FROM files
             WHERE comparison_count = 0 AND status = 'active'`,
        )
        .get() as { count: number };
    return result.count;
}

export function renameFolderPaths(oldPrefix: string, newPrefix: string): void {
    const db = getDb();
    db.transaction(() => {
        db.prepare(
            `UPDATE files
             SET path = ? || substr(path, ?)
             WHERE path = ? OR path LIKE ? ESCAPE '\\'`,
        ).run(
            newPrefix,
            oldPrefix.length + 1,
            oldPrefix,
            folderLikePattern(oldPrefix),
        );
    })();
}

export function deleteFileByPath(relativePath: string): void {
    getDb().prepare(`DELETE FROM files WHERE path = ?`).run(relativePath);
}

export function updateFileFolderAndPath(
    hash: string,
    newRelativePath: string,
    newFilename: string,
    mtime: number,
    folderId: number | null,
): void {
    getDb()
        .prepare(
            `UPDATE files SET path = ?, filename = ?, mtime = ?, folder_id = ? WHERE content_hash = ?`,
        )
        .run(newRelativePath, newFilename, mtime, folderId, hash);
    const moved = getFileByHashAny(hash);
    if (moved) dropTagsCoveredByInheritance({ fileId: moved.id });
}

export function getActiveFilesByFilter(
    tree: FilterNode | null,
    folderPath?: string,
): DbFile[] {
    const filter = filterSql(tree);
    if (!filter) return [];
    const folderClause = folderPath ? `AND f.path LIKE ? ESCAPE '\\'` : "";
    const folderParams = folderPath ? [folderLikePattern(folderPath)] : [];
    return getDb()
        .prepare(
            `SELECT f.* FROM files f
             WHERE f.status = 'active' AND ${filter.sql} ${folderClause}
             ORDER BY f.elo_score DESC`,
        )
        .all(...filter.params, ...folderParams) as DbFile[];
}

// ── File status + cleanup ────────────────────────────────────────────────────

export function setFileStatus(
    hash: string,
    status: "active" | "missing",
): void {
    getDb()
        .prepare(
            `UPDATE files
             SET status = ?,
                 missing_since = CASE WHEN ? = 'missing' THEN datetime('now') ELSE NULL END
             WHERE content_hash = ?`,
        )
        .run(status, status, hash);
}

export function markFileMissing(relativePath: string): void {
    getDb()
        .prepare(
            `UPDATE files
             SET status = 'missing', missing_since = datetime('now')
             WHERE path = ? AND status = 'active'`,
        )
        .run(relativePath);
}

export function markFileMissingById(fileId: number): void {
    getDb()
        .prepare(
            `UPDATE files
             SET status = 'missing', missing_since = datetime('now')
             WHERE id = ? AND status = 'active'`,
        )
        .run(fileId);
}

export function getMissingFiles(): DbFile[] {
    return getDb()
        .prepare(`SELECT * FROM files WHERE status = 'missing'`)
        .all() as DbFile[];
}

/**
 * Every ranked file's place in the whole library, best = 1. Files never
 * compared are left out (they all sit at the starting score, so a place
 * would mean nothing) and don't push anyone down. Ties share a place.
 */
export function getLibraryRanks(): { ranks: [number, number][]; total: number } {
    const rows = getDb()
        .prepare(
            `SELECT id, RANK() OVER (ORDER BY elo_score DESC) AS place
             FROM files
             WHERE status = 'active' AND comparison_count > 0`,
        )
        .all() as { id: number; place: number }[];
    return { ranks: rows.map((r) => [r.id, r.place]), total: rows.length };
}

export function countMissingFiles(): number {
    return (
        getDb()
            .prepare(`SELECT COUNT(*) AS n FROM files WHERE status = 'missing'`)
            .get() as { n: number }
    ).n;
}

/**
 * Forgets files that are no longer in the library. Their tags and every
 * comparison they were in go with them (ON DELETE CASCADE); the scores and
 * counts of files still in the library are stored on those files and stay.
 * A file put back afterwards is indexed as new.
 */
export function deleteMissingFiles(): number {
    return getDb()
        .prepare(`DELETE FROM files WHERE status = 'missing'`)
        .run().changes;
}

export function reconcileMissingFiles(rootPath: string): void {
    const active = getDb()
        .prepare(`SELECT * FROM files WHERE status = 'active'`)
        .all() as DbFile[];

    for (const file of active) {
        const absPath = join(rootPath, file.path);
        try {
            statSync(absPath);
        } catch {
            markFileMissing(file.path);
        }
    }
}

// ── Elo queries ──────────────────────────────────────────────────────────────

export function updateEloScores(
    winnerId: number,
    loserId: number,
    newWinnerScore: number,
    newLoserScore: number,
    domainPath: string,
): number {
    const db = getDb();
    const scoreOf = db.prepare(`SELECT elo_score FROM files WHERE id = ?`);
    const updateScore = db.prepare(
        `UPDATE files SET elo_score = ?, comparison_count = comparison_count + 1 WHERE id = ?`,
    );
    const insertComparison = db.prepare(
        `INSERT INTO comparisons (winner_id, loser_id, domain_path, winner_score_before, loser_score_before)
         VALUES (?, ?, ?, ?, ?)`,
    );
    return db.transaction(() => {
        const winnerBefore = (scoreOf.get(winnerId) as { elo_score: number })
            .elo_score;
        const loserBefore = (scoreOf.get(loserId) as { elo_score: number })
            .elo_score;
        updateScore.run(newWinnerScore, winnerId);
        updateScore.run(newLoserScore, loserId);
        const info = insertComparison.run(
            winnerId,
            loserId,
            domainPath,
            winnerBefore,
            loserBefore,
        );
        return Number(info.lastInsertRowid);
    })();
}

// Reverts a comparison: puts both files back to their scores from before it
// and removes the record. Returns false if it can't be undone (unknown id, or
// an old row recorded before pre-comparison scores were stored).
export function undoComparison(comparisonId: number): boolean {
    const db = getDb();
    const row = db
        .prepare(`SELECT * FROM comparisons WHERE id = ?`)
        .get(comparisonId) as DbComparison | undefined;
    if (
        !row ||
        row.winner_score_before == null ||
        row.loser_score_before == null
    ) {
        return false;
    }
    const restore = db.prepare(
        `UPDATE files SET elo_score = ?, comparison_count = MAX(comparison_count - 1, 0) WHERE id = ?`,
    );
    db.transaction(() => {
        restore.run(row.winner_score_before, row.winner_id);
        restore.run(row.loser_score_before, row.loser_id);
        db.prepare(`DELETE FROM comparisons WHERE id = ?`).run(comparisonId);
    })();
    return true;
}

export function getRankedFiles(folderRelPath?: string): DbFile[] {
    if (folderRelPath) {
        return getDb()
            .prepare(
                `SELECT * FROM files WHERE path LIKE ? ESCAPE '\\' AND status = 'active' ORDER BY elo_score DESC`,
            )
            .all(folderLikePattern(folderRelPath)) as DbFile[];
    }
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE status = 'active' ORDER BY elo_score DESC`,
        )
        .all() as DbFile[];
}
