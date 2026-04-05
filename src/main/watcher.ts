// main/watcher.ts
import chokidar, { FSWatcher } from 'chokidar'
import { join, relative, extname, basename } from 'path'
import { statSync } from 'fs'
import { BrowserWindow } from 'electron'
import { upsertFile, getFileByPath, deleteFileByPath } from './db'
import { getThumbnailPath, generateSizedImage, getMediaType, ensureDir } from './scanner'
import { hashFile } from './scanner'

const DEBOUNCE_MS = 1500
const watchers = new Map<string, FSWatcher>()

async function waitUntilFileStable(filePath: string, intervalMs = 200, maxWaitMs = 300_000): Promise<void> {
    let lastSize = -1
    let waited = 0
    while (waited < maxWaitMs) {
        await new Promise(r => setTimeout(r, intervalMs))
        waited += intervalMs
        try {
            const { size } = statSync(filePath)
            if (size === lastSize && size > 0) return  // stable
            lastSize = size
        } catch {
            // file might not be visible yet, keep waiting
        }
    }
    throw new Error(`File never stabilized: ${filePath}`)
}

export function watchFolder(rootPath: string, win: BrowserWindow): void {
    console.log('watchFolder called with:', rootPath)
  if (watchers.has(rootPath)) {
    console.log('already watching, returning early')
    return
  }

  const thumbDir = join(rootPath, '_thumbnails')
  const previewDir = join(rootPath, '_previews')
  ensureDir(thumbDir)
  ensureDir(previewDir)

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const watcher = chokidar.watch(rootPath, {
    ignored: (filePath: string) => {
      const seg = filePath.replace(rootPath, '').split(/[\\/]/)
      return seg.some(s => s.startsWith('.') || s.startsWith('_'))
    },
    persistent: true,
    ignoreInitial: true,   // don't re-fire for files found on startup
  })

  watcher.on('add', async (filePath) => {
    const mediaType = getMediaType(extname(filePath))
    if (!mediaType) return

    const existing = debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    debounceTimers.set(filePath, setTimeout(async () => {
        debounceTimers.delete(filePath)
        try {
            await waitUntilFileStable(filePath)

            const stat = statSync(filePath)
            const relativePath = relative(rootPath, filePath)
            const hash = await hashFile(filePath)

            const thumbPath = join(thumbDir, `${hash}.jpg`)
            const previewPath = join(previewDir, `${hash}.jpg`)
            await generateSizedImage(filePath, thumbPath, 400, mediaType).catch(() => {})
            await generateSizedImage(filePath, previewPath, 1200, mediaType).catch(() => {})

            upsertFile({
                content_hash: hash,
                path: relativePath,
                filename: basename(filePath),
                media_type: mediaType,
                mtime: stat.mtimeMs,
                size: stat.size,
            })

            win.webContents.send('media:added', { relativePath, hash, mediaType })
        } catch (err) {
            console.error('Watcher failed to process:', filePath, err)
        }
    }, 500))
})

  watcher.on('unlink', (filePath) => {
    const relativePath = relative(rootPath, filePath)
    deleteFileByPath(relativePath)
    win.webContents.send('media:removed', { relativePath })
})

  watcher.on('error', (err) => console.error('Watcher error:', err))

  watchers.set(rootPath, watcher)
}

export async function unwatchFolder(rootPath: string): Promise<void> {
  const w = watchers.get(rootPath)
  if (w) {
    await w.close()
    watchers.delete(rootPath)
  }
}

export async function unwatchAll(): Promise<void> {
  for (const [path, w] of watchers) {
    await w.close()
    watchers.delete(path)
  }
}