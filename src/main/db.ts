import Database from "better-sqlite3";
import { basename, join } from "path";
import { statSync } from "fs";
import { tagFilterSql } from "./tagFilter";

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
}

export interface DbTagCategory {
    id: number;
    name: string;
    color: string;
    icon: string;
    order_index: number;
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

        CREATE TABLE IF NOT EXISTS comparisons (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            winner_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            loser_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            domain_path TEXT    NOT NULL,
            timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_files_hash        ON files(content_hash);
        CREATE INDEX IF NOT EXISTS idx_files_path        ON files(path);
        CREATE INDEX IF NOT EXISTS idx_files_folder      ON files(folder_id);
        CREATE INDEX IF NOT EXISTS idx_file_tags_file    ON file_tags(file_id);
        CREATE INDEX IF NOT EXISTS idx_file_tags_tag     ON file_tags(tag_id);
        CREATE INDEX IF NOT EXISTS idx_folder_tags_folder ON folder_tags(folder_id);
        CREATE INDEX IF NOT EXISTS idx_folder_tags_tag   ON folder_tags(tag_id);
        CREATE INDEX IF NOT EXISTS idx_tags_category     ON tags(category_id);
    `);

    // ── Migrations (safe to run on every startup) ──────────────────────────

    runMigrations(db);
    createViews(db);

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
        dropDirectTagsCoveredByFolder();
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

// A file's tags are its own (file_tags) plus its folder's (folder_tags,
// through files.folder_id), combined at query time. A tag never comes from
// both: when a folder has a tag, files in it don't keep their own copy.
// `inherited` is 1 for tags that come from the folder.
function createViews(db: Database.Database): void {
    db.exec(`
        DROP VIEW IF EXISTS file_effective_tags;
        CREATE VIEW file_effective_tags AS
            SELECT file_id, tag_id, 0 AS inherited FROM file_tags
            UNION ALL
            SELECT f.id, ft.tag_id, 1 FROM files f
            JOIN folder_tags ft ON ft.folder_id = f.folder_id;
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

// Deletes a file's own copy of any tag its folder already gives it. Pass a
// file id to only check that file.
export function dropDirectTagsCoveredByFolder(fileId?: number): void {
    getDb()
        .prepare(
            `DELETE FROM file_tags
             WHERE EXISTS (
                 SELECT 1 FROM files f
                 JOIN folder_tags ft ON ft.folder_id = f.folder_id
                 WHERE f.id = file_tags.file_id AND ft.tag_id = file_tags.tag_id
             )
             ${fileId != null ? "AND file_tags.file_id = ?" : ""}`,
        )
        .run(...(fileId != null ? [fileId] : []));
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

export function getTagsForFolder(folderId: number): DbTag[] {
    return getDb()
        .prepare(
            `SELECT t.* FROM tags t
             JOIN folder_tags ft ON ft.tag_id = t.id
             WHERE ft.folder_id = ?`,
        )
        .all(folderId) as DbTag[];
}

// Files in the folder now inherit the tag, so their own copies go.
export function addTagToFolder(folderId: number, tagId: number): void {
    const db = getDb();
    db.transaction(() => {
        db.prepare(
            `INSERT OR IGNORE INTO folder_tags (folder_id, tag_id) VALUES (?, ?)`,
        ).run(folderId, tagId);
        db.prepare(
            `DELETE FROM file_tags
             WHERE tag_id = ? AND file_id IN (SELECT id FROM files WHERE folder_id = ?)`,
        ).run(tagId, folderId);
    })();
}

export function removeTagFromFolder(folderId: number, tagId: number): void {
    getDb()
        .prepare(`DELETE FROM folder_tags WHERE folder_id = ? AND tag_id = ?`)
        .run(folderId, tagId);
}

export function getTagsForFolderByPath(folderPath: string): DbTag[] {
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

export function getMostUsedTags(folderId?: number): DbTag[] {
    const query =
        folderId != null
            ? `
            SELECT t.id, t.name, t.category_id, COUNT(DISTINCT f.id) as usage_count
            FROM tags t
            JOIN file_effective_tags ft ON ft.tag_id = t.id
            JOIN files f ON f.id = ft.file_id
            WHERE f.status = 'active'
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
    dropDirectTagsCoveredByFolder(fileId);
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

export function upsertTag(name: string, categoryId?: number | null): DbTag {
    const db = getDb();
    name = normalizeTagName(name);

    if (categoryId === undefined) {
        db.prepare(
            `
            INSERT INTO tags (name)
            VALUES (?)
            ON CONFLICT(name) DO NOTHING
        `,
        ).run(name);
    } else {
        db.prepare(
            `
            INSERT INTO tags (name, category_id)
            VALUES (?, ?)
            ON CONFLICT(name) DO UPDATE SET
                category_id = excluded.category_id
        `,
        ).run(name, categoryId);
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

    const tag = db
        .prepare(
            `UPDATE tags SET name = ?, category_id = ? WHERE id = ? RETURNING *`,
        )
        .get(name, categoryId, id) as DbTag;
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

// Every file and folder tagged `sourceId` gets `targetId` instead, and the
// source tag is deleted. The target keeps its name and category.
export function mergeTags(sourceId: number, targetId: number): void {
    if (sourceId === targetId) return;
    const db = getDb();
    db.transaction(() => {
        db.prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT file_id, ? FROM file_tags WHERE tag_id = ?`,
        ).run(targetId, sourceId);
        db.prepare(
            `INSERT OR IGNORE INTO folder_tags (folder_id, tag_id)
             SELECT folder_id, ? FROM folder_tags WHERE tag_id = ?`,
        ).run(targetId, sourceId);
        db.prepare(`DELETE FROM tags WHERE id = ?`).run(sourceId); // cascades
        // A file may now have the target both directly and from its folder.
        dropDirectTagsCoveredByFolder();
    })();
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

export function setTagCategory(tagId: number, categoryId: number | null): void {
    getDb()
        .prepare(`UPDATE tags SET category_id = ? WHERE id = ?`)
        .run(categoryId, tagId);
}

export function deleteTag(tagId: number): void {
    getDb().prepare(`DELETE FROM tags WHERE id = ?`).run(tagId);
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
        order_index?: number; // Add this
    },
): DbTagCategory {
    const db = getDb();

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

// A file's tags, own and inherited. `inherited`: it comes from the file's
// folder (shown dimmed; removed from the folder, not the file).
export function getTagsForFile(
    fileId: number,
): (DbTag & { inherited: boolean })[] {
    const rows = getDb()
        .prepare(
            `SELECT t.*, MAX(ft.inherited) AS inherited FROM tags t
             JOIN file_effective_tags ft ON ft.tag_id = t.id
             WHERE ft.file_id = ?
             GROUP BY t.id`,
        )
        .all(fileId) as (DbTag & { inherited: number })[];
    return rows.map((r) => ({ ...r, inherited: r.inherited === 1 }));
}

// No-op when the file's folder already gives it the tag.
export function addTagToFile(fileId: number, tagId: number): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT ?, ?
             WHERE NOT EXISTS (
                 SELECT 1 FROM files f
                 JOIN folder_tags ft ON ft.folder_id = f.folder_id
                 WHERE f.id = ? AND ft.tag_id = ?
             )`,
        )
        .run(fileId, tagId, fileId, tagId);
}

export function removeTagFromFile(fileId: number, tagId: number): void {
    getDb()
        .prepare(`DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?`)
        .run(fileId, tagId);
}

// Ids of files passing a tag filter (see tagFilter.ts), any status.
export function getFileIdsByTags(
    tagIds: number[],
    mode: "and" | "or",
): number[] {
    const filter = tagFilterSql(tagIds, mode);
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
        dropDirectTagsCoveredByFolder(existing.id);

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
    if (moved) dropDirectTagsCoveredByFolder(moved.id);
}

export function getActiveFilesByTags(
    tagIds: number[],
    mode: "and" | "or",
    folderPath?: string,
): DbFile[] {
    const filter = tagFilterSql(tagIds, mode);
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
