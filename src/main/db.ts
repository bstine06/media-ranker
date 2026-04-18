import Database from "better-sqlite3";
import { basename, join } from "path";
import { statSync } from "fs";

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
    backfillFolderIds();

    return db;
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
        db.exec(`CREATE INDEX idx_files_folder_status ON files(folder_id, status)`);
    }
    if (!existingIndexes.has("idx_files_status")) {
        db.exec(`CREATE INDEX idx_files_status ON files(status)`);
    }

    // Migration 5: add color and icon columns to tag_categories if missing
    const tagCategoryCols = new Set(
        (
            db.prepare(`PRAGMA table_info(tag_categories)`).all() as { name: string }[]
        ).map((c) => c.name),
    );

    if (!tagCategoryCols.has("color")) {
        db.exec(`ALTER TABLE tag_categories ADD COLUMN color TEXT`);
    }
    if (!tagCategoryCols.has("icon")) {
        db.exec(`ALTER TABLE tag_categories ADD COLUMN icon TEXT`);
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
    getDb()
        .prepare(`UPDATE folders SET path = ?, name = ? WHERE path = ?`)
        .run(newPath, basename(newPath), oldPath);
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

export function addTagToFolder(folderId: number, tagId: number): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO folder_tags (folder_id, tag_id) VALUES (?, ?)`,
        )
        .run(folderId, tagId);
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
    const query = folderId != null
        ? `
            SELECT t.id, t.name, t.category_id, COUNT(*) as usage_count
            FROM tags t
            JOIN file_tags ft ON ft.tag_id = t.id
            JOIN files f ON f.id = ft.file_id
            WHERE f.status = 'active'
              AND f.folder_id = ?
            GROUP BY t.id
            ORDER BY usage_count DESC
          `
        : `
            SELECT t.id, t.name, t.category_id, COUNT(*) as usage_count
            FROM tags t
            JOIN file_tags ft ON ft.tag_id = t.id
            JOIN files f ON f.id = ft.file_id
            WHERE f.status = 'active'
            GROUP BY t.id
            ORDER BY usage_count DESC
          `;

    return getDb()
        .prepare(query)
        .all(folderId != null ? [folderId] : []) as DbTag[];
}

// Stamp folder tags onto all files currently in the folder.
// Called when a tag is added to a folder after files are already there.
export function applyFolderTagsToExistingFiles(folderId: number): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT f.id, ft.tag_id
             FROM files f
             JOIN folder_tags ft ON ft.folder_id = ?
             WHERE f.folder_id = ?`,
        )
        .run(folderId, folderId);
}

// Stamp a single folder's tags onto a single incoming file.
// Called at move/index time.
export function applyFolderTagsToFile(fileId: number, folderId: number): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT ?, tag_id FROM folder_tags WHERE folder_id = ?`,
        )
        .run(fileId, folderId);
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
export function getFolderMetadataByPath(folderPath: string): { key: string; value: string; type: string }[] {
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

export function deleteFolderMetadataField(folderPath: string, key: string): void {
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

export function setFolderProfileImageByPath(folderPath: string, hash: string | null): void {
    const folder = getFolderByPath(folderPath);
    if (!folder) return;
    setFolderProfileImage(folder.id, hash);
}

// ── Tag queries ──────────────────────────────────────────────────────────────

export function upsertTag(name: string, categoryId: number | null = null): DbTag {
    const db = getDb();

    db.prepare(`
        INSERT INTO tags (name, category_id)
        VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET
            category_id = excluded.category_id
    `).run(name, categoryId);

    return db
        .prepare(`SELECT * FROM tags WHERE name = ?`)
        .get(name) as DbTag;
}

export function updateTag(id: number, name: string, categoryId: number | null): DbTag {
    const db = getDb();

    return db.prepare(`
        UPDATE tags
        SET name = ?, category_id = ?
        WHERE id = ?
        RETURNING *
    `).get(name, categoryId, id) as DbTag;
}

export function getTagByName(name: string): DbTag | undefined {
    return getDb().prepare(`SELECT * FROM tags WHERE name = ?`).get(name) as
        | DbTag
        | undefined;
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
    icon: string
): DbTagCategory {
    const db = getDb();

    db.prepare(`
        INSERT INTO tag_categories (name, color, icon)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            color = excluded.color,
            icon = excluded.icon
    `).run(name, color, icon);

    return db
        .prepare(`SELECT * FROM tag_categories WHERE name = ?`)
        .get(name) as DbTagCategory;
}

export function getAllTagCategories(): DbTagCategory[] {
    return getDb()
        .prepare(`SELECT * FROM tag_categories ORDER BY name`)
        .all() as DbTagCategory[];
}

export function deleteTagCategory(categoryId: number): void {
    // Tags in this category become uncategorized via ON DELETE NULL
    getDb().prepare(`DELETE FROM tag_categories WHERE id = ?`).run(categoryId);
}

export function updateTagCategory(id: number, updates: { name?: string; color?: string | null; icon?: string | null }): DbTagCategory {
    const db = getDb();

    const fields = Object.entries(updates)
        .filter(([_, v]) => v !== undefined)
        .map(([k]) => `${k} = ?`);
    const values = Object.entries(updates)
        .filter(([_, v]) => v !== undefined)
        .map(([_, v]) => v);

    if (fields.length === 0) return db.prepare(`SELECT * FROM tag_categories WHERE id = ?`).get(id) as DbTagCategory;

    return db.prepare(`
        UPDATE tag_categories
        SET ${fields.join(", ")}
        WHERE id = ?
        RETURNING *
    `).get([...values, id]) as DbTagCategory;
}

// ipcMain.handle("update-tag-category", (
//         _event,
//         id: number,
//         updates: {
//             name?: string,
//             color?: string | null,
//             icon?: string | null
//         }
//     ) => {
//         updateTagCategory(id, updates);
//     })

// ── File tag queries ─────────────────────────────────────────────────────────

export function getTagsForFile(fileId: number): DbTag[] {
    return getDb()
        .prepare(
            `SELECT t.* FROM tags t
             JOIN file_tags ft ON ft.tag_id = t.id
             WHERE ft.file_id = ?`,
        )
        .all(fileId) as DbTag[];
}

export function addTagToFile(fileId: number, tagId: number): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)`,
        )
        .run(fileId, tagId);
}

export function removeTagFromFile(fileId: number, tagId: number): void {
    getDb()
        .prepare(`DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?`)
        .run(fileId, tagId);
}

export function getFileIdsByTags(
    tagIds: number[],
    mode: "and" | "or",
): number[] {
    const db = getDb();
    if (tagIds.length === 0) return [];
    const placeholders = tagIds.map(() => "?").join(", ");

    if (mode === "or") {
        const rows = db
            .prepare(
                `SELECT DISTINCT file_id FROM file_tags WHERE tag_id IN (${placeholders})`,
            )
            .all(...tagIds) as { file_id: number }[];
        return rows.map((r) => r.file_id);
    } else {
        const rows = db
            .prepare(
                `SELECT file_id FROM file_tags WHERE tag_id IN (${placeholders})
                 GROUP BY file_id HAVING COUNT(DISTINCT tag_id) = ?`,
            )
            .all(...tagIds, tagIds.length) as { file_id: number }[];
        return rows.map((r) => r.file_id);
    }
}

export function backfillFolderIds(): void {
    const db = getDb();
    const folders = db
        .prepare(`SELECT * FROM folders`)
        .all() as DbFolder[];

    const updateFile = db.prepare(
        `UPDATE files SET folder_id = ? WHERE path LIKE ? AND folder_id IS NULL`
    );

    db.transaction(() => {
        for (const folder of folders) {
            const escaped = folder.path.replace(/%/g, "\\%").replace(/_/g, "\\_");
            updateFile.run(folder.id, `${escaped}/%`);
        }
    })();
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

         // Apply folder tags in case file moved to a new folder
        if (file.folder_id != null) {
            applyFolderTagsToFile(existing.id, file.folder_id);
        }

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

    // Apply folder tags to newly indexed files
    if (inserted.folder_id != null) {
        applyFolderTagsToFile(inserted.id, inserted.folder_id);
    }

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

export function getAllActiveFiles(): DbFile[] {
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE status = 'active' ORDER BY elo_score DESC`,
        )
        .all() as DbFile[];
}

export function getFilesByFolder(folderRelPath: string): DbFile[] {
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE path LIKE ? AND status = 'active' ORDER BY elo_score DESC`,
        )
        .all(
            `${folderRelPath.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`,
        ) as DbFile[];
}

export function getFilesByPathPrefix(prefix: string): DbFile[] {
    const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
    return getDb()
        .prepare(
            `SELECT * FROM files
             WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND status = 'active'`,
        )
        .all(prefix, `${escaped}/%`) as DbFile[];
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
             WHERE path = ? OR path LIKE ?`,
        ).run(
            newPrefix,
            oldPrefix.length + 1,
            oldPrefix,
            `${oldPrefix.replace(/%/g, "\\%").replace(/_/g, "\\_")}/%`,
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
}

export function getActiveFilesByTags(
    tagIds: number[],
    mode: "and" | "or",
    folderPath?: string,
): DbFile[] {
    const db = getDb();
    if (tagIds.length === 0) return [];

    const placeholders = tagIds.map(() => "?").join(", ");
    const folderClause = folderPath
        ? `AND f.path LIKE '${folderPath.replace(/%/g, "\\%").replace(/_/g, "\\_")}%' ESCAPE '\\'`
        : "";

    if (mode === "or") {
        return db.prepare(
            `SELECT DISTINCT f.* FROM files f
             JOIN file_tags ft ON ft.file_id = f.id
             JOIN tags t ON t.id = ft.tag_id
             WHERE f.status = 'active'
             AND t.id IN (${placeholders})
             ${folderClause}
             ORDER BY f.elo_score DESC`
        ).all(...tagIds) as DbFile[];
    } else {
        return db.prepare(
            `SELECT f.* FROM files f
             JOIN file_tags ft ON ft.file_id = f.id
             JOIN tags t ON t.id = ft.tag_id
             WHERE f.status = 'active'
             AND t.id IN (${placeholders})
             ${folderClause}
             GROUP BY f.id HAVING COUNT(DISTINCT t.id) = ?
             ORDER BY f.elo_score DESC`
        ).all(...tagIds, tagIds.length) as DbFile[];
    }
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

export function getMissingFiles(): DbFile[] {
    return getDb()
        .prepare(`SELECT * FROM files WHERE status = 'missing'`)
        .all() as DbFile[];
}

export function pruneOldMissingFiles(olderThanDays = 30): void {
    getDb()
        .prepare(
            `DELETE FROM files
             WHERE status = 'missing'
               AND missing_since < datetime('now', '-' || ? || ' days')`,
        )
        .run(olderThanDays);
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
): void {
    const db = getDb();
    const updateScore = db.prepare(
        `UPDATE files SET elo_score = ?, comparison_count = comparison_count + 1 WHERE id = ?`,
    );
    const insertComparison = db.prepare(
        `INSERT INTO comparisons (winner_id, loser_id, domain_path) VALUES (?, ?, ?)`,
    );
    db.transaction(() => {
        updateScore.run(newWinnerScore, winnerId);
        updateScore.run(newLoserScore, loserId);
        insertComparison.run(winnerId, loserId, domainPath);
    })();
}

export function getRankedFiles(folderRelPath?: string): DbFile[] {
    if (folderRelPath) {
        return getDb()
            .prepare(
                `SELECT * FROM files WHERE path LIKE ? AND status = 'active' ORDER BY elo_score DESC`,
            )
            .all(`${folderRelPath}%`) as DbFile[];
    }
    return getDb()
        .prepare(
            `SELECT * FROM files WHERE status = 'active' ORDER BY elo_score DESC`,
        )
        .all() as DbFile[];
}
