// Each path segment is escaped, so names with "#", "?" or "%" survive the
// trip (the media:// handler decodes them).
function encodePath(absPath: string): string {
  return absPath.split("/").map(encodeURIComponent).join("/")
}

/**
 * `version` (the file's content hash) changes when a file is edited in place,
 * e.g. baked or replaced, so the browser fetches the new content instead of a cached copy.
 */
export function toMediaUrl(rootPath: string, relativePath: string, version?: string): string {
  const url = `media://local${encodePath(`${rootPath}/${relativePath}`)}`
  return version ? `${url}?v=${version}` : url
}

export function toThumbnailUrl(absPath: string): string {
  return `media://local${encodePath(absPath)}`
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * The Settings volume (0–100) as an element volume (0–1). Cubed, so the
 * slider follows how loudness is heard (about a 60 dB range) rather than
 * the raw signal level: half way sounds about half as loud, instead of
 * barely quieter. Like most players' volume controls.
 */
export function volumeLevel(volume: number): number {
  const x = Math.max(0, Math.min(1, volume / 100))
  return x * x * x
}

/**
 * Q / E (and ← / →) on a video: playing, skip 3 seconds (past the end: back
 * to the start); paused, step one frame.
 */
export function stepVideo(video: HTMLVideoElement, direction: -1 | 1): void {
  if (video.paused) {
    const frameDuration = 1 / 30
    const newTime = video.currentTime + direction * frameDuration
    video.currentTime = Math.min(Math.max(newTime, 0), video.duration)
  } else {
    const newTime = video.currentTime + direction * 3
    if (newTime < 0 || newTime > video.duration + 2.6) {
      video.currentTime = 0
    } else if (newTime > video.duration) {
      video.currentTime = video.duration - 0.3
    } else {
      video.currentTime = newTime
    }
  }
}
