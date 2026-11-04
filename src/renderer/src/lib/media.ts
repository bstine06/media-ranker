// Each path segment is escaped, so names with "#", "?" or "%" survive the
// trip (the media:// handler decodes them).
function encodePath(absPath: string): string {
  return absPath.split("/").map(encodeURIComponent).join("/")
}

/**
 * `version` (the file's content hash) changes when a file is edited in place,
 * e.g. rotated, so the browser fetches the new content instead of a cached copy.
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