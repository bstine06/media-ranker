// main/replaceFile.ts
import { rename, stat } from 'fs/promises'
import { join, basename } from 'path'
import { shell } from 'electron'
import { getDb, getFileByPath } from './db'
import { hashFile, generateSizedImage, getMediaType, ensureDir } from './scanner'

export async function replaceTrackedFile(
  rootPath: string,
  oldRelPath: string,
  newAbsPath: string,
  ignoredPaths: Set<string>,
): Promise<void> {
  const oldAbsPath = join(rootPath, oldRelPath)
  const filename = basename(oldAbsPath)
  const ext = '.' + filename.split('.').pop()!

  const existing = getFileByPath(oldRelPath)
  if (!existing) throw new Error(`File not tracked: ${oldRelPath}`)

  const mediaType = getMediaType(ext)
  if (!mediaType) throw new Error(`Unsupported media type: ${filename}`)

  const [newHash, newStat] = await Promise.all([
    hashFile(newAbsPath),
    stat(newAbsPath),
  ])

  ignoredPaths.add(oldAbsPath)
  try {
    await shell.trashItem(oldAbsPath)
    await rename(newAbsPath, oldAbsPath)
  } finally {
    ignoredPaths.delete(oldAbsPath)
  }

  const thumbDir = join(rootPath, '_thumbnails')
  ensureDir(thumbDir)

  await Promise.allSettled([
    generateSizedImage(oldAbsPath, join(thumbDir, `${newHash}.jpg`), 400, mediaType),
  ])

  getDb()
    .prepare(`UPDATE files SET content_hash = ?, mtime = ?, size = ? WHERE id = ?`)
    .run(newHash, newStat.mtimeMs, newStat.size, existing.id)
}