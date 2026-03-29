import { createHash } from 'crypto'
import { createReadStream, readdirSync, statSync, existsSync, mkdirSync } from 'fs'
import { join, relative, extname, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { upsertFile, getFileByHash } from './db'

const execFileAsync = promisify(execFile)

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp'])
const GIF_EXTS = new Set(['.gif'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v'])

export type MediaType = 'photo' | 'gif' | 'video'

export interface ScannedFile {
  absolutePath: string
  relativePath: string
  filename: string
  mediaType: MediaType
}

export interface ScanResult {
  scanned: number
  added: number
  updated: number
  unsupported: number
}

function getMediaType(ext: string): MediaType | null {
  const e = ext.toLowerCase()
  if (PHOTO_EXTS.has(e)) return 'photo'
  if (GIF_EXTS.has(e)) return 'gif'
  if (VIDEO_EXTS.has(e)) return 'video'
  return null
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function ensureThumbnailDir(rootPath: string): string {
  const dir = join(rootPath, '_thumbnails')
  if (!existsSync(dir)) mkdirSync(dir)
  return dir
}

async function generateThumbnail(
  filePath: string,
  thumbPath: string,
  mediaType: MediaType
): Promise<void> {
  if (existsSync(thumbPath)) return // already generated

  if (mediaType === 'video') {
    // Extract frame at 1 second, scale to 400px wide
    await execFileAsync('ffmpeg', [
      '-ss', '00:00:01',
      '-i', filePath,
      '-vframes', '1',
      '-vf', 'scale=400:-2',
      '-q:v', '4',
      '-y',
      thumbPath
    ])
  } else {
    // Use ffmpeg for photos and gifs too — resize to 400px wide
    await execFileAsync('ffmpeg', [
      '-i', filePath,
      '-vf', 'scale=400:-2',
      '-vframes', '1',
      '-q:v', '4',
      '-y',
      thumbPath
    ])
  }
}

function walkDir(dirPath: string, rootPath: string): ScannedFile[] {
  const results: ScannedFile[] = []

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return results
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue

    const absPath = join(dirPath, entry)
    let stat
    try {
      stat = statSync(absPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      results.push(...walkDir(absPath, rootPath))
    } else if (stat.isFile()) {
      const ext = extname(entry)
      const mediaType = getMediaType(ext)
      if (!mediaType) continue

      results.push({
        absolutePath: absPath,
        relativePath: relative(rootPath, absPath),
        filename: basename(entry),
        mediaType
      })
    }
  }

  return results
}

export async function scanFolder(rootPath: string): Promise<ScanResult> {
  const files = walkDir(rootPath, rootPath)
  const thumbDir = ensureThumbnailDir(rootPath)

  let added = 0
  let updated = 0
  let unsupported = 0

  for (const file of files) {
    try {
      const hash = await hashFile(file.absolutePath)
      const before = getFileByHash(hash)
      const thumbPath = join(thumbDir, `${hash}.jpg`)

      // Generate thumbnail (skips if already exists)
      try {
        await generateThumbnail(file.absolutePath, thumbPath, file.mediaType)
      } catch (thumbErr) {
        console.warn(`Thumbnail failed for ${file.filename}:`, thumbErr)
      }

      upsertFile({
        content_hash: hash,
        path: file.relativePath,
        filename: file.filename,
        media_type: file.mediaType
      })

      if (!before) added++
      else if (before.path !== file.relativePath) updated++
    } catch (err) {
      console.error(`Failed to process ${file.absolutePath}:`, err)
      unsupported++
    }
  }

  return { scanned: files.length, added, updated, unsupported }
}

export function getSubfolders(rootPath: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(rootPath)
  } catch {
    return []
  }

  return entries.filter((entry) => {
    if (entry.startsWith('.') || entry.startsWith('_')) return false
    try {
      return statSync(join(rootPath, entry)).isDirectory()
    } catch {
      return false
    }
  })
}

export function getThumbnailPath(rootPath: string, hash: string): string {
  return join(rootPath, '_thumbnails', `${hash}.jpg`)
}