import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

export interface DbFile {
  id: number
  content_hash: string
  path: string
  filename: string
  media_type: 'photo' | 'gif' | 'video'
  elo_score: number
  comparison_count: number
  date_indexed: string
  mtime: number
  size: number
}

export interface DbTag {
  file_id: number
  tag: string
}

export interface DbComparison {
  id: number
  winner_id: number
  loser_id: number
  domain_path: string
  timestamp: string
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.')
  return db
}

export function initDb(rootPath: string): Database.Database {
  const dbPath = join(rootPath, '_media_index.db')

  if (db && (db as any).name === dbPath) return db

  if (db) {
    db.close()
    db = null
  }
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash    TEXT    NOT NULL UNIQUE,
      path            TEXT    NOT NULL,
      filename        TEXT    NOT NULL,
      media_type      TEXT    NOT NULL CHECK(media_type IN ('photo', 'gif', 'video')),
      elo_score       REAL    NOT NULL DEFAULT 1000,
      comparison_count INTEGER NOT NULL DEFAULT 0,
      date_indexed    TEXT    NOT NULL DEFAULT (datetime('now')),
      mtime           INTEGER NOT NULL DEFAULT 0,
      size            INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tags (
      file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      tag      TEXT    NOT NULL,
      PRIMARY KEY (file_id, tag)
    );

    CREATE TABLE IF NOT EXISTS comparisons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      winner_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      loser_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      domain_path TEXT    NOT NULL,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_tags_file  ON tags(file_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag   ON tags(tag);
  `)

  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// ── File queries ────────────────────────────────────────────────────────────

export function upsertFile(file: Omit<DbFile, 'id' | 'elo_score' | 'comparison_count' | 'date_indexed'>): DbFile {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM files WHERE content_hash = ?').get(file.content_hash) as DbFile | undefined

  if (existing) {
    if (
      existing.path !== file.path ||
      existing.filename !== file.filename ||
      existing.mtime !== file.mtime ||
      existing.size !== file.size
    ) {
      db.prepare('UPDATE files SET path = ?, filename = ?, mtime = ?, size = ? WHERE content_hash = ?')
        .run(file.path, file.filename, file.mtime, file.size, file.content_hash)
    }
    return { ...existing, path: file.path, filename: file.filename, mtime: file.mtime, size: file.size }
  }

  const result = db.prepare(`
    INSERT INTO files (content_hash, path, filename, media_type, mtime, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(file.content_hash, file.path, file.filename, file.media_type, file.mtime, file.size)

  return db.prepare('SELECT * FROM files WHERE id = ?').get(result.lastInsertRowid) as DbFile
}

export function getFileByPath(relativePath: string): DbFile | undefined {
  return getDb().prepare('SELECT * FROM files WHERE path = ?').get(relativePath) as DbFile | undefined
}

export function getFileByHash(hash: string): DbFile | undefined {
  return getDb().prepare('SELECT * FROM files WHERE content_hash = ?').get(hash) as DbFile | undefined
}

// Used by the watcher to update path/filename after a rename, without
// touching elo_score, tags, comparisons, or any other fields.
export function updateFilePath(
  hash: string,
  newRelativePath: string,
  newFilename: string,
  mtime: number
): void {
  getDb()
    .prepare('UPDATE files SET path = ?, filename = ?, mtime = ? WHERE content_hash = ?')
    .run(newRelativePath, newFilename, mtime, hash)
}

export function getAllFiles(): DbFile[] {
  return getDb().prepare('SELECT * FROM files ORDER BY elo_score DESC').all() as DbFile[]
}

export function getFilesByFolder(folderRelPath: string): DbFile[] {
  return getDb()
    .prepare("SELECT * FROM files WHERE path LIKE ? ORDER BY elo_score DESC")
    .all(`${folderRelPath.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`) as DbFile[]
}
export function getFilesByPathPrefix(prefix: string): DbFile[] {
  const escaped = prefix.replace(/%/g, '\\%').replace(/_/g, '\\_')
  return getDb()
    .prepare(`SELECT * FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'`)
    .all(prefix, `${escaped}/%`) as DbFile[]
}

export function getUnindexedCount(): number {
  const result = getDb()
    .prepare('SELECT COUNT(*) as count FROM files WHERE comparison_count = 0')
    .get() as { count: number }
  return result.count
}

export function renameFolderPaths(oldPrefix: string, newPrefix: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(`
      UPDATE files
      SET path = ? || substr(path, ?)
      WHERE path = ? OR path LIKE ?
    `).run(
      newPrefix,
      oldPrefix.length + 1,
      oldPrefix,
      `${oldPrefix.replace(/%/g, '\\%').replace(/_/g, '\\_')}/%`
    )
  })()
}

export function deleteFileByPath(relativePath: string): void {
  getDb().prepare('DELETE FROM files WHERE path = ?').run(relativePath)
}

// ── Tag queries ─────────────────────────────────────────────────────────────

export function getTagsForFile(fileId: number): string[] {
  const rows = getDb()
    .prepare('SELECT tag FROM tags WHERE file_id = ?')
    .all(fileId) as { tag: string }[]
  return rows.map((r) => r.tag)
}

export function addTag(fileId: number, tag: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO tags (file_id, tag) VALUES (?, ?)')
    .run(fileId, tag)
}

export function removeTag(fileId: number, tag: string): void {
  getDb()
    .prepare('DELETE FROM tags WHERE file_id = ? AND tag = ?')
    .run(fileId, tag)
}

export function getAllTags(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT tag FROM tags ORDER BY tag')
    .all() as { tag: string }[]
  return rows.map((r) => r.tag)
}

export function getFileIdsByTags(tags: string[], mode: "and" | "or"): number[] {
  const db = getDb()
  if (tags.length === 0) return []

  const placeholders = tags.map(() => "?").join(", ")

  if (mode === "or") {
    const rows = db.prepare(
      `SELECT DISTINCT file_id FROM tags WHERE tag IN (${placeholders})`
    ).all(...tags) as { file_id: number }[]
    return rows.map(r => r.file_id)
  } else {
    const rows = db.prepare(
      `SELECT file_id FROM tags WHERE tag IN (${placeholders})
       GROUP BY file_id HAVING COUNT(DISTINCT tag) = ?`
    ).all(...tags, tags.length) as { file_id: number }[]
    return rows.map(r => r.file_id)
  }
}

export function addTagToFolder(folderRelPath: string, tag: string): number {
  const db = getDb()
  const pattern = `${folderRelPath.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
  const result = db.prepare(`
    INSERT OR IGNORE INTO tags (file_id, tag)
    SELECT id, ? FROM files WHERE path LIKE ?
  `).run(tag, pattern)
  return result.changes
}

// ── Elo queries ─────────────────────────────────────────────────────────────

export function updateEloScores(
  winnerId: number,
  loserId: number,
  newWinnerScore: number,
  newLoserScore: number,
  domainPath: string
): void {
  const db = getDb()

  const updateScore = db.prepare(`
    UPDATE files
    SET elo_score = ?, comparison_count = comparison_count + 1
    WHERE id = ?
  `)

  const insertComparison = db.prepare(`
    INSERT INTO comparisons (winner_id, loser_id, domain_path)
    VALUES (?, ?, ?)
  `)

  db.transaction(() => {
    updateScore.run(newWinnerScore, winnerId)
    updateScore.run(newLoserScore, loserId)
    insertComparison.run(winnerId, loserId, domainPath)
  })()
}

export function getRankedFiles(folderRelPath?: string): DbFile[] {
  if (folderRelPath) {
    return getDb()
      .prepare("SELECT * FROM files WHERE path LIKE ? ORDER BY elo_score DESC")
      .all(`${folderRelPath}%`) as DbFile[]
  }
  return getDb().prepare('SELECT * FROM files ORDER BY elo_score DESC').all() as DbFile[]
}