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
  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
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
      date_indexed    TEXT    NOT NULL DEFAULT (datetime('now'))
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
    // File moved or renamed — update path and filename
    if (existing.path !== file.path || existing.filename !== file.filename) {
      db.prepare('UPDATE files SET path = ?, filename = ? WHERE content_hash = ?')
        .run(file.path, file.filename, file.content_hash)
    }
    return { ...existing, path: file.path, filename: file.filename }
  }

  const result = db.prepare(`
    INSERT INTO files (content_hash, path, filename, media_type)
    VALUES (?, ?, ?, ?)
  `).run(file.content_hash, file.path, file.filename, file.media_type)

  return db.prepare('SELECT * FROM files WHERE id = ?').get(result.lastInsertRowid) as DbFile
}

export function getAllFiles(): DbFile[] {
  return getDb().prepare('SELECT * FROM files ORDER BY elo_score DESC').all() as DbFile[]
}

export function getFilesByFolder(folderRelPath: string): DbFile[] {
  // Match files whose path starts with the given folder prefix
  return getDb()
    .prepare("SELECT * FROM files WHERE path LIKE ? ORDER BY elo_score DESC")
    .all(`${folderRelPath}%`) as DbFile[]
}

export function getFileByHash(hash: string): DbFile | undefined {
  return getDb().prepare('SELECT * FROM files WHERE content_hash = ?').get(hash) as DbFile | undefined
}

export function getUnindexedCount(): number {
  // Files with 0 comparisons — useful for the "new files" badge
  const result = getDb()
    .prepare('SELECT COUNT(*) as count FROM files WHERE comparison_count = 0')
    .get() as { count: number }
  return result.count
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

  // Run both updates and the log insert in a single transaction
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